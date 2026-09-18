FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
# 预生成 Brotli(q11) 静态副本。Fastify 的 preCompressed 会优先返回同名 .br，
# 从而绕开 Traefik 的在线压缩：Traefik 按客户端声明顺序选择，浏览器发送
# "gzip, deflate, br, zstd"（gzip 在前）时会拿到 gzip，比 brotli 大 ~28%。
RUN node -e "const fs=require('fs'),zlib=require('zlib'),p=require('path');const re=/\.(js|css|html|json|svg)$/;let n=0,raw=0,br=0;const walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).forEach((e)=>{const f=p.join(d,e.name);if(e.isDirectory())return walk(f);if(!re.test(e.name))return;const b=fs.readFileSync(f);const o=zlib.brotliCompressSync(b,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11,[zlib.constants.BROTLI_PARAM_SIZE_HINT]:b.length}});if(o.length<b.length){fs.writeFileSync(f+'.br',o);n++;raw+=b.length;br+=o.length;}});walk('public');console.log('brotli precompressed files='+n+' raw='+raw+' br='+br+' saved='+(raw-br));"
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/server.js"]
