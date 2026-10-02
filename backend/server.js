import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { pool } from './db.js'
import { config } from './config.js'
import { otpService } from './services/otpService.js'

if (!config.jwtSecret || config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long')
}

const app = express()
app.set('trust proxy', 1)

const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: config.corsOrigins,
    credentials: true
  }
})

const sessionCookie = 'campuspulse_session'
const parseCookies = header => Object.fromEntries((header || '').split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(item => item.length === 2))
const hashToken = token => createHash('sha256').update(token).digest('hex')
const cookieOptions = [`${sessionCookie}=`, 'Max-Age=0', 'Path=/', 'HttpOnly', 'SameSite=Lax', config.nodeEnv === 'production' ? 'Secure' : ''].filter(Boolean).join('; ')

const createSession = async user => {
  const sessionId = randomUUID()
  const token = jwt.sign({ id: user.id, role: user.role, name: user.name, collegeId: user.college_id, sessionId }, config.jwtSecret, { expiresIn: '7d' })
  await pool.query(
    'INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(), INTERVAL 7 DAY))',
    [sessionId, user.id, hashToken(token)]
  )
  return token
}

const setSessionCookie = (res, token) => {
  const parts = [`${sessionCookie}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (config.nodeEnv === 'production') parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || parseCookies(socket.handshake.headers.cookie)[sessionCookie]
    const user = jwt.verify(token || '', config.jwtSecret)
    const [[session]] = await pool.query(
      'SELECT id FROM auth_sessions WHERE id=? AND user_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>NOW()',
      [user.sessionId, user.id, hashToken(token)]
    )
    if (!session) return next(new Error('Authentication required'))
    const [[account]] = await pool.query(
      'SELECT id,role,college_id,approval_status FROM users WHERE id=? AND college_id IS NOT NULL',
      [user.id]
    )

    if (!account || (account.role === 'student' && account.approval_status !== 'approved')) return next(new Error('Authenticated college required'))

    socket.data.collegeId = account.college_id
    socket.data.userId = account.id
    socket.data.role = account.role
    socket.join(`user:${account.id}`)
    if (account.role === 'admin') socket.join(`admins:${account.college_id}`)
    next()
  } catch {
    next(new Error('Authentication required'))
  }
})

io.on('connection', socket => {
  socket.join(`college:${socket.data.collegeId}`)
})

app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true
  })
)

app.use(helmet())
app.use(express.json({ limit: '100kb' }))

const authRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: false,
  keyGenerator: req => req.get('CF-Connecting-IP') || req.ip || 'unknown',
  message: { error: 'Too many authentication attempts. Try again shortly.' }
})

const validEmail = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
const validPhone = value => typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value)
const validOtpChannel = value => value === 'email'
const validOtpPurpose = value => ['registration_email', 'password_reset', 'admin_2fa'].includes(value)

const generateCollegeCode = async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `CAMP-${randomBytes(4)
      .toString('hex')
      .slice(0, 5)
      .toUpperCase()}`
    const [rows] = await pool.query(
      'SELECT id FROM colleges WHERE college_code=?',
      [code]
    )

    if (!rows.length) return code
  }

  throw new Error('Could not generate a unique college ID')
}

const createNotification = async ({ userId, collegeId, complaintId = null, message }) => {
  await pool.query(
    'INSERT INTO notifications(user_id,college_id,complaint_id,message) VALUES (?,?,?,?)',
    [userId, collegeId, complaintId, message]
  )
  io.to(`user:${userId}`).emit('notificationCreated', { message, complaintId, collegeId })
}

const auth = async (req, res, next) => {
  try {
    const cookies = parseCookies(req.headers.cookie)
    const token = cookies[sessionCookie] || (req.headers.authorization || '').replace('Bearer ', '').trim()
    const claims = jwt.verify(
      token,
      config.jwtSecret
    )
    const [[session]] = await pool.query(
      'SELECT id FROM auth_sessions WHERE id=? AND user_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>NOW()',
      [claims.sessionId, claims.id, hashToken(token)]
    )
    if (!session) return res.status(401).json({ error: 'Authentication required' })
    const [[account]] = await pool.query(
      'SELECT id,role,college_id,approval_status FROM users WHERE id=?',
      [claims.id]
    )
    if (!account || !account.college_id || (account.role === 'student' && account.approval_status !== 'approved')) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    req.user = { ...claims, role: account.role, collegeId: account.college_id, college_id: account.college_id }
    next()
  } catch {
    res.status(401).json({
      error: 'Authentication required'
    })
  }
}

const admin = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Admin access required'
      })
    }

    const [[user]] = await pool.query(
      'SELECT id,college_id FROM users WHERE id=? AND role=\'admin\'',
      [req.user.id]
    )

    if (!user?.college_id) {
      return res.status(403).json({
        error: 'Admin has no college assigned'
      })
    }

    req.user.college_id = user.college_id
    next()
  } catch {
    res.status(503).json({
      error: 'Authorization service unavailable'
    })
  }
}

const analyzeLocal = payload =>
  new Promise((resolve, reject) => {
    const child = spawn(
      config.pythonBin,
      ['ai/analyze.py']
    )

    let output = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('AI service timed out'))
    }, 5000)

    child.stdout.on('data', chunk => {
      output += chunk
    })

    child.on('close', code => {
      clearTimeout(timeout)
      if (code) {
        reject(new Error('AI service failed'))
      } else {
        try {
          const result = JSON.parse(output)
          if (result.error) reject(new Error(result.error))
          else resolve(result)
        } catch {
          reject(new Error('AI service returned malformed output'))
        }
      }
    })

    child.stdin.end(JSON.stringify(payload))
  })

const analyze = async payload => {
  if (config.aiServiceUrl) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch(`${config.aiServiceUrl.replace(/\/+$/, '')}/ai/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      })
      if (!response.ok) throw new Error('AI service returned an error')
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }
  return analyzeLocal(payload)
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({
      ok: true,
      services: {
        api: 'healthy',
        database: 'connected',
        ai: config.aiServiceUrl ? 'configured' : 'local',
        email: process.env.SMTP_HOST ? 'configured' : 'not_configured',
        sms: 'disabled'
      }
    })
  } catch (error) {
    res.status(503).json({
      ok: false,
      database: 'disconnected',
      error: 'Database unavailable'
    })
  }
})

app.post('/api/auth/request-otp', authRateLimit, async (req, res) => {
  const { email, channel, purpose } = req.body
  if (!validOtpChannel(channel) || !validOtpPurpose(purpose) ||
      !validEmail(email)) {
    return res.status(400).json({ error: 'A valid OTP destination, channel and purpose are required' })
  }
  try {
    const result = await otpService.issue({ email, channel, purpose })
    res.status(202).json({ ok: true, ...result })
  } catch (error) {
    if (error.code === 'OTP_COOLDOWN') {
      res.set('Retry-After', String(error.retryAfter))
      return res.status(429).json({ error: error.message })
    }
    console.error('OTP request failed:', error.message)
    res.status(503).json({ error: 'Verification delivery is unavailable' })
  }
})

app.post('/api/auth/resend-otp', authRateLimit, async (req, res) => {
  const { email, channel, purpose } = req.body
  if (!validEmail(email) || !validOtpChannel(channel) || !validOtpPurpose(purpose)) {
    return res.status(400).json({ error: 'A valid OTP channel and purpose are required' })
  }
  try {
    const result = await otpService.issue({ email, channel, purpose })
    res.status(202).json({ ok: true, ...result })
  } catch (error) {
    if (error.code === 'OTP_COOLDOWN') {
      res.set('Retry-After', String(error.retryAfter))
      return res.status(429).json({ error: error.message })
    }
    console.error('OTP resend failed:', error.message)
    res.status(503).json({ error: 'Verification delivery is unavailable' })
  }
})

