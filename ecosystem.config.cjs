module.exports = {
  apps: [{
    name: 'instagram-scraper',
    script: 'src/server.js',
    cwd: '/opt/instagram-scraper-service',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    restart_delay: 3000,
    max_restarts: 10,
    env_production: {
      NODE_ENV: 'production',
      PORT: 3001,
      SCRAPER_SECRET: 'ScR4p3rS3cr3t2024',
    }
  }]
};
