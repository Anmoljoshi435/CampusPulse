import nodemailer from 'nodemailer'

const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_FROM']

const isConfigured = () => required.every(name => Boolean(process.env[name]))

const sendEmail = async ({ to, subject, text, html }) => {
  if (!isConfigured()) throw new Error('Email provider is not configured')

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    family: 4,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD
    }
  })

  await transporter.sendMail({ from: process.env.EMAIL_FROM, to, subject, text, html })
}

export const emailService = {
  isConfigured,
  sendOtp: ({ to, code, purpose = 'verification' }) => {
    const subject = purpose === 'password_reset'
      ? 'CampusPulse password reset OTP'
      : 'CampusPulse email verification OTP'
    const text = `Your CampusPulse verification code is ${code}. It expires in 5 minutes. If you did not request this code, ignore this email.`
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#172033"><h2>CampusPulse</h2><p>Hello,</p><p>Your verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 5 minutes.</p><p>If you did not request this code, ignore this email.</p></div>`
    return sendEmail({ to, subject, text, html })
  }
}