app.post('/api/auth/verify-otp', authRateLimit, async (req, res) => {
  const { email, channel, purpose, code } = req.body
  if (!validEmail(email) || !validOtpChannel(channel) || !validOtpPurpose(purpose) || !/^\d{6}$/.test(String(code || ''))) {
    return res.status(400).json({ error: 'A valid verification code is required' })
  }
  try {
    await otpService.verify({ email, channel, purpose, code })
    res.json({ ok: true })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

app.post('/api/auth/forgot-password', authRateLimit, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const destination = validEmail(email) ? { email, channel: 'email' } : null
  if (destination) {
    try {
      const [[user]] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [email])
      if (user) await otpService.issue({ ...destination, purpose: 'password_reset', userId: user.id })
    } catch (error) {
      if (error.code !== 'OTP_COOLDOWN') console.error('Password reset request failed:', error.message)
    }
  }
  res.status(200).json({ message: 'If the account exists, a verification code has been sent.' })
})

app.post('/api/auth/reset-password', authRateLimit, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const { channel, code, newPassword } = req.body
  if (!validEmail(email) || !validOtpChannel(channel) ||
      typeof newPassword !== 'string' || newPassword.length < 10 ||
      !/^\d{6}$/.test(String(code || ''))) {
    return res.status(400).json({ error: 'Invalid password reset request' })
  }
  try {
    await otpService.verify({ email, channel, purpose: 'password_reset', code })
    const [result] = await pool.query(
      'UPDATE users SET password_hash=? WHERE email=?',
      [await bcrypt.hash(newPassword, 12), email]
    )
    if (!result.affectedRows) return res.status(400).json({ error: 'Invalid password reset request' })
    res.json({ ok: true })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

app.post('/api/auth/start-registration', authRateLimit, async (req, res) => {
  const { name, email, password, usn, semester, section, department, collegeId } = req.body
  if (!name || !validEmail(email) || typeof password !== 'string' || password.length < 10 ||
      !usn || !Number.isInteger(Number(semester)) || !section || !department || !collegeId) {
    return res.status(400).json({ error: 'Complete valid registration details are required' })
  }
  try {
    const [[college]] = await pool.query('SELECT id FROM colleges WHERE college_code=?', [collegeId])
    if (!college) return res.status(400).json({ error: 'Invalid college code' })
    const attemptId = randomUUID()
    await pool.query(
      `INSERT INTO registration_attempts
       (id,name,email,usn,semester,section,department,college_id,password_hash,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,DATE_ADD(NOW(), INTERVAL 15 MINUTE))`,
      [attemptId, name.trim(), email.toLowerCase(), usn.trim(), Number(semester), section.trim(), department.trim(), college.id, await bcrypt.hash(password, 12)]
    )
    await Promise.all([
      otpService.issue({ email: email.toLowerCase(), channel: 'email', purpose: 'registration_email' })
    ])
    res.status(202).json({ registrationId: attemptId, message: 'Verification codes sent.' })
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email or USN already registered' })
    if (error.code === 'OTP_COOLDOWN') return res.status(429).json({ error: error.message })
    console.error('Registration start failed:', error.message)
    if (error.message === 'Email delivery is unavailable') {
      return res.status(503).json({ error: 'Email verification is unavailable. Check the SMTP settings in backend/.env.' })
    }
    res.status(503).json({ error: 'Registration verification is unavailable' })
  }
})

app.post('/api/auth/verify-registration', authRateLimit, async (req, res) => {
  const { registrationId, email, emailCode } = req.body
  if (!registrationId || !validEmail(email) || !/^\d{6}$/.test(String(emailCode || ''))) {
    return res.status(400).json({ error: 'A valid email verification code is required' })
  }
  const connection = await pool.getConnection()
  try {
    await otpService.verify({ email: email.toLowerCase(), channel: 'email', purpose: 'registration_email', code: emailCode })
    await connection.beginTransaction()
    const [[attempt]] = await connection.query(
      'SELECT * FROM registration_attempts WHERE id=? AND email=? AND expires_at>NOW() FOR UPDATE',
      [registrationId, email.toLowerCase()]
    )
    if (!attempt) throw new Error('Registration request expired')
    const [result] = await connection.query(
      `INSERT INTO users(name,email,password_hash,usn,semester,section,department,phone,college_id,approval_status,email_verified_at,phone_verified_at)
       VALUES (?,?,?,?,?,?,?,?,?,'pending',NOW(),NOW())`,
      [attempt.name, attempt.email, attempt.password_hash, attempt.usn, attempt.semester, attempt.section, attempt.department, attempt.phone, attempt.college_id]
    )
    await connection.query('INSERT INTO membership_requests(user_id,college_id) VALUES (?,?)', [result.insertId, attempt.college_id])
    await connection.query('DELETE FROM registration_attempts WHERE id=?', [registrationId])
    await connection.commit()
    res.status(201).json({ message: 'Registration verified. Your college admin must approve your account.' })
  } catch (error) {
    await connection.rollback()
    res.status(400).json({ error: error.message })
  } finally {
    connection.release()
  }
})

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  res.status(410).json({
    error: 'Use email verification registration at /api/auth/start-registration'
  })
})

app.post('/api/auth/create-college', authRateLimit, async (req, res) => {
  try {
    const {
      collegeName,
      adminName,
      adminEmail,
      adminPassword,
      phone
    } = req.body

    if (
      !collegeName ||
      !adminName ||
      !adminEmail ||
      !adminPassword ||
      adminPassword.length < 6
    ) {
      return res.status(400).json({
        error: 'College name and complete admin details are required'
      })
    }

    const code = await generateCollegeCode()

    const [college] = await pool.query(
      'INSERT INTO colleges(college_code,name) VALUES (?,?)',
      [code, collegeName]
    )

    const hash = await bcrypt.hash(adminPassword, 10)

    await pool.query(
      'INSERT INTO users(name,email,password_hash,phone,college_id,approval_status,role) VALUES (?,?,?,?,?,\'approved\',\'admin\')',
      [
        adminName,
        adminEmail,
        hash,
        phone || null,
        college.insertId
      ]
    )

    res.status(201).json({
      message: 'College created successfully',
      collegeName,
      collegeId: code
    })
  } catch (error) {
    res.status(400).json({
      error:
        error.code === 'ER_DUP_ENTRY'
          ? 'Admin email already registered'
          : 'College could not be created'
    })
  }
})

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  try {
    const {
      email,
      password,
      mode = 'student',
      collegeId
    } = req.body

    const [rows] = await pool.query(
      'SELECT u.*,c.college_code college_code,c.name college_name FROM users u LEFT JOIN colleges c ON c.id=u.college_id WHERE u.email=?',
      [email]
    )

    const user = rows[0]

    if (!user || mode !== user.role) {
      return res.status(401).json({
        error: 'Invalid account type or credentials'
      })
    }

    if (user.role === 'admin') {
      if (user.college_code !== collegeId) {
        return res.status(401).json({
          error: 'Invalid college code'
        })
      }

      if (!(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({
          error: 'Invalid admin password'
        })
      }
    }

    if (user.role === 'student') {
      if (user.approval_status !== 'approved') {
        return res.status(403).json({
          error: `Your college admin has not approved this account yet (${user.approval_status})`
        })
      }

      if (!(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({
          error: 'Invalid email or password'
        })
      }
    }

    const token = await createSession(user)
    setSessionCookie(res, token)
    res.json({
      role: user.role,
      user: {
        name: user.name,
        usn: user.usn,
        semester: user.semester,
        section: user.section,
        department: user.department,
        collegeName: user.college_name,
        collegeId: user.college_code
      }
    })

    app.get('/api/auth/session', auth, async (req, res) => {
      const [[user]] = await pool.query(
        'SELECT u.name,u.usn,u.semester,u.section,u.department,u.role,c.name college_name,c.college_code FROM users u LEFT JOIN colleges c ON c.id=u.college_id WHERE u.id=?',
        [req.user.id]
      )
      res.json({ role: user.role, user: { name: user.name, usn: user.usn, semester: user.semester, section: user.section, department: user.department, collegeName: user.college_name, collegeId: user.college_code } })
    })

    app.post('/api/auth/logout', auth, async (req, res) => {
      const token = parseCookies(req.headers.cookie)[sessionCookie]
      if (token) await pool.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE id=? AND user_id=?', [req.user.sessionId, req.user.id])
      res.setHeader('Set-Cookie', cookieOptions)
      res.json({ ok: true })
    })
  } catch (error) {
    res.status(500).json({
      error: 'Login failed'
    })
  }
})

app.get('/api/admin/home', auth, admin, async (req, res) => {
  const id = req.user.college_id

  const [[summary]] = await pool.query(
    `SELECT COUNT(*) total,
    SUM(status NOT IN ('Resolved')) open_issues,
    SUM(priority='Critical' AND status!='Resolved') critical_issues,
    SUM(status='Resolved' AND created_at >= DATE_SUB(NOW(),INTERVAL 7 DAY)) resolved_week
    FROM complaints WHERE college_id=?`,
    [id]
  )

  const [[category]] = await pool.query(
    `SELECT category,COUNT(*) count
    FROM complaints
    WHERE college_id=?
    GROUP BY category
    ORDER BY count DESC
    LIMIT 1`,
    [id]
  )

  const [[location]] = await pool.query(
    `SELECT location,COUNT(*) count
    FROM complaints
    WHERE college_id=?
    GROUP BY location
    ORDER BY count DESC
    LIMIT 1`,
    [id]
  )

  const [[requests]] = await pool.query(
    `SELECT COUNT(*) count
    FROM membership_requests
    WHERE college_id=? AND status='pending'`,
    [id]
  )

  const [activity] = await pool.query(
    `SELECT title,location,priority,status,created_at
    FROM complaints
    WHERE college_id=?
    ORDER BY created_at DESC
    LIMIT 6`,
    [id]
  )

  res.json({
    summary: {
      ...summary,
      pending_students: requests.count
    },
    snapshot: {
      category,
      location
    },
    activity
  })

  app.get('/api/notifications', auth, async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id,message,complaint_id,is_read,created_at
       FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    )
    res.json(rows)
  })

  app.put('/api/notifications/:id/read', auth, async (req, res) => {
    const [result] = await pool.query(
      'UPDATE notifications SET is_read=TRUE WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    )
    if (!result.affectedRows) return res.status(404).json({ error: 'Notification not found' })
    res.json({ ok: true })
  })

  app.put('/api/notifications/read-all', auth, async (req, res) => {
    await pool.query('UPDATE notifications SET is_read=TRUE WHERE user_id=?', [req.user.id])
    res.json({ ok: true })
  })
})

