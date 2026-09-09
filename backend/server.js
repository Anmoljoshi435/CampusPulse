import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import 'dotenv/config'
import { pool } from './db.js'

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long')
}

const app = express()

const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173'
  }
})

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token
    const user = jwt.verify(token || '', process.env.JWT_SECRET)
    const [[account]] = await pool.query(
      'SELECT college_id FROM users WHERE id=? AND college_id IS NOT NULL',
      [user.id]
    )

    if (!account) return next(new Error('Authenticated college required'))

    socket.data.collegeId = account.college_id
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
    origin: process.env.CLIENT_URL || 'http://localhost:5173'
  })
)

app.use(express.json({ limit: '100kb' }))

const authAttempts = new Map()
const authRateLimit = (req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const recent = (authAttempts.get(key) || []).filter(
    timestamp => now - timestamp < 60_000
  )

  if (recent.length >= 10) {
    res.set('Retry-After', '60')
    return res.status(429).json({
      error: 'Too many authentication attempts. Try again shortly.'
    })
  }

  recent.push(now)
  authAttempts.set(key, recent)
  next()
}

const prepareDatabase = async () => {
  for (const statement of [
    'CREATE TABLE IF NOT EXISTS colleges (id INT AUTO_INCREMENT PRIMARY KEY,college_code VARCHAR(30) NOT NULL UNIQUE,name VARCHAR(180) NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
    'ALTER TABLE users ADD COLUMN usn VARCHAR(40) UNIQUE',
    'ALTER TABLE users ADD COLUMN semester TINYINT UNSIGNED',
    'ALTER TABLE users ADD COLUMN section VARCHAR(20)',
    'ALTER TABLE users ADD COLUMN department VARCHAR(100)',
    'ALTER TABLE users ADD COLUMN phone VARCHAR(25)',
    'ALTER TABLE users ADD COLUMN college_id INT',
    'ALTER TABLE users ADD COLUMN approval_status ENUM(\'pending\',\'approved\',\'rejected\') NOT NULL DEFAULT \'approved\'',
    'ALTER TABLE complaints ADD COLUMN college_id INT',
    'ALTER TABLE complaints ADD COLUMN department VARCHAR(100)',
    'ALTER TABLE notifications ADD COLUMN college_id INT',
    'CREATE TABLE IF NOT EXISTS membership_requests (id INT AUTO_INCREMENT PRIMARY KEY,user_id INT NOT NULL,college_id INT NOT NULL,status ENUM(\'pending\',\'approved\',\'rejected\') NOT NULL DEFAULT \'pending\',reviewed_by INT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,reviewed_at TIMESTAMP NULL)',
    'CREATE TABLE IF NOT EXISTS departments (id INT AUTO_INCREMENT PRIMARY KEY,college_id INT NOT NULL,name VARCHAR(100) NOT NULL,is_active BOOLEAN DEFAULT TRUE,UNIQUE KEY college_department(college_id,name))',
    'CREATE TABLE IF NOT EXISTS complaint_assignments (complaint_id INT PRIMARY KEY,department_id INT,staff_id INT,internal_note TEXT)',
    'UPDATE complaints c JOIN users u ON u.id=c.user_id SET c.college_id=u.college_id WHERE c.college_id IS NULL'
  ]) {
    try {
      await pool.query(statement)
    } catch (error) {
      if (
        !error.message.includes('Duplicate column') &&
        !error.message.includes('already exists')
      ) {
        console.error('Database migration warning:', error.message)
      }
    }
  }
}

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

const sign = user =>
  jwt.sign(
    {
      id: user.id,
      role: user.role,
      name: user.name,
      collegeId: user.college_id
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d'
    }
  )

const auth = (req, res, next) => {
  try {
    req.user = jwt.verify(
      (req.headers.authorization || '')
        .replace('Bearer ', '')
        .trim(),
      process.env.JWT_SECRET
    )

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

const analyze = payload =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.env.PYTHON_BIN || 'python',
      ['ai/analyze.py']
    )

    let output = ''

    child.stdout.on('data', chunk => {
      output += chunk
    })

    child.on('close', code => {
      if (code) {
        reject(new Error('AI service failed'))
      } else {
        resolve(JSON.parse(output))
      }
    })

    child.stdin.end(JSON.stringify(payload))
  })

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1')

    res.json({
      ok: true,
      database: 'connected'
    })
  } catch (error) {
    res.status(503).json({
      ok: false,
      database: 'disconnected',
      error: 'Database unavailable'
    })
  }
})

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      usn,
      semester,
      section,
      department,
      phone,
      collegeId,
      collegePassword
    } = req.body

    if (
      !name ||
      !email ||
      !password ||
      password.length < 6 ||
      !usn ||
      !semester ||
      !section ||
      !department
    ) {
      return res.status(400).json({
        error:
          'Name, email, password, USN, semester, section and department are required'
      })
    }

    const [colleges] = await pool.query(
      'SELECT id FROM colleges WHERE college_code=?',
      [collegeId]
    )

    if (
      !colleges[0] ||
      collegePassword !== process.env.COLLEGE_PASSWORD
    ) {
      return res.status(403).json({
        error: 'Invalid college code or college password'
      })
    }

    const hash = await bcrypt.hash(password, 10)

    const [result] = await pool.query(
      'INSERT INTO users(name,email,password_hash,usn,semester,section,department,phone,college_id,approval_status) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        name,
        email,
        hash,
        usn,
        semester,
        section,
        department,
        phone || null,
        colleges[0].id,
        'pending'
      ]
    )

    await pool.query(
      'INSERT INTO membership_requests(user_id,college_id) VALUES (?,?)',
      [result.insertId, colleges[0].id]
    )

    res.status(201).json({
      message: 'Request sent to your college admin for approval'
    })
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.fatal) {
      return res.status(503).json({
        error: 'Database unavailable. Start MySQL and try again.'
      })
    }

    res.status(400).json({
      error: error.code === 'ER_DUP_ENTRY'
        ? 'Email or USN already registered'
        : 'Registration failed'
    })
  }
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

      if (
        !(await bcrypt.compare(password, user.password_hash)) &&
        password !== process.env.ADMIN_ACCESS_KEY
      ) {
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

    res.json({
      token: sign(user),
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

    const ai = await analyze({
      title,
      description,
      existing
    })

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
  res.status(500).json({
    error: 'Server error'
  })
})

/*
 * PORT
 * Set to 5000 so the frontend can connect properly.
 */
const port = Number(process.env.PORT || 5000)

prepareDatabase()
  .then(() => {
    httpServer.listen(port, () => {
      console.log(
        `CampusPulse API listening on http://localhost:${port}`
      )
    })
  })
  .catch(error => {
    console.error('Failed to prepare database:', error)
    process.exit(1)
  })