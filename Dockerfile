# Dockerfile for Railway/Hetzner deployment
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install Node deps
COPY package.json ./
RUN npm install

# Set CloakBrowser cache to a shared location (not /root which is 700)
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser
ENV CLOAKBROWSER_AUTO_UPDATE=false

# Install CloakBrowser binary and make readable by all users
RUN npx cloakbrowser install && \
    chmod -R 755 /opt/cloakbrowser && \
    rm -rf /opt/cloakbrowser/*.tar.gz /opt/cloakbrowser/updates /tmp/* 2>/dev/null || true

# Copy source
COPY src/ ./src/

# Create sessions directory
RUN mkdir -p .sessions/instagram

# Non-root user for security
RUN groupadd -r scraper && useradd -r -g scraper -m scraper
RUN chown -R scraper:scraper /app
USER scraper

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "src/server.js"]
