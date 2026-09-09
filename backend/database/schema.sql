CREATE DATABASE IF NOT EXISTS campuspulse;
USE campuspulse;

CREATE TABLE IF NOT EXISTS colleges (
  id INT AUTO_INCREMENT PRIMARY KEY,
  college_code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(180) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  usn VARCHAR(40) UNIQUE,
  semester TINYINT UNSIGNED,
  section VARCHAR(20),
  department VARCHAR(100),
  phone VARCHAR(25),
  college_id INT,
  approval_status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  role ENUM('student','admin') NOT NULL DEFAULT 'student',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (college_id) REFERENCES colleges(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS membership_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  college_id INT NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (college_id) REFERENCES colleges(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS complaints (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  college_id INT,
  title VARCHAR(180) NOT NULL,
  description TEXT NOT NULL,
  category ENUM('WiFi','Electricity','Water','Cleanliness','Security','Transport','Classroom','Canteen','Infrastructure','Other') NOT NULL DEFAULT 'Other',
  location VARCHAR(180) NOT NULL,
  department VARCHAR(100),
  image_url VARCHAR(500),
  status ENUM('Reported','Acknowledged','In Progress','Resolved') NOT NULL DEFAULT 'Reported',
  priority ENUM('Low','Medium','High','Critical') NOT NULL DEFAULT 'Medium',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (college_id) REFERENCES colleges(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  college_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE KEY college_department (college_id, name),
  FOREIGN KEY (college_id) REFERENCES colleges(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS staff (
  id INT AUTO_INCREMENT PRIMARY KEY,
  college_id INT NOT NULL,
  department_id INT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190),
  is_active BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (college_id) REFERENCES colleges(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS complaint_assignments (
  complaint_id INT PRIMARY KEY,
  department_id INT,
  staff_id INT,
  internal_note TEXT,
  FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS upvotes (user_id INT NOT NULL, complaint_id INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id, complaint_id), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(complaint_id) REFERENCES complaints(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS notifications (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, college_id INT, complaint_id INT, message VARCHAR(255) NOT NULL, is_read BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(college_id) REFERENCES colleges(id) ON DELETE CASCADE, FOREIGN KEY(complaint_id) REFERENCES complaints(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS ai_analysis (id INT AUTO_INCREMENT PRIMARY KEY, complaint_id INT NOT NULL UNIQUE, category VARCHAR(40) NOT NULL, priority VARCHAR(20) NOT NULL, similar_count INT DEFAULT 0, confidence DECIMAL(5,4), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(complaint_id) REFERENCES complaints(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS complaint_similarities (complaint_id INT NOT NULL, similar_complaint_id INT NOT NULL, similarity_score DECIMAL(5,4) NOT NULL, PRIMARY KEY(complaint_id, similar_complaint_id), FOREIGN KEY(complaint_id) REFERENCES complaints(id) ON DELETE CASCADE, FOREIGN KEY(similar_complaint_id) REFERENCES complaints(id) ON DELETE CASCADE);
