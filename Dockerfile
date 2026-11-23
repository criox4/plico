# The Plico API (server/ plus the parts of src/ it shares with the app). Built by .github/workflows/deploy-api.yml.
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# Scripts off: postinstall would run prisma generate before the schema's env is known. Generate needs no real database.
RUN npm ci --ignore-scripts && DIRECT_URL=postgresql://build@localhost/build npx prisma generate \
  && npm prune --omit=dev --ignore-scripts # the build tools (vite, typescript, the prisma CLI) stay out of the running image

COPY tsconfig.json ./
COPY server ./server
COPY src ./src

ENV NODE_ENV=production PORT=8787
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Node runs the TypeScript itself (type stripping, Node 24): no build step and no tsx in the image.
CMD ["node", "server/index.ts"]