app.get('/api/admin/issues', auth, admin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT c.*,u.name reporter,
    COUNT(DISTINCT up.user_id) upvotes,
    COALESCE(a.similar_count,0) similar,
    GROUP_CONCAT(cs.similar_complaint_id ORDER BY cs.similarity_score DESC) similar_ids
    FROM complaints c
    JOIN users u ON u.id=c.user_id
    LEFT JOIN upvotes up ON up.complaint_id=c.id
    LEFT JOIN ai_analysis a ON a.complaint_id=c.id
    LEFT JOIN complaint_similarities cs ON cs.complaint_id=c.id
    WHERE c.college_id=?
    GROUP BY c.id
    ORDER BY c.created_at DESC`,
    [req.user.college_id]
  )

  res.json(rows)
})

app.get('/api/admin/ai-insights', auth, admin, async (req, res) => {
  try {
    const [history] = await pool.query(
      `SELECT category,location,
      CASE WHEN created_at >= DATE_SUB(NOW(),INTERVAL 7 DAY)
        THEN 'current' ELSE 'previous' END period
      FROM complaints
      WHERE college_id=?
        AND created_at >= DATE_SUB(NOW(),INTERVAL 14 DAY)`,
      [req.user.college_id]
    )
    const [groups] = await pool.query(
      `SELECT category,location,COUNT(*) report_count,
      CASE MAX(FIELD(priority,'Critical','High','Medium','Low'))
        WHEN 1 THEN 'Critical' WHEN 2 THEN 'High'
        WHEN 3 THEN 'Medium' ELSE 'Low' END severity,
      GROUP_CONCAT(title ORDER BY created_at DESC SEPARATOR ' | ') details
      FROM complaints
      WHERE college_id=?
      GROUP BY category,location
      HAVING COUNT(*) >= 2
      ORDER BY report_count DESC
      LIMIT 10`,
      [req.user.college_id]
    )
    const [trends, summaries] = await Promise.all([
      analyze({ mode: 'trends', history }),
      analyze({ mode: 'summaries', groups })
    ])

    res.json({
      alerts: trends.alerts,
      summaries: summaries.summaries
    })
  } catch {
    res.status(503).json({
      error: 'AI insights unavailable'
    })
  }
})

app.get('/api/admin/students', auth, admin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id,name,email,usn,department,semester,section,
    approval_status,created_at
    FROM users
    WHERE college_id=? AND role='student'
    ORDER BY created_at DESC`,
    [req.user.college_id]
  )

  res.json(rows)
})

