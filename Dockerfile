# FinFlo backend image — for hosts that deploy from a container image (e.g.
# Render "Existing image"). Secrets are NOT baked in: set ANTHROPIC_API_KEY and
# ALLOWED_ORIGIN as environment variables on the host.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server ./server
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000
EXPOSE 10000
CMD ["node", "server/index.js"]
