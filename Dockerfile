# Dockerfile for Railway deployment
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install Node deps
COPY package.json ./
RUN npm install

# Install CloakBrowser Chromium
RUN npx cloakbrowser install

# Copy source
COPY src/ ./src/

# Create sessions directory
RUN mkdir -p .sessions/instagram

# Non-root user for security
RUN groupadd -r scraper && useradd -r -g scraper scraper
RUN chown -R scraper:scraper /app
USER scraper

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "src/server.js"]
