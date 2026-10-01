CREATE TABLE IF NOT EXISTS otp_verifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  email VARCHAR(190) NULL,
  phone VARCHAR(25) NULL,
  channel ENUM('email') NOT NULL,
  purpose ENUM('registration_email','password_reset','admin_2fa') NOT NULL,
  otp_hash VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 5,
  last_sent_at DATETIME NOT NULL,
  verified_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX otp_lookup (email, phone, channel, purpose, verified_at),
  INDEX otp_expiry (expires_at),
  CONSTRAINT otp_destination_check CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(36) PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX session_user (user_id, revoked_at),
  INDEX session_expiry (expires_at)
);

CREATE TABLE IF NOT EXISTS registration_attempts (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  phone VARCHAR(25) NULL,
  usn VARCHAR(40) NOT NULL,
  semester TINYINT UNSIGNED NOT NULL,
  section VARCHAR(20) NOT NULL,
  department VARCHAR(100) NOT NULL,
  college_id INT NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  email_verified_at DATETIME NULL,
  phone_verified_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (college_id) REFERENCES colleges(id) ON DELETE CASCADE,
  INDEX registration_expiry (expires_at)
);
