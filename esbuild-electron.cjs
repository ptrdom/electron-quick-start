
const http = require('http');
const esbuild = require('esbuild');
const jsdom = require("jsdom")
const { JSDOM } = jsdom;
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { spawn } = require('node:child_process');
const electron = require('electron')

const htmlTransform = (htmlString, outDirectory, meta) => {
  if (!meta.outputs) {
    throw new Error('Meta file missing output metadata');
  }

  const workingDirectory = __dirname;

  const toHtmlPath = (filePath) => filePath.split(path.sep).join(path.posix.sep);

  const dom = new JSDOM(htmlString);
  dom.window.document.querySelectorAll("script").forEach((el) => {
    let output;
    let outputBundle;
    Object.keys(meta.outputs).every((key) => {
      const maybeOutput = meta.outputs[key];
      if (el.src.endsWith(maybeOutput.entryPoint)) {
        output = maybeOutput;
        outputBundle = key;
        return false;
      }
      return true;
    })
    if (output) {
     let absolute = el.src.startsWith("/");
     el.src = toHtmlPath(el.src.replace(output.entryPoint, path.relative(outDirectory, path.join(workingDirectory, outputBundle))));
     if (output.cssBundle) {
       const link = dom.window.document.createElement("link");
       link.rel = "stylesheet";
       link.href = (absolute ? "/" : "") + toHtmlPath(path.relative(outDirectory, path.join(workingDirectory, output.cssBundle)));
       el.parentNode.insertBefore(link, el.nextSibling);
     }
    }
  });
  return dom.serialize();
}

const esbuildLiveReload = (htmlString) => {
  return htmlString
    .toString()
    .replace("</head>", `
      <script type="text/javascript">
        // Based on https://esbuild.github.io/api/#live-reload
        const eventSource = new EventSource('/esbuild');
        eventSource.addEventListener('change', e => {
          const { added, removed, updated } = JSON.parse(e.data)

          if (!added.length && !removed.length && updated.length === 1) {
            for (const link of document.getElementsByTagName('link')) {
              const url = new URL(link.href)

              if (url.host === location.host && url.pathname === updated[0]) {
                const next = link.cloneNode()
                next.href = updated[0] + '?' + Math.random().toString(36).slice(2)
                next.onload = () => link.remove()
                link.parentNode.insertBefore(next, link.nextSibling)
                return
              }
            }
          }

          location.reload()
        });
        eventSource.addEventListener('reload', () => {
          location.reload();
        });
      </script>
    </head>
    `);
}