app.get('/api/admin/departments', auth, admin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT d.id,d.name,d.is_active,
    COUNT(DISTINCT c.id) open_issues,
    SUM(c.status='Resolved') resolved_issues,
    COUNT(DISTINCT s.id) staff
    FROM departments d
    LEFT JOIN complaints c
      ON c.college_id=d.college_id
      AND c.department=d.name
    LEFT JOIN staff s
      ON s.department_id=d.id
    WHERE d.college_id=?
    GROUP BY d.id`,
    [req.user.college_id]
  )

  res.json(rows)
})

app.post('/api/admin/departments', auth, admin, async (req, res) => {
  if (!req.body.name) {
    return res.status(400).json({
      error: 'Department name required'
    })
  }

  await pool.query(
    'INSERT INTO departments(college_id,name) VALUES (?,?)',
    [req.user.college_id, req.body.name]
  )

  res.status(201).json({
    ok: true
  })
})

app.get('/api/admin/settings', auth, admin, async (req, res) => {
  const [[row]] = await pool.query(
    `SELECT c.id,c.name college_name,c.college_code,
    u.name admin_name,u.email admin_email
    FROM colleges c
    JOIN users u
      ON u.college_id=c.id
      AND u.role='admin'
    WHERE c.id=?`,
    [req.user.college_id]
  )

  res.json(row)
})

app.put('/api/admin/issues/:id', auth, admin, async (req, res) => {
  const allowed = [
    'Reported',
    'Acknowledged',
    'In Progress',
    'Resolved'
  ]

  if (
    req.body.status &&
    !allowed.includes(req.body.status)
  ) {
    return res.status(400).json({
      error: 'Invalid status'
    })
  }

  const [result] = await pool.query(
    `UPDATE complaints
    SET status=COALESCE(?,status),
        priority=COALESCE(?,priority),
        department=COALESCE(?,department)
    WHERE id=? AND college_id=?`,
    [
      req.body.status,
      req.body.priority,
      req.body.department,
      req.params.id,
      req.user.college_id
    ]
  )

  if (!result.affectedRows) {
    return res.status(404).json({
      error: 'Issue does not belong to your college'
    })
  }

  const [[complaint]] = await pool.query(
    'SELECT user_id,title,status,priority FROM complaints WHERE id=? AND college_id=?',
    [req.params.id, req.user.college_id]
  )
  if (complaint) {
    await createNotification({
      userId: complaint.user_id,
      collegeId: req.user.college_id,
      complaintId: req.params.id,
      message: `Your issue "${complaint.title}" is now ${complaint.status}.`
    })
  }

  io.to(`college:${req.user.college_id}`).emit('statusUpdate', {
    id: req.params.id,
    status: req.body.status,
    collegeId: req.user.college_id
  })

  res.json({
    ok: true
  })
})

app.post('/api/admin/students', auth, admin, async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      usn,
      semester,
      section,
      department,
      phone
    } = req.body

    if (
      !name ||
      !email ||
      !password ||
      !usn ||
      !semester ||
      !section ||
      !department
    ) {
      return res.status(400).json({
        error: 'All student details are required'
      })
    }

    const hash = await bcrypt.hash(password, 10)

    const [result] = await pool.query(
      `INSERT INTO users
      (name,email,password_hash,usn,semester,section,
      department,phone,college_id,approval_status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        name,
        email,
        hash,
        usn,
        semester,
        section,
        department,
        phone || null,
        req.user.college_id,
        'approved'
      ]
    )

    res.status(201).json({
      id: result.insertId,
      message: 'Student added successfully'
    })
  } catch (error) {
    res.status(400).json({
      error:
        error.code === 'ER_DUP_ENTRY'
          ? 'Email or USN already registered'
          : 'Student could not be added'
    })
  }
})

