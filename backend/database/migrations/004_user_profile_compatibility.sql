SET @sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE users ADD COLUMN email_verified_at DATETIME NULL', 'SELECT 1') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'email_verified_at');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE users ADD COLUMN phone_verified_at DATETIME NULL', 'SELECT 1') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'phone_verified_at');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE users ADD COLUMN usn VARCHAR(40) UNIQUE', 'SELECT 1') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'usn');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE users ADD COLUMN semester TINYINT UNSIGNED', 'SELECT 1') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'semester');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE users ADD COLUMN section VARCHAR(20)', 'SELECT 1') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'section');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE users ADD COLUMN department VARCHAR(100)', 'SELECT 1') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'department');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE users ADD COLUMN phone VARCHAR(25)', 'SELECT 1') FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'phone');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
