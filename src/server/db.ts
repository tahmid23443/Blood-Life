import Database from 'better-sqlite3';
import path from 'path';
import type {
  AppNotification,
  BloodRequest,
  BloodType,
  ChatMessage,
  TikaCampaign,
  TikaRegistration,
  UserProfile,
} from '../types';
import { BLOOD_TYPES } from '../shared/bloodLogic';

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DB_PATH = process.env.SQLITE_DB_PATH
  ? path.resolve(process.env.SQLITE_DB_PATH)
  : isServerless
  ? '/tmp/bloodline.db'
  : path.resolve(process.cwd(), 'bloodline.db');

export const db = new Database(DB_PATH);

try {
  db.pragma('journal_mode = WAL');
} catch {
  // Fallback to default journal mode if environment disallows WAL
}
db.pragma('foreign_keys = ON');

export function initDatabase() {
  // Check if an older users table lacked the 'government' role CHECK constraint
  const existingUsersTable = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { sql?: string } | undefined;

  if (existingUsersTable?.sql && !existingUsersTable.sql.includes("'government'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN TRANSACTION;
      ALTER TABLE users RENAME TO users_old;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('donor', 'needer', 'rider', 'hospital', 'government')),
        blood_type TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        is_available INTEGER NOT NULL DEFAULT 1,
        donations_count INTEGER NOT NULL DEFAULT 0,
        requests_count INTEGER NOT NULL DEFAULT 0,
        vehicle_type TEXT,
        hospital_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users SELECT * FROM users_old;
      DROP TABLE users_old;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('donor', 'needer', 'rider', 'hospital', 'government')),
      blood_type TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      is_available INTEGER NOT NULL DEFAULT 1,
      donations_count INTEGER NOT NULL DEFAULT 0,
      requests_count INTEGER NOT NULL DEFAULT 0,
      vehicle_type TEXT,
      hospital_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hospital_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hospital_id TEXT NOT NULL,
      blood_type TEXT NOT NULL,
      units INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hospital_id, blood_type),
      FOREIGN KEY(hospital_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blood_requests (
      id TEXT PRIMARY KEY,
      needer_id TEXT NOT NULL,
      blood_type TEXT NOT NULL,
      units INTEGER NOT NULL DEFAULT 1,
      urgency TEXT NOT NULL CHECK(urgency IN ('critical', 'urgent', 'standard')),
      status TEXT NOT NULL,
      pickup_type TEXT,
      provider_id TEXT,
      rider_id TEXT,
      pickup_address TEXT,
      pickup_lat REAL,
      pickup_lng REAL,
      dropoff_address TEXT NOT NULL,
      dropoff_lat REAL NOT NULL,
      dropoff_lng REAL NOT NULL,
      rider_lat REAL,
      rider_lng REAL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(needer_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tika_campaigns (
      id TEXT PRIMARY KEY,
      gov_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      vaccine_name TEXT NOT NULL,
      target_group TEXT NOT NULL,
      dose_schedule TEXT NOT NULL,
      total_slots INTEGER NOT NULL DEFAULT 100,
      venue_name TEXT NOT NULL,
      venue_address TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      home_visit_available INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'PAUSED', 'COMPLETED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(gov_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tika_registrations (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      beneficiary_name TEXT NOT NULL,
      beneficiary_age INTEGER NOT NULL DEFAULT 1,
      nid_or_brn TEXT NOT NULL,
      phone TEXT NOT NULL,
      dose_number INTEGER NOT NULL DEFAULT 1,
      delivery_mode TEXT NOT NULL DEFAULT 'camp' CHECK(delivery_mode IN ('camp', 'home_visit')),
      address TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      preferred_date TEXT NOT NULL,
      preferred_slot TEXT NOT NULL,
      tika_card_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'REGISTERED' CHECK(status IN ('REGISTERED', 'CONFIRMED', 'VACCINATED', 'CANCELLED')),
      administered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(campaign_id) REFERENCES tika_campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      request_id TEXT,
      room_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      message TEXT NOT NULL,
      msg_type TEXT NOT NULL DEFAULT 'text',
      duration_sec INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'status',
      request_id TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

export function sanitizeUser(row: Record<string, unknown>): UserProfile {
  const { password_hash: _ignored, ...rest } = row;
  const user = rest as unknown as UserProfile;
  if (user.role === 'hospital') {
    const invRows = db
      .prepare('SELECT blood_type, units FROM hospital_inventory WHERE hospital_id = ?')
      .all(user.id) as { blood_type: BloodType; units: number }[];
    const inv = {} as Record<BloodType, number>;
    for (const bt of BLOOD_TYPES) inv[bt] = 0;
    for (const r of invRows) inv[r.blood_type] = r.units;
    user.inventory = inv;
  }
  return user;
}

export function getAllProviders(): UserProfile[] {
  const rows = db.prepare('SELECT * FROM users').all() as Record<string, unknown>[];
  return rows.map(sanitizeUser);
}

export function getEnrichedRequests(): BloodRequest[] {
  return db
    .prepare(
      `
      SELECT
        r.*,
        n.name as needer_name,
        n.phone as needer_phone,
        COALESCE(p.hospital_name, p.name) as provider_name,
        p.phone as provider_phone,
        ri.name as rider_name,
        ri.phone as rider_phone,
        ri.vehicle_type as rider_vehicle
      FROM blood_requests r
      JOIN users n ON r.needer_id = n.id
      LEFT JOIN users p ON r.provider_id = p.id
      LEFT JOIN users ri ON r.rider_id = ri.id
      ORDER BY r.created_at DESC
    `
    )
    .all() as BloodRequest[];
}

export function getEnrichedRequestById(id: string): BloodRequest | undefined {
  return db
    .prepare(
      `
      SELECT
        r.*,
        n.name as needer_name,
        n.phone as needer_phone,
        COALESCE(p.hospital_name, p.name) as provider_name,
        p.phone as provider_phone,
        ri.name as rider_name,
        ri.phone as rider_phone,
        ri.vehicle_type as rider_vehicle
      FROM blood_requests r
      JOIN users n ON r.needer_id = n.id
      LEFT JOIN users p ON r.provider_id = p.id
      LEFT JOIN users ri ON r.rider_id = ri.id
      WHERE r.id = ?
    `
    )
    .get(id) as BloodRequest | undefined;
}

export function getEnrichedTikaCampaigns(): TikaCampaign[] {
  return db
    .prepare(
      `
      SELECT
        c.*,
        COALESCE(u.hospital_name, u.name) as gov_org_name,
        COALESCE((SELECT COUNT(*) FROM tika_registrations r WHERE r.campaign_id = c.id AND r.status != 'CANCELLED'), 0) as registered_count,
        COALESCE((SELECT COUNT(*) FROM tika_registrations r WHERE r.campaign_id = c.id AND r.status = 'VACCINATED'), 0) as vaccinated_count
      FROM tika_campaigns c
      JOIN users u ON c.gov_user_id = u.id
      ORDER BY c.created_at DESC
    `
    )
    .all() as TikaCampaign[];
}

export function getEnrichedTikaCampaignById(id: string): TikaCampaign | undefined {
  return db
    .prepare(
      `
      SELECT
        c.*,
        COALESCE(u.hospital_name, u.name) as gov_org_name,
        COALESCE((SELECT COUNT(*) FROM tika_registrations r WHERE r.campaign_id = c.id AND r.status != 'CANCELLED'), 0) as registered_count,
        COALESCE((SELECT COUNT(*) FROM tika_registrations r WHERE r.campaign_id = c.id AND r.status = 'VACCINATED'), 0) as vaccinated_count
      FROM tika_campaigns c
      JOIN users u ON c.gov_user_id = u.id
      WHERE c.id = ?
    `
    )
    .get(id) as TikaCampaign | undefined;
}

export function getTikaRegistrationsForUser(userId: string): TikaRegistration[] {
  return db
    .prepare(
      `
      SELECT
        r.*,
        c.title as campaign_title,
        c.vaccine_name as vaccine_name,
        c.venue_name as venue_name,
        c.venue_address as venue_address
      FROM tika_registrations r
      JOIN tika_campaigns c ON r.campaign_id = c.id
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC
    `
    )
    .all(userId) as TikaRegistration[];
}

export function getTikaRegistrationsForGov(govUserId: string): TikaRegistration[] {
  return db
    .prepare(
      `
      SELECT
        r.*,
        c.title as campaign_title,
        c.vaccine_name as vaccine_name,
        c.venue_name as venue_name,
        c.venue_address as venue_address
      FROM tika_registrations r
      JOIN tika_campaigns c ON r.campaign_id = c.id
      WHERE c.gov_user_id = ?
      ORDER BY r.created_at DESC
    `
    )
    .all(govUserId) as TikaRegistration[];
}

export function getTikaRegistrationById(id: string): TikaRegistration | undefined {
  return db
    .prepare(
      `
      SELECT
        r.*,
        c.title as campaign_title,
        c.vaccine_name as vaccine_name,
        c.venue_name as venue_name,
        c.venue_address as venue_address
      FROM tika_registrations r
      JOIN tika_campaigns c ON r.campaign_id = c.id
      WHERE r.id = ?
    `
    )
    .get(id) as TikaRegistration | undefined;
}

export function createNotification(
  userId: string,
  title: string,
  body: string,
  type: AppNotification['type'],
  requestId: string | null = null
): AppNotification {
  const id = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO notifications (id, user_id, title, body, type, request_id, is_read) VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(id, userId, title, body, type, requestId);
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as AppNotification;
}

export function getMessagesByRoom(roomId: string): ChatMessage[] {
  return db
    .prepare(
      `
      SELECT m.*, u.name as sender_name, u.role as sender_role
      FROM chat_messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.room_id = ?
      ORDER BY m.created_at ASC
    `
    )
    .all(roomId) as ChatMessage[];
}

export function getAllUserNotifications(userId: string): AppNotification[] {
  return db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40')
    .all(userId) as AppNotification[];
}
