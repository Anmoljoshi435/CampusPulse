import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './db.js'

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'database', 'migrations')

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(120) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)

const files = (await fs.readdir(directory))
  .filter(file => file.endsWith('.sql'))
  .sort()

for (const file of files) {
  const [applied] = await pool.query('SELECT id FROM schema_migrations WHERE id=?', [file])
  if (applied.length) continue

  const sql = await fs.readFile(path.join(directory, file), 'utf8')
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    for (const statement of sql.split(';').map(item => item.trim()).filter(Boolean)) {
      await connection.query(statement)
    }
    await connection.query('INSERT INTO schema_migrations(id) VALUES (?)', [file])
    await connection.commit()
    console.log(`Applied migration ${file}`)
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

await pool.end()
