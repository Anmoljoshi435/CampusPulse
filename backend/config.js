import 'dotenv/config'

const isProduction = process.env.NODE_ENV === 'production'
const requiredInProduction = [
  'CLIENT_URL',
  'CORS_ORIGINS',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET',
  'PYTHON_BIN'
]

if (isProduction) {
  const missing = requiredInProduction.filter(name => !process.env[name])
  if (missing.length || (process.env.JWT_SECRET || '').length < 32) {
    throw new Error(`Missing or invalid production configuration: ${missing.join(', ') || 'JWT_SECRET must be at least 32 characters'}`)
  }
}

const origins = (process.env.CORS_ORIGINS || process.env.CLIENT_URL || (isProduction ? '' : 'http://localhost:5173'))
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  corsOrigins: origins,
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    name: process.env.DB_NAME || 'campuspulse',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || ''
  },
  jwtSecret: process.env.JWT_SECRET || '',
  pythonBin: process.env.PYTHON_BIN || 'python',
  aiServiceUrl: process.env.AI_SERVICE_URL || ''
}