const rendererServe = async (rendererEntryPoints, rendererHtmlEntryPoints, rendererBuildOutputDirectory, rendererBuildServerProxyPort, rendererBuildServerPort, rendererBuildMetafileName) => {
    const reloadEventEmitter = new EventEmitter();

    const plugins = [{
      name: 'metafile-plugin',
      setup(build) {
        build.onEnd(result => {
          if (!result.metafile) {
            console.warn("Metafile missing in build result")
            fs.writeFileSync(rendererBuildMetafileName, '{}');
          } else {
            fs.writeFileSync(rendererBuildMetafileName, JSON.stringify(result.metafile));
          }
        });
      },
    }];

    const ctx  = await esbuild.context({
      entryPoints: rendererEntryPoints,
      bundle: true,
      outdir: rendererBuildOutputDirectory,
      loader: { '.png': 'file','.jpe?g': 'file','.jfif': 'file','.pjpeg': 'file','.pjp': 'file','.gif': 'file','.svg': 'file','.ico': 'file','.webp': 'file','.avif': 'file','.mp4': 'file','.webm': 'file','.ogg': 'file','.mp3': 'file','.wav': 'file','.flac': 'file','.aac': 'file','.woff2?': 'file','.eot': 'file','.ttf': 'file','.otf': 'file','.webmanifest': 'file','.pdf': 'file','.txt': 'file' },
      metafile: true,
      logOverride: {
        'equals-negative-zero': 'silent',
      },
      logLevel: "info",
      entryNames: 'assets/[name]',
      assetNames: 'assets/[name]',
      publicPath: "/",
      plugins: plugins,
    });

    await ctx.watch()

    const { host, port } = await ctx.serve({
        servedir: rendererBuildOutputDirectory,
        port: rendererBuildServerPort
    });

    // Create a second (proxy) server that will forward requests to esbuild.
    const proxy = http.createServer((req, res) => {
        const metaPath = path.join(__dirname, rendererBuildMetafileName);
        let meta;
        try {
          meta = JSON.parse(fs.readFileSync(metaPath));
        } catch (error) {
          res.writeHead(500);
          res.end('META file ['+metaPath+'] not found');
        }

        if (meta) {
          const forwardRequest = (path) => {
              const options = {
                  hostname: host,
                  port,
                  path,
                  method: req.method,
                  headers: req.headers,
              };

          const multipleEntryPointsFound = rendererHtmlEntryPoints.length !== 1;

          if (multipleEntryPointsFound && path === "/") {
            res.writeHead(500);
            res.end('Multiple html entry points defined, unable to pick single root');
          } else {
            if (path === "/" || path.endsWith(".html")) {
              let file;
              if (path === "/") {
                file = rendererHtmlEntryPoints[0];
              } else {
                file = path;
              }

              const htmlFilePath = "."+file;

              if (fs.existsSync(htmlFilePath)) {
                try {
                  res.writeHead(200, {"Content-Type": "text/html"});
                  res.end(htmlTransform(esbuildLiveReload(fs.readFileSync(htmlFilePath)), rendererBuildOutputDirectory, meta));
                } catch (error) {
                  res.writeHead(500);
                  res.end('Failed to transform html ['+error+']');
                }
              } else {
                res.writeHead(404);
                res.end('HTML file ['+htmlFilePath+'] not found');
              }
            } else {
              const proxyReq = http.request(options, (proxyRes) => {
                if (proxyRes.statusCode === 404 && !multipleEntryPointsFound) {
                  // If esbuild 404s the request, assume it's a route needing to
                  // be handled by the JS bundle, so forward a second attempt to `/`.
                  return forwardRequest("/");
                }

                // Otherwise esbuild handled it like a champ, so proxy the response back.
                res.writeHead(proxyRes.statusCode, proxyRes.headers);

                if (req.method === 'GET' && req.url === '/esbuild' && req.headers.accept === 'text/event-stream') {
                  const reloadCallback = () => {
                    res.write('event: reload\ndata: reload\n\n');
                  };
                  reloadEventEmitter.on('reload', reloadCallback);
                  res.on('close', () => {
                    reloadEventEmitter.removeListener('reload', reloadCallback);
                  });
                }
                proxyRes.pipe(res, { end: true });
              });

              req.pipe(proxyReq, { end: true });
            }
          }
        };
        // When we're called pass the request right through to esbuild.
        forwardRequest(req.url);
      }
    });

    // Start our proxy server at the specified `listen` port.
    proxy.listen(rendererBuildServerProxyPort);

    console.log(`Started esbuild serve process [http://localhost:${rendererBuildServerProxyPort}]`);

    return reloadEventEmitter;
};

const electronServe = async (reloadEventEmitter, rendererBuildServerProxyPort, mainEntryPoint, preloadEntryPoints, electronBuildOutputDirectory) => {

  await (async function () {
    const plugins = [{
      name: 'renderer-reload-plugin',
      setup(build) {
        build.onEnd(() => {
          reloadEventEmitter.emit('reload');
        });
      },
    }];

    const ctx = await esbuild.context({
      entryPoints: preloadEntryPoints,
      bundle: true,
      outdir: electronBuildOutputDirectory,
      logOverride: {
        'equals-negative-zero': 'silent',
      },
      logLevel: "info",
      entryNames: '[name]',
      assetNames: '[name]',
      plugins: plugins,
      platform: 'node',
      external: ['electron'],
    });

    ctx.watch();
  })();

  await (async function () {
    const plugins = [{
      name: 'main-reload-plugin',
      setup(build) {
        let electronProcess = null;
        build.onEnd(() => {
          if (electronProcess != null) {
            electronProcess.handle.removeListener('exit', electronProcess.closeListener);
            electronProcess.handle.kill();
            electronProcess = null;
          }
          electronProcess = {
            handle: spawn(electron, [path.join(electronBuildOutputDirectory, mainEntryPoint), '.'], { stdio: 'inherit' }),
            closeListener: () => process.exit()
          };
          electronProcess.handle.on('exit', electronProcess.closeListener);
        });
      },
    }];

    const ctx = await esbuild.context({
      entryPoints: [mainEntryPoint],
      bundle: true,
      outdir: electronBuildOutputDirectory,
      logOverride: {
        'equals-negative-zero': 'silent',
      },
      logLevel: "info",
      entryNames: '[name]',
      assetNames: '[name]',
      plugins: plugins,
      platform: 'node',
      external: ['electron'],
    });

    ctx.watch();
  })();

  Object.assign(process.env, {
    DEV_SERVER_URL: `http://localhost:${rendererBuildServerProxyPort}`,
  })
};

rendererServe(
  ['./renderer.js'],
  ['/index.html'],
  './www',
  8000,
  8001,
  'esbuild-electron-renderer-meta.json'
)
  .then((reloadEventEmitter) => {
    electronServe(
      reloadEventEmitter,
      8000,
      './main.js',
      ['./preload.js'],
      './out'
    );
  });