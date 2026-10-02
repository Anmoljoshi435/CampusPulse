import { randomInt } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { pool } from '../db.js'
import { emailService } from './emailService.js'

const OTP_TTL_MINUTES = 5
const RESEND_COOLDOWN_SECONDS = 60
const MAX_ATTEMPTS = 5

const destinationColumn = () => 'email'
const providerFor = () => emailService

const issue = async ({ email, phone, channel, purpose, userId = null, force = false }) => {
  const destination = email
  if (channel !== 'email') throw new Error('Only email verification is supported')
  if (!destination) throw new Error(`${channel} destination is required`)

  const column = destinationColumn(channel)
  const [active] = await pool.query(
    `SELECT id,last_sent_at FROM otp_verifications
     WHERE ${column}=? AND channel=? AND purpose=? AND verified_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [destination, channel, purpose]
  )
  if (active[0] && !force) {
    const elapsed = (Date.now() - new Date(active[0].last_sent_at).getTime()) / 1000
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      const error = new Error('Please wait before requesting another code')
      error.code = 'OTP_COOLDOWN'
      error.retryAfter = Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed)
      throw error
    }
  }

  await pool.query(
    `UPDATE otp_verifications SET verified_at=NOW()
     WHERE ${column}=? AND channel=? AND purpose=? AND verified_at IS NULL`,
    [destination, channel, purpose]
  )

  const code = String(randomInt(100000, 1000000))
  const hash = await bcrypt.hash(code, 10)
  const [result] = await pool.query(
    `INSERT INTO otp_verifications
      (user_id,${column},channel,purpose,otp_hash,expires_at,last_sent_at,max_attempts)
     VALUES (?,?,?,?,?,DATE_ADD(NOW(), INTERVAL ${OTP_TTL_MINUTES} MINUTE),NOW(),?)`,
    [userId, destination, channel, purpose, hash, MAX_ATTEMPTS]
  )

  try {
    await providerFor(channel).sendOtp({ to: destination, code, purpose })
  } catch (error) {
    console.error(`${channel} OTP delivery failed:`, error.code || 'UNKNOWN', error.responseCode || '', error.message)
    await pool.query('DELETE FROM otp_verifications WHERE id=? AND verified_at IS NULL', [result.insertId])
    throw new Error('Email delivery is unavailable')
  }
  return { expiresIn: OTP_TTL_MINUTES * 60, retryAfter: RESEND_COOLDOWN_SECONDS }
}

const verify = async ({ email, phone, channel, purpose, code }) => {
  if (channel !== 'email') throw new Error('Only email verification is supported')
  const destination = email
  const column = destinationColumn(channel)
  const [[record]] = await pool.query(
    `SELECT * FROM otp_verifications
     WHERE ${column}=? AND channel=? AND purpose=? AND verified_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [destination, channel, purpose]
  )
  if (!record) throw new Error('OTP is invalid or expired. Please request a new code.')
  if (new Date(record.expires_at) <= new Date()) {
    await pool.query('UPDATE otp_verifications SET verified_at=NOW() WHERE id=?', [record.id])
    throw new Error('OTP has expired. Please request a new code.')
  }
  if (record.attempts >= record.max_attempts) throw new Error('Too many incorrect attempts. Please request a new OTP.')

  const valid = await bcrypt.compare(String(code || ''), record.otp_hash)
  await pool.query('UPDATE otp_verifications SET attempts=attempts+1 WHERE id=?', [record.id])
  if (!valid) {
    if (record.attempts + 1 >= record.max_attempts) {
      await pool.query('UPDATE otp_verifications SET verified_at=NOW() WHERE id=?', [record.id])
      throw new Error('Too many incorrect attempts. Please request a new OTP.')
    }
    throw new Error('OTP is invalid. Please check the code and try again.')
  }

  await pool.query('UPDATE otp_verifications SET verified_at=NOW() WHERE id=?', [record.id])
  return true
}

export const otpService = { issue, verify, RESEND_COOLDOWN_SECONDS }
