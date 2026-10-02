import { Resend } from 'resend'

const isConfigured = () => Boolean(process.env.RESEND_API_KEY)

const sendEmail = async ({ to, subject, text, html }) => {
  if (!isConfigured()) throw new Error('Email provider is not configured')

  const resend = new Resend(process.env.RESEND_API_KEY)
  const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM || 'CampusPulse <onboarding@resend.dev>',
    to: [to],
    subject,
    text,
    html
  })

  if (error) {
    console.error('Resend email delivery failed:', error.message)
    throw new Error(error.message)
  }

  console.info('OTP email sent via Resend:', data?.id || 'accepted')
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
