import fs from 'node:fs/promises'
import { pool } from './db.js'

const sql = await fs.readFile(new URL('./database/schema.sql', import.meta.url), 'utf8')
for (const statement of sql.split(';').map(item => item.trim()).filter(Boolean)) await pool.query(statement)
console.log('CampusPulse database schema is ready')
await pool.end()
