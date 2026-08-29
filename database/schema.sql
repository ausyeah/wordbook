-- 单词书联网版 · PostgreSQL 建表脚本
-- 使用位置：腾讯云 CloudBase 控制台 → 数据库 → SQL 编辑器，粘贴后执行（可重复执行）

CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  pass_hash    TEXT NOT NULL,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS word_state (
  user_id        BIGINT NOT NULL,
  word           TEXT NOT NULL,
  level          INTEGER NOT NULL DEFAULT 0,
  due_at         BIGINT NOT NULL DEFAULT 0,
  interval_days  DOUBLE PRECISION DEFAULT 0,
  ease           DOUBLE PRECISION DEFAULT 2.5,
  reps           INTEGER DEFAULT 0,
  lapses         INTEGER DEFAULT 0,
  rev            INTEGER DEFAULT 1,
  updated_at     BIGINT NOT NULL,
  created_at     BIGINT DEFAULT 0,
  deleted_at     INTEGER DEFAULT 0,
  is_wrong_book  BOOLEAN DEFAULT FALSE,
  ever_wrong     BOOLEAN DEFAULT FALSE,
  wrong_streak   INTEGER DEFAULT 0,
  wrong_added_at BIGINT DEFAULT 0,
  wrong_count    INTEGER DEFAULT 0,
  correct_count  INTEGER DEFAULT 0,
  is_mastered    BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (user_id, word)
);

CREATE INDEX IF NOT EXISTS idx_state_due ON word_state(user_id, due_at);

CREATE TABLE IF NOT EXISTS review_log (
  user_id     BIGINT NOT NULL,
  word        TEXT NOT NULL,
  rating      INTEGER NOT NULL,
  occurred_at BIGINT NOT NULL,
  op_id       TEXT NOT NULL,
  PRIMARY KEY (user_id, op_id)
);

CREATE TABLE IF NOT EXISTS settings (
  user_id    BIGINT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  updated_at BIGINT DEFAULT 0,
  PRIMARY KEY (user_id, key)
);