app.get('/api/admin/requests', auth, admin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT r.id,u.name,u.email,u.usn,u.semester,
    u.section,u.department,u.created_at,c.name college
    FROM membership_requests r
    JOIN users u ON u.id=r.user_id
    JOIN colleges c ON c.id=r.college_id
    WHERE r.college_id=? AND r.status='pending'
    ORDER BY r.created_at`,
    [req.user.college_id]
  )

  res.json(rows)
})

app.put('/api/admin/requests/:id', auth, admin, async (req, res) => {
  const next = req.body.status

  if (!['approved', 'rejected'].includes(next)) {
    return res.status(400).json({
      error: 'Invalid approval status'
    })
  }

  const [result] = await pool.query(
    `UPDATE membership_requests r
    JOIN users u ON u.id=r.user_id
    SET r.status=?,
        r.reviewed_by=?,
        r.reviewed_at=NOW(),
        u.approval_status=?
    WHERE r.id=? AND r.college_id=?`,
    [
      next,
      req.user.id,
      next,
      req.params.id,
      req.user.college_id
    ]
  )

  if (!result.affectedRows) {
    return res.status(403).json({
      error: 'Request does not belong to your college'
    })
  }

  io.to(`college:${req.user.college_id}`).emit('membershipUpdate', {
    requestId: req.params.id,
    status: next,
    collegeId: req.user.college_id
  })

  const [[requestOwner]] = await pool.query(
    `SELECT r.user_id FROM membership_requests r WHERE r.id=? AND r.college_id=?`,
    [req.params.id, req.user.college_id]
  )
  if (requestOwner) {
    await createNotification({
      userId: requestOwner.user_id,
      collegeId: req.user.college_id,
      message: `Your membership request was ${next}.`
    })
  }

  res.json({
    ok: true
  })
})

app.get('/api/complaints', auth, async (req, res) => {
  try {
    const scope = 'WHERE c.college_id=?'

    const [rows] = await pool.query(
      `SELECT c.*,u.name author,
      COUNT(DISTINCT up.user_id) upvotes,
      COALESCE(a.similar_count,0) similar
      FROM complaints c
      JOIN users u ON u.id=c.user_id
      LEFT JOIN upvotes up ON up.complaint_id=c.id
      LEFT JOIN ai_analysis a ON a.complaint_id=c.id
      ${scope}
      GROUP BY c.id
      ORDER BY c.created_at DESC`,
      [req.user.collegeId]
    )

    res.json(rows)
  } catch (error) {
    res.status(500).json({
      error: 'Could not load complaints'
    })
  }
})

app.post('/api/complaints', auth, async (req, res) => {
  try {
    const {
      title,
      description,
      location,
      category = 'Other'
    } = req.body

    if (!title || !description || !location) {
      return res.status(400).json({
        error: 'Title, description and location are required'
      })
    }

    const [existing] = await pool.query(
      'SELECT id,title,description,location,category,priority FROM complaints WHERE college_id=(SELECT college_id FROM users WHERE id=?)',
      [req.user.id]
    )

    let ai = {
      category: category || 'Other',
      priority: 'Medium',
      similar_count: 0,
      matches: [],
      duplicate: null,
      unavailable: true
    }
    try {
      ai = await analyze({ title, description, existing })
    } catch (error) {
      console.error('AI analysis unavailable:', error.message)
    }

    const [[owner]] = await pool.query(
      'SELECT college_id FROM users WHERE id=?',
      [req.user.id]
    )

    const [result] = await pool.query(
      `INSERT INTO complaints
      (user_id,college_id,title,description,category,location,priority)
      VALUES (?,?,?,?,?,?,?)`,
      [
        req.user.id,
        owner.college_id,
        title,
        description,
        ai.category,
        location,
        ai.priority
      ]
    )

    await pool.query(
      `INSERT INTO ai_analysis
      (complaint_id,category,priority,similar_count,confidence)
      VALUES (?,?,?,?,?)`,
      [
        result.insertId,
        ai.category,
        ai.priority,
        ai.similar_count,
        ai.duplicate?.score || null
      ]
    )

    for (const match of ai.matches || []) {
      await pool.query(
        `INSERT IGNORE INTO complaint_similarities
        (complaint_id,similar_complaint_id,similarity_score)
        VALUES (?,?,?)`,
        [result.insertId, match.id, match.score]
      )
    }

    io.to(`college:${owner.college_id}`).emit('newComplaint', {
      id: result.insertId,
      title,
      category: ai.category,
      priority: ai.priority,
      collegeId: owner.college_id
    })

    res.status(201).json({
      id: result.insertId,
      analysis: {
        category: ai.category,
        priority: ai.priority
      }
    })
  } catch (error) {
    res.status(500).json({
      error: 'Could not create complaint'
    })
  }
})

app.post('/api/complaints/:id/upvote', auth, async (req, res) => {
  try {
    const [[allowed]] = await pool.query(
      `SELECT id,college_id
      FROM complaints
      WHERE id=?
      AND college_id=(SELECT college_id FROM users WHERE id=?)`,
      [
        req.params.id,
        req.user.id
      ]
    )

    if (!allowed) {
      return res.status(403).json({
        error: 'Issue does not belong to your college'
      })
    }

    await pool.query(
      'INSERT IGNORE INTO upvotes(user_id,complaint_id) VALUES (?,?)',
      [
        req.user.id,
        req.params.id
      ]
    )

    const [[row]] = await pool.query(
      'SELECT COUNT(*) upvotes FROM upvotes WHERE complaint_id=?',
      [req.params.id]
    )

    io.to(`college:${allowed.college_id}`).emit('upvoteUpdate', {
      id: req.params.id,
      upvotes: row.upvotes,
      collegeId: allowed.college_id
    })

    res.json(row)
  } catch (error) {
    res.status(500).json({
      error: 'Could not update upvote'
    })
  }
})

app.put('/api/complaints/:id/status', auth, admin, async (req, res) => {
  try {
    const allowed = [
      'Reported',
      'Acknowledged',
      'In Progress',
      'Resolved'
    ]

    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({
        error: 'Invalid status'
      })
    }

    const [result] = await pool.query(
      'UPDATE complaints SET status=? WHERE id=? AND college_id=?',
      [
        req.body.status,
        req.params.id,
        req.user.college_id
      ]
    )

    if (!result.affectedRows) {
      return res.status(403).json({
        error: 'Issue does not belong to your college'
      })
    }

    io.to(`college:${req.user.college_id}`).emit('statusUpdate', {
      id: req.params.id,
      status: req.body.status,
      collegeId: req.user.college_id
    })

    res.json({
      ok: true
    })
  } catch (error) {
    res.status(500).json({
      error: 'Could not update complaint status'
    })
  }
})

app.use((error, req, res, next) => {
  console.error('Unhandled request error:', error.message)
  res.status(500).json({
    error: 'Server error'
  })
})

const shutdown = async signal => {
  console.log(`Received ${signal}; shutting down`)
  await new Promise(resolve => httpServer.close(resolve))
  await io.close()
  await pool.end()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

httpServer.listen(config.port, () => {
  console.log(`CampusPulse API listening on port ${config.port}`)
})