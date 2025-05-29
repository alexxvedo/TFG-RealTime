require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3001,
  environment: process.env.NODE_ENV || 'development',
  jwt: {
    secret: process.env.JWT_SECRET || 'default_secret_key_change_in_production',
    expiresIn: '24h'
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info'
  }
};
