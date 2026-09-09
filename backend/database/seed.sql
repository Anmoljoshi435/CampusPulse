USE campuspulse;
INSERT INTO colleges (college_code, name) VALUES ('CIT001', 'Cambridge Institute of Technology') ON DUPLICATE KEY UPDATE name=VALUES(name);
INSERT INTO users (name, email, password_hash, role) VALUES
('Aarav Mehta', 'student@campuspulse.local', '$2a$10$7EqJtq98hPqEX7fNZaFWoOe5L8XK4nY0rRZ7Pj1sKQxM5sH5p5y6u', 'student'),
('Campus Admin', 'admin@campuspulse.local', '$2a$10$7EqJtq98hPqEX7fNZaFWoOe5L8XK4nY0rRZ7Pj1sKQxM5sH5p5y6u', 'admin')
ON DUPLICATE KEY UPDATE name=VALUES(name);
UPDATE users SET college_id=(SELECT id FROM colleges WHERE college_code='CIT001'), approval_status='approved' WHERE email IN ('student@campuspulse.local','admin@campuspulse.local');
INSERT INTO complaints (user_id,title,description,category,location,status,priority) SELECT id,'WiFi keeps dropping in Block C','The network disconnects every few minutes in the third-floor study area.','WiFi','Academic Block C','In Progress','High' FROM users WHERE email='student@campuspulse.local' LIMIT 1;
