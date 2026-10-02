ALTER TABLE otp_verifications
  MODIFY purpose ENUM('registration_email','password_reset','admin_2fa') NOT NULL;
