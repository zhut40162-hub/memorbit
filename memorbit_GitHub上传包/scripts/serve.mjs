import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 8080);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'};
http.createServer(async (request,response)=>{
 try {
  if (!['GET','HEAD'].includes(request.method)) {response.writeHead(405);response.end();return;}
  const url = new URL(request.url,'http://localhost');
  const requested = decodeURIComponent(url.pathname);
  const file = path.resolve(root,'.' + (requested.endsWith('/') ? requested + 'index.html' : requested));
  if (!file.startsWith(root + path.sep) || requested.split('/').some(x=>x.startsWith('.'))) {response.writeHead(403);response.end();return;}
  const bytes = await fs.readFile(file);
  response.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Length':bytes.length});
  response.end(request.method==='HEAD'?undefined:bytes);
 } catch {response.writeHead(404);response.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Local preview: http://127.0.0.1:${port}`));
