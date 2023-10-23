
const http = require('http');
const esbuild = require('esbuild');
const jsdom = require("jsdom")
const { JSDOM } = jsdom;
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

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
        eventSource.addEventListener('reload', e => {
          location.reload();
        });
      </script>
    </head>
    `);
}

const serve = async () => {
    // Start esbuild's local web server. Random port will be chosen by esbuild.

    const reloadEventEmitter = new EventEmitter();

    const plugins = [{
      name: 'metafile-plugin',
      setup(build) {
        build.onEnd(result => {
          const metafileName = 'esbuild-electron-renderer-meta.json';
          if (!result.metafile) {
            console.warn("Metafile missing in build result")
            fs.writeFileSync(metafileName, '{}');
          } else {
            fs.writeFileSync(metafileName, JSON.stringify(result.metafile));
          }
        });
      },
    }];

    const ctx  = await esbuild.context({
      entryPoints: ['./renderer.js'],
      bundle: true,
      outdir: './www',
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
        servedir: './www',
        port: 8001
    });

    // Create a second (proxy) server that will forward requests to esbuild.
    const proxy = http.createServer((req, res) => {
        const metaPath = path.join(__dirname, 'esbuild-electron-renderer-meta.json');
        let meta;
        try {
          meta = JSON.parse(fs.readFileSync(metaPath));
        } catch (error) {
          res.writeHead(500);
          res.end('META file ['+metaPath+'] not found');
        }

        if (meta) {
          // forwardRequest forwards an http request through to esbuid.
          const forwardRequest = (path) => {
              const options = {
                  hostname: host,
                  port,
                  path,
                  method: req.method,
                  headers: req.headers,
              };

          const multipleEntryPointsFound = false;

          if (multipleEntryPointsFound && path === "/") {
            res.writeHead(500);
            res.end('Multiple html entry points defined, unable to pick single root');
          } else {
            if (path === "/" || path.endsWith(".html")) {
              let file;
              if (path === "/") {
                file = '/index.html';
              } else {
                file = path;
              }

              const htmlFilePath = "."+file;

              if (fs.existsSync(htmlFilePath)) {
                try {
                  res.writeHead(200, {"Content-Type": "text/html"});
                  res.end(htmlTransform(esbuildLiveReload(fs.readFileSync(htmlFilePath)), './www', meta));
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
    proxy.listen(8000);

    console.log("Started esbuild serve process [http://localhost:8000]");
};

// Serves all content from /Users/domantas/IdeaProjects/open-source/scalajs-esbuild/sbt-scalajs-esbuild-web/src/sbt-test/sbt-scalajs-esbuild-web/multiple-entry-points/target/scala-2.13/esbuild/main/www on :8000.
// If esbuild 404s the request, the request is attempted again
// from `/` assuming that it's an SPA route needing to be handled by the root bundle.

// TODO emit main/preload rebuilds here
const reloadEventEmitter = serve();
