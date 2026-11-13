/**
 * YagzShoes Enterprise — SQLite Veritabanı Katmanı
 * WAL modu, Foreign Key kontrolü, Transaction güvenliği
 * JSON'dan tam data migrasyonu dahil
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.TEST_DB_PATH
  ? path.resolve(process.env.TEST_DB_PATH)
  : path.join(DB_DIR, 'yagzshoes.db');
const BACKUPS_DIR = path.join(__dirname, '..', 'backups');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    // WAL modu: eşzamanlı okuma, daha güvenli yazma
    db.pragma('journal_mode = WAL');
    // Foreign Key kısıtlamaları aktif
    db.pragma('foreign_keys = ON');
    // Meşgul veritabanı için 5 saniye bekle
    db.pragma('busy_timeout = 5000');
    // Güvenilir senkron mod
    db.pragma('synchronous = NORMAL');
  }
  return db;
}

// ============================================================
// ŞEMA OLUŞTURMA
// ============================================================
function initSchema() {
  const db = getDb();

  db.exec(`
    -- Kullanıcılar
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','kasiyer','stok_sorumlusu','rapor_goruntuleme')),
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      session_version INTEGER NOT NULL DEFAULT 0,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );

    -- Sistem ayarları
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT,
      updated_by TEXT
    );

    -- Ürün ana kartları (model/marka/renk bazında)
    CREATE TABLE IF NOT EXISTS product_groups (
      id TEXT PRIMARY KEY,
      marka TEXT NOT NULL DEFAULT 'Genel',
      model TEXT NOT NULL,
      renk TEXT NOT NULL DEFAULT 'Standart',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Ürün varyantları (her barkod = bir beden = bir kayıt)
    CREATE TABLE IF NOT EXISTS products (
      barcode TEXT PRIMARY KEY,
      group_id TEXT REFERENCES product_groups(id),
      marka TEXT NOT NULL DEFAULT 'Genel',
      model TEXT NOT NULL,
      renk TEXT NOT NULL DEFAULT 'Standart',
      numara REAL NOT NULL,
      alis_fiyati_kurus INTEGER NOT NULL DEFAULT 0,
      satis_fiyati_kurus INTEGER NOT NULL DEFAULT 0,
      kdv_orani INTEGER NOT NULL DEFAULT 10,
      stok INTEGER NOT NULL DEFAULT 0 CHECK(stok >= 0),
      min_stok INTEGER NOT NULL DEFAULT 2,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );

    -- Satış başlıkları
    CREATE TABLE IF NOT EXISTS sales (
      fis_no TEXT PRIMARY KEY,
      tarih TEXT NOT NULL DEFAULT (datetime('now')),
      kasiyer_id TEXT NOT NULL REFERENCES users(id),
      kasiyer_adi TEXT NOT NULL,
      toplam_brut_kurus INTEGER NOT NULL DEFAULT 0,
      indirim_kurus INTEGER NOT NULL DEFAULT 0,
      net_satis_kurus INTEGER NOT NULL DEFAULT 0,
      toplam_maliyet_kurus INTEGER NOT NULL DEFAULT 0,
      toplam_kdv_kurus INTEGER NOT NULL DEFAULT 0,
      net_kar_kurus INTEGER NOT NULL DEFAULT 0,
      toplam_kalem_adedi INTEGER NOT NULL DEFAULT 0,
      odeme_turu TEXT NOT NULL DEFAULT 'Nakit',
      nakit_tahsilat_kurus INTEGER NOT NULL DEFAULT 0,
      kart_tahsilat_kurus INTEGER NOT NULL DEFAULT 0,
      para_ustu_kurus INTEGER NOT NULL DEFAULT 0,
      musteri_notu TEXT,
      durum TEXT NOT NULL DEFAULT 'TAMAMLANDI' CHECK(durum IN ('TAMAMLANDI','IPTAL','KISMI_IADE')),
      iptal_tarihi TEXT,
      iptal_nedeni TEXT,
      iptal_kasiyer_id TEXT REFERENCES users(id),
      iptal_kasiyer_adi TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Satış kalemleri
    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY,
      fis_no TEXT NOT NULL REFERENCES sales(fis_no) ON DELETE CASCADE,
      barcode TEXT NOT NULL REFERENCES products(barcode),
      model TEXT NOT NULL,
      numara REAL NOT NULL,
      adet INTEGER NOT NULL DEFAULT 1,
      birim_satis_kurus INTEGER NOT NULL,
      birim_alis_kurus INTEGER NOT NULL,
      toplam_satis_kurus INTEGER NOT NULL,
      toplam_alis_kurus INTEGER NOT NULL,
      kdv_orani INTEGER NOT NULL DEFAULT 10,
      kdv_kurus INTEGER NOT NULL DEFAULT 0,
      iade_edilen_adet INTEGER NOT NULL DEFAULT 0
    );

    -- Ödeme kayıtları (Nakit / Kart / Bölünmüş)
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      fis_no TEXT NOT NULL REFERENCES sales(fis_no) ON DELETE CASCADE,
      odeme_yontemi TEXT NOT NULL CHECK(odeme_yontemi IN ('Nakit', 'Kredi Kartı', 'Bölünmüş', 'Havale')),
      tutar_kurus INTEGER NOT NULL CHECK(tutar_kurus >= 0),
      para_ustu_kurus INTEGER NOT NULL DEFAULT 0 CHECK(para_ustu_kurus >= 0),
      referans_no TEXT,
      kasiyer_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Ürün varyantları (Beden ve stok kırılımı)
    CREATE TABLE IF NOT EXISTS product_variants (
      id TEXT PRIMARY KEY,
      group_id TEXT REFERENCES product_groups(id),
      barcode TEXT UNIQUE NOT NULL REFERENCES products(barcode) ON DELETE CASCADE,
      model TEXT NOT NULL,
      renk TEXT NOT NULL DEFAULT 'Standart',
      numara REAL NOT NULL,
      stok INTEGER NOT NULL DEFAULT 0 CHECK(stok >= 0),
      alis_fiyati_kurus INTEGER NOT NULL DEFAULT 0,
      satis_fiyati_kurus INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );

    -- Alış ve satış fiyat geçmişi
    CREATE TABLE IF NOT EXISTS price_history (
      id TEXT PRIMARY KEY,
      barcode TEXT NOT NULL REFERENCES products(barcode) ON DELETE CASCADE,
      eski_alis_fiyati_kurus INTEGER NOT NULL,
      yeni_alis_fiyati_kurus INTEGER NOT NULL,
      eski_satis_fiyati_kurus INTEGER NOT NULL,
      yeni_satis_fiyati_kurus INTEGER NOT NULL,
      degistiren_id TEXT REFERENCES users(id),
      degistiren_adi TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Stok sayımı oturumları
    CREATE TABLE IF NOT EXISTS stock_counts (
      id TEXT PRIMARY KEY,
      sayim_tarihi TEXT NOT NULL DEFAULT (datetime('now')),
      kullanici_id TEXT REFERENCES users(id),
      kullanici_adi TEXT,
      durum TEXT NOT NULL DEFAULT 'TAMAMLANDI' CHECK(durum IN ('TASLAK', 'TAMAMLANDI', 'IPTAL')),
      toplam_fark_adet INTEGER DEFAULT 0,
      aciklama TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Stok sayımı kalemleri
    CREATE TABLE IF NOT EXISTS stock_count_items (
      id TEXT PRIMARY KEY,
      count_id TEXT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
      barcode TEXT NOT NULL,
      model TEXT NOT NULL,
      numara REAL NOT NULL,
      sistem_stok INTEGER NOT NULL,
      sayilan_stok INTEGER NOT NULL,
      fark INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Kasa nakit giriş/çıkış hareketleri
    CREATE TABLE IF NOT EXISTS cash_transactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
      islem_turu TEXT NOT NULL CHECK(islem_turu IN ('GIRIS', 'CIKIS')),
      tutar_kurus INTEGER NOT NULL CHECK(tutar_kurus > 0),
      kategori TEXT NOT NULL DEFAULT 'Genel',
      aciklama TEXT,
      kullanici_id TEXT REFERENCES users(id),
      kullanici_adi TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- İade kayıtları (kısmi iade destekli)
    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      fis_no TEXT NOT NULL REFERENCES sales(fis_no),
      sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
      iade_adet INTEGER NOT NULL DEFAULT 1,
      iade_tutari_kurus INTEGER NOT NULL DEFAULT 0,
      iade_nedeni TEXT,
      stoğa_donus INTEGER NOT NULL DEFAULT 1,
      kasiyer_id TEXT NOT NULL REFERENCES users(id),
      kasiyer_adi TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Stok hareketleri (append-only, DELETE yasak)
    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      barcode TEXT NOT NULL,
      model TEXT NOT NULL,
      numara REAL NOT NULL,
      islem_turu TEXT NOT NULL CHECK(islem_turu IN ('SATIS','IADE','GIRIS','CIKIS','SAYIM_DUZELTME','EXCEL_SYNC','BASLANGIC')),
      onceki_stok INTEGER NOT NULL,
      degisim INTEGER NOT NULL,
      yeni_stok INTEGER NOT NULL,
      belge_no TEXT,
      aciklama TEXT,
      kullanici_id TEXT,
      kullanici_adi TEXT NOT NULL DEFAULT 'Sistem',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Kasa oturumları (açılış/kapanış)
    CREATE TABLE IF NOT EXISTS cash_sessions (
      id TEXT PRIMARY KEY,
      acilis_tarihi TEXT NOT NULL,
      acilis_nakdi_kurus INTEGER NOT NULL DEFAULT 0,
      acilis_kasiyer_id TEXT NOT NULL REFERENCES users(id),
      acilis_kasiyer_adi TEXT NOT NULL,
      kapanis_tarihi TEXT,
      kapanis_kasiyer_id TEXT REFERENCES users(id),
      kapanis_kasiyer_adi TEXT,
      nakit_satis_kurus INTEGER DEFAULT 0,
      kart_satis_kurus INTEGER DEFAULT 0,
      iade_kurus INTEGER DEFAULT 0,
      nakit_giris_kurus INTEGER DEFAULT 0,
      nakit_cikis_kurus INTEGER DEFAULT 0,
      beklenen_nakit_kurus INTEGER DEFAULT 0,
      sayilan_nakit_kurus INTEGER DEFAULT 0,
      kasa_farki_kurus INTEGER DEFAULT 0,
      kapanis_notu TEXT,
      durum TEXT NOT NULL DEFAULT 'ACIK' CHECK(durum IN ('ACIK','KAPALI')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Denetim günlüğü (append-only, DELETE/UPDATE yasak trigger ile korunur)
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      user_id TEXT,
      username TEXT NOT NULL DEFAULT 'Sistem',
      action TEXT NOT NULL,
      record_id TEXT,
      onceki_deger TEXT,
      yeni_deger TEXT,
      sonuc TEXT NOT NULL DEFAULT 'BASARILI',
      ip_adresi TEXT,
      user_agent TEXT,
      details TEXT
    );

    -- Yedek geçmişi
    CREATE TABLE IF NOT EXISTS backup_history (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      klasor_adi TEXT NOT NULL,
      boyut_bayt INTEGER,
      hash_sha256 TEXT,
      olusturan_kullanici TEXT NOT NULL,
      durum TEXT NOT NULL DEFAULT 'BASARILI'
    );

    -- Audit log koruma trigger'ları
    CREATE TRIGGER IF NOT EXISTS protect_audit_delete
    BEFORE DELETE ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'Denetim kayıtları silinemez');
    END;

    CREATE TRIGGER IF NOT EXISTS protect_audit_update
    BEFORE UPDATE ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'Denetim kayıtları değiştirilemez');
    END;

    -- Negatif stok koruması trigger
    CREATE TRIGGER IF NOT EXISTS prevent_negative_stock
    BEFORE UPDATE OF stok ON products
    WHEN NEW.stok < 0
    BEGIN
      SELECT RAISE(ABORT, 'Stok miktarı negatif olamaz');
    END;
  `);

  // Canlı veritabanı şema güncellemeleri (mevcut verileri koruyarak)
  const safeAlter = (sql) => { try { db.exec(sql); } catch (_) {} };
  safeAlter("ALTER TABLE products ADD COLUMN tedarikci TEXT DEFAULT 'Genel Tedarikçi'");
  safeAlter("ALTER TABLE sales ADD COLUMN iptal_tarihi TEXT");
  safeAlter("ALTER TABLE sales ADD COLUMN iptal_nedeni TEXT");
  safeAlter("ALTER TABLE sales ADD COLUMN iptal_kasiyer_id TEXT");
  safeAlter("ALTER TABLE sales ADD COLUMN iptal_kasiyer_adi TEXT");
  safeAlter("ALTER TABLE cash_sessions ADD COLUMN nakit_giris_kurus INTEGER DEFAULT 0");
  safeAlter("ALTER TABLE cash_sessions ADD COLUMN nakit_cikis_kurus INTEGER DEFAULT 0");

  // product_variants senkronizasyonu
  try {
    const varCount = db.prepare("SELECT COUNT(*) as cnt FROM product_variants").get()?.cnt || 0;
    if (varCount === 0) {
      db.prepare(`
        INSERT OR IGNORE INTO product_variants(id, group_id, barcode, model, renk, numara, stok, alis_fiyati_kurus, satis_fiyati_kurus)
        SELECT 'VAR-' || barcode, group_id, barcode, model, renk, numara, stok, alis_fiyati_kurus, satis_fiyati_kurus FROM products
      `).run();
    }
  } catch (_) {}

  // stock_movements CHECK constraint güncellemesi (IPTAL desteği)
  try {
    const smDef = db.prepare("SELECT sql FROM sqlite_master WHERE name='stock_movements'").get()?.sql || '';
    if (smDef && !smDef.includes("'IPTAL'")) {
      db.exec(`
        PRAGMA foreign_keys=off;
        CREATE TABLE stock_movements_new (
          id TEXT PRIMARY KEY,
          barcode TEXT NOT NULL,
          model TEXT NOT NULL,
          numara REAL NOT NULL,
          islem_turu TEXT NOT NULL CHECK(islem_turu IN ('SATIS','IADE','IPTAL','GIRIS','CIKIS','SAYIM_DUZELTME','EXCEL_SYNC','BASLANGIC')),
          onceki_stok INTEGER NOT NULL,
          degisim INTEGER NOT NULL,
          yeni_stok INTEGER NOT NULL,
          belge_no TEXT,
          aciklama TEXT,
          kullanici_id TEXT,
          kullanici_adi TEXT NOT NULL DEFAULT 'Sistem',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO stock_movements_new SELECT * FROM stock_movements;
        DROP TABLE stock_movements;
        ALTER TABLE stock_movements_new RENAME TO stock_movements;
        PRAGMA foreign_keys=on;
      `);
    }
  } catch (_) {}
}

// ============================================================
// JSON → SQLite MIGRATION
// ============================================================
function migrateFromJSON() {
  const db = getDb();
  const bcrypt = require('bcryptjs');

  // Zaten migrasyon yapıldıysa atla
  const existing = db.prepare("SELECT COUNT(*) as cnt FROM users").get();
  if (existing.cnt > 0) return { skipped: true };

  const report = { users: 0, products: 0, sales: 0, errors: [] };

  // JSON Veri Dosyaları
  const safeRead = (file, def = []) => {
    try {
      const p = path.join(DB_DIR, file);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def;
    } catch (e) {
      return def;
    }
  };

  const jsonUsers = safeRead('users.json', []);
  const jsonProducts = safeRead('products.json', []);
  const jsonSales = safeRead('sales.json', []);
  const jsonMovements = safeRead('stock_movements.json', []);
  const jsonSettings = safeRead('settings.json', {});
  const jsonAuditLogs = safeRead('audit_logs.json', []);

  // Transaction ile toplu geçiş
  const migrate = db.transaction(() => {

    // --- Varsayılan Ayarlar ---
    const defaultSettings = {
      magaza_adi: 'YagzShoes Ayakkabı Mağazası',
      varsayilan_kdv: '10',
      min_stok_limiti: '2',
      fis_baslik: 'YAGZSHOES AYAKKABI SAN. VE TİC. LTD. ŞTİ.',
      fis_adres: 'İstiklal Cad. No:42 Beyoğlu / İstanbul',
      fis_telefon: '0212 555 00 90',
      fis_vergi_no: '9000123456',
      para_sembolu: '₺',
      setup_tamamlandi: '0',
      termal_yazici_genislik: '80'
    };

    const mergedSettings = { ...defaultSettings };
    if (jsonSettings && typeof jsonSettings === 'object') {
      if (jsonSettings.magazaAdi) mergedSettings.magaza_adi = jsonSettings.magazaAdi;
      if (jsonSettings.varsayilanKdv) mergedSettings.varsayilan_kdv = String(jsonSettings.varsayilanKdv);
      if (jsonSettings.minStokUyariLimiti) mergedSettings.min_stok_limiti = String(jsonSettings.minStokUyariLimiti);
    }

    const insSet = db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)`);
    Object.entries(mergedSettings).forEach(([k, v]) => insSet.run(k, v));

    // --- Kullanıcılar ---
    const insUser = db.prepare(`
      INSERT OR IGNORE INTO users(id, username, password_hash, full_name, role, active, must_change_password, session_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    if (jsonUsers.length > 0) {
      jsonUsers.forEach(u => {
        insUser.run(u.id || crypto.randomUUID(), u.username, u.passwordHash,
          u.fullName, u.role, u.active ? 1 : 0, 1, 0);
        report.users++;
      });
    } else {
      // JSON yoksa ilk kurulum: admin hesabı oluştur ama must_change_password=1
      // Geçici şifre ile kurulum akışı başlar
      const tempHash = bcrypt.hashSync('YagzSetup2026!', 10);
      insUser.run('USR-001', 'admin', tempHash, 'Sistem Yöneticisi', 'admin', 1, 1, 0);
      report.users = 1;
    }

    // --- Ürünler ---
    const insProduct = db.prepare(`
      INSERT OR IGNORE INTO products(barcode, marka, model, renk, numara,
        alis_fiyati_kurus, satis_fiyati_kurus, kdv_orani, stok, min_stok, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    jsonProducts.forEach(p => {
      try {
        insProduct.run(
          p.barkod, p.marka || 'Genel', p.model, p.renk || 'Standart',
          p.numara,
          Math.round((p.alisFiyati || 0) * 100),
          Math.round((p.satisFiyati || 0) * 100),
          p.kdvOrani || 10,
          p.stok || 0, p.minStok || 2,
          p.aktif !== false ? 1 : 0
        );
        report.products++;
      } catch (e) {
        report.errors.push(`Ürün geçiş hatası (${p.barkod}): ${e.message}`);
      }
    });

    // --- Satış Geçmişi (Sadece TAMAMLANDI durumundakiler) ---
    const insSale = db.prepare(`
      INSERT OR IGNORE INTO sales(fis_no, tarih, kasiyer_id, kasiyer_adi,
        toplam_brut_kurus, indirim_kurus, net_satis_kurus, toplam_maliyet_kurus,
        toplam_kdv_kurus, net_kar_kurus, toplam_kalem_adedi, odeme_turu,
        nakit_tahsilat_kurus, kart_tahsilat_kurus, para_ustu_kurus, durum)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    jsonSales.forEach(s => {
      try {
        if (s.durum === 'TAMAMLANDI' || s.durum === 'IADE') {
          insSale.run(
            s.fisNo || `LEGACY-${Date.now()}-${Math.random()}`,
            s.tarih, s.kasiyerId || 'USR-001', s.kasiyerAdi || 'Bilinmiyor',
            Math.round((s.toplamBrut || s.satisFiyati || 0) * 100),
            Math.round((s.indirim || 0) * 100),
            Math.round((s.netSatis || s.satisFiyati || 0) * 100),
            Math.round((s.toplamMaliyet || s.alisFiyati || 0) * 100),
            Math.round((s.toplamKdv || s.kdvTutari || 0) * 100),
            Math.round((s.netKar || 0) * 100),
            s.toplamKalemAdedi || s.adet || 1,
            s.odemeTuru || s.odemeTipi || 'Nakit',
            Math.round((s.nakitTahsilat || (s.odemeTipi === 'Nakit' ? s.satisFiyati : 0) || 0) * 100),
            Math.round((s.kartTahsilat || (s.odemeTipi === 'Kredi Kartı' ? s.satisFiyati : 0) || 0) * 100),
            Math.round((s.paraUstu || 0) * 100),
            s.durum || 'TAMAMLANDI'
          );
          report.sales++;
        }
      } catch (e) {
        report.errors.push(`Satış geçiş hatası: ${e.message}`);
      }
    });

    // --- Stok Hareketleri ---
    const insMov = db.prepare(`
      INSERT OR IGNORE INTO stock_movements(id, barcode, model, numara, islem_turu,
        onceki_stok, degisim, yeni_stok, belge_no, aciklama, kullanici_adi, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    jsonMovements.forEach(m => {
      try {
        insMov.run(
          m.id || crypto.randomUUID(),
          m.barkod, m.model, m.numara,
          m.islemTuru || 'GIRIS',
          m.oncekiStok || 0, m.degisim || 0, m.yeniStok || 0,
          m.belgeNo || null, m.aciklama || null,
          m.kullanici || 'Sistem',
          m.timestamp || new Date().toISOString()
        );
      } catch (e) {
        // Hareketler kritik değil, sessizce geç
      }
    });

    // --- Audit Loglar ---
    const insAudit = db.prepare(`
      INSERT OR IGNORE INTO audit_logs(id, timestamp, user_id, username, action, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    jsonAuditLogs.slice(-500).forEach(l => {
      try {
        insAudit.run(l.id || crypto.randomUUID(), l.timestamp, l.userId || null,
          l.username || 'Sistem', l.action, l.details || null);
      } catch (e) { /* sessiz */ }
    });

    // setup_tamamlandi=0 → kullanıcıların must_change_password=1 olduğunu belirtir
    insSet.run('migration_tarih', new Date().toISOString());
  });

  migrate();
  return report;
}

// ============================================================
// DOĞRULAMA: JSON vs SQLite karşılaştırma
// ============================================================
function validateMigration() {
  const db = getDb();
  const safeRead = (file, def = []) => {
    try {
      const p = path.join(DB_DIR, file);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def;
    } catch (e) { return def; }
  };

  const jsonProducts = safeRead('products.json', []);
  const jsonSales = safeRead('sales.json', []).filter(s => s.durum === 'TAMAMLANDI');

  const dbProductCount = db.prepare("SELECT COUNT(*) as cnt FROM products").get().cnt;
  const dbSaleCount = db.prepare("SELECT COUNT(*) as cnt FROM sales WHERE durum='TAMAMLANDI'").get().cnt;
  const dbStokTotal = db.prepare("SELECT SUM(stok) as total FROM products").get().total || 0;
  const jsonStokTotal = jsonProducts.reduce((acc, p) => acc + (p.stok || 0), 0);

  return {
    urunler: { json: jsonProducts.length, db: dbProductCount, eslesme: jsonProducts.length === dbProductCount },
    satislar: { json: jsonSales.length, db: dbSaleCount, eslesme: jsonSales.length <= dbSaleCount },
    stokToplami: { json: jsonStokTotal, db: dbStokTotal, eslesme: jsonStokTotal === dbStokTotal }
  };
}

// ============================================================
// VERİTABANI ERİŞİM FONKSİYONLARI
// ============================================================

// Para: Kuruş integer ↔ TL float dönüşümleri
const toKurus = (tl) => Math.round((parseFloat(tl) || 0) * 100);
const toTL = (kurus) => ((parseInt(kurus) || 0) / 100);

// KULLANICILAR
function getUserByUsername(username) {
  return getDb().prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
}

function getUserById(id) {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function getAllUsers() {
  return getDb().prepare("SELECT id, username, full_name, role, active, must_change_password, failed_login_attempts, locked_until, created_at FROM users ORDER BY created_at").all();
}

function createUser(user) {
  const db = getDb();
  const id = `USR-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  db.prepare(`
    INSERT INTO users(id, username, password_hash, full_name, role, active, must_change_password, session_version)
    VALUES (?, ?, ?, ?, ?, 1, 1, 0)
  `).run(id, user.username, user.passwordHash, user.fullName, user.role);
  logAudit({ userId: user.createdBy, username: user.createdByName, action: 'USER_CREATE',
    recordId: id, yeniDeger: JSON.stringify({ username: user.username, role: user.role }) });
  return id;
}

function updateUserPassword(userId, newHash, invalidateSessions = true) {
  const db = getDb();
  if (invalidateSessions) {
    db.prepare("UPDATE users SET password_hash=?, session_version=session_version+1, must_change_password=0, updated_at=datetime('now') WHERE id=?")
      .run(newHash, userId);
  } else {
    db.prepare("UPDATE users SET password_hash=?, must_change_password=0, updated_at=datetime('now') WHERE id=?")
      .run(newHash, userId);
  }
}

function recordFailedLogin(userId) {
  const db = getDb();
  const user = db.prepare("SELECT failed_login_attempts FROM users WHERE id=?").get(userId);
  const attempts = (user?.failed_login_attempts || 0) + 1;
  let lockedUntil = null;
  if (attempts >= 5) {
    // 15 dakika kilitle
    lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  }
  db.prepare("UPDATE users SET failed_login_attempts=?, locked_until=? WHERE id=?")
    .run(attempts, lockedUntil, userId);
  return { attempts, lockedUntil };
}

function clearFailedLogins(userId) {
  getDb().prepare("UPDATE users SET failed_login_attempts=0, locked_until=NULL WHERE id=?").run(userId);
}

function incrementSessionVersion(userId) {
  getDb().prepare("UPDATE users SET session_version=session_version+1 WHERE id=?").run(userId);
  return getDb().prepare("SELECT session_version FROM users WHERE id=?").get(userId)?.session_version;
}

// ÜRÜNLER
function getProducts(filters = {}) {
  const db = getDb();
  let query = `
    SELECT barcode, marka, model, renk, numara,
           alis_fiyati_kurus, satis_fiyati_kurus, kdv_orani,
           stok, min_stok, active, created_at
    FROM products WHERE 1=1
  `;
  const params = [];

  if (filters.activeOnly !== false) { query += ' AND active = 1'; }
  if (filters.search) {
    query += ' AND (barcode LIKE ? OR model LIKE ? OR marka LIKE ?)';
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.criticalOnly) { query += ' AND stok <= min_stok'; }

  query += ' ORDER BY marka, model, numara';
  return db.prepare(query).all(...params).map(formatProduct);
}

function getProductByBarcode(barcode) {
  const p = getDb().prepare("SELECT * FROM products WHERE barcode = ? AND active = 1").get(barcode);
  return p ? formatProduct(p) : null;
}

function formatProduct(row) {
  if (!row) return null;
  return {
    barkod: row.barcode,
    barcode: row.barcode,
    marka: row.marka,
    model: row.model,
    renk: row.renk,
    numara: row.numara,
    alisFiyati: toTL(row.alis_fiyati_kurus),
    satisFiyati: toTL(row.satis_fiyati_kurus),
    kdvOrani: row.kdv_orani,
    stok: row.stok,
    minStok: row.min_stok,
    aktif: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createProduct(prod, userId, username) {
  const db = getDb();
  db.prepare(`
    INSERT INTO products(barcode, marka, model, renk, numara,
      alis_fiyati_kurus, satis_fiyati_kurus, kdv_orani, stok, min_stok, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    prod.barkod, prod.marka || 'Genel', prod.model, prod.renk || 'Standart',
    prod.numara, toKurus(prod.alisFiyati), toKurus(prod.satisFiyati),
    prod.kdvOrani !== undefined ? prod.kdvOrani : 10, prod.stok || 0, prod.minStok || 2
  );

  // product_variants tablosuna da kaydet
  db.prepare(`
    INSERT OR REPLACE INTO product_variants(id, group_id, barcode, model, renk, numara, stok, alis_fiyati_kurus, satis_fiyati_kurus)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'VAR-' + prod.barkod, prod.barkod, prod.model, prod.renk || 'Standart',
    prod.numara, prod.stok || 0, toKurus(prod.alisFiyati), toKurus(prod.satisFiyati)
  );

  if (prod.stok > 0) {
    db.prepare(`
      INSERT INTO stock_movements(id, barcode, model, numara, islem_turu,
        onceki_stok, degisim, yeni_stok, aciklama, kullanici_id, kullanici_adi)
      VALUES (?, ?, ?, ?, 'BASLANGIC', 0, ?, ?, 'Yeni ürün açılış stoğu', ?, ?)
    `).run(crypto.randomUUID(), prod.barkod, prod.model, prod.numara,
      prod.stok, prod.stok, userId, username);
  }

  logAudit({ userId, username, action: 'PRODUCT_CREATE', recordId: prod.barkod,
    yeniDeger: JSON.stringify({ model: prod.model, stok: prod.stok }) });
}

function updateProduct(barcode, updates, userId, username) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM products WHERE barcode=?").get(barcode);
  if (!existing) throw new Error('Ürün bulunamadı');

  // Fiyat geçmişi kaydı (fiyat değişimi varsa)
  if (updates.alisFiyati !== undefined || updates.satisFiyati !== undefined) {
    const eskiAlis = existing.alis_fiyati_kurus;
    const yeniAlis = updates.alisFiyati !== undefined ? toKurus(updates.alisFiyati) : eskiAlis;
    const eskiSatis = existing.satis_fiyati_kurus;
    const yeniSatis = updates.satisFiyati !== undefined ? toKurus(updates.satisFiyati) : eskiSatis;
    if (eskiAlis !== yeniAlis || eskiSatis !== yeniSatis) {
      db.prepare(`
        INSERT INTO price_history(id, barcode, eski_alis_fiyati_kurus, yeni_alis_fiyati_kurus,
          eski_satis_fiyati_kurus, yeni_satis_fiyati_kurus, degistiren_id, degistiren_adi)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), barcode, eskiAlis, yeniAlis, eskiSatis, yeniSatis, userId, username);
    }
  }

  const fields = [];
  const vals = [];
  if (updates.marka !== undefined) { fields.push('marka=?'); vals.push(updates.marka); }
  if (updates.model !== undefined) { fields.push('model=?'); vals.push(updates.model); }
  if (updates.renk !== undefined) { fields.push('renk=?'); vals.push(updates.renk); }
  if (updates.numara !== undefined) { fields.push('numara=?'); vals.push(updates.numara); }
  if (updates.alisFiyati !== undefined) { fields.push('alis_fiyati_kurus=?'); vals.push(toKurus(updates.alisFiyati)); }
  if (updates.satisFiyati !== undefined) { fields.push('satis_fiyati_kurus=?'); vals.push(toKurus(updates.satisFiyati)); }
  if (updates.kdvOrani !== undefined) { fields.push('kdv_orani=?'); vals.push(updates.kdvOrani); }
  if (updates.minStok !== undefined) { fields.push('min_stok=?'); vals.push(updates.minStok); }
  if (updates.aktif !== undefined) { fields.push('active=?'); vals.push(updates.aktif ? 1 : 0); }

  if (fields.length === 0) return;
  fields.push("updated_at=datetime('now')");
  vals.push(barcode);

  db.prepare(`UPDATE products SET ${fields.join(',')} WHERE barcode=?`).run(...vals);

  // product_variants senkronizasyonu
  const varUpdates = [];
  const varVals = [];
  if (updates.model !== undefined) { varUpdates.push('model=?'); varVals.push(updates.model); }
  if (updates.renk !== undefined) { varUpdates.push('renk=?'); varVals.push(updates.renk); }
  if (updates.numara !== undefined) { varUpdates.push('numara=?'); varVals.push(updates.numara); }
  if (updates.alisFiyati !== undefined) { varUpdates.push('alis_fiyati_kurus=?'); varVals.push(toKurus(updates.alisFiyati)); }
  if (updates.satisFiyati !== undefined) { varUpdates.push('satis_fiyati_kurus=?'); varVals.push(toKurus(updates.satisFiyati)); }
  if (varUpdates.length > 0) {
    varUpdates.push("updated_at=datetime('now')");
    varVals.push(barcode);
    db.prepare(`UPDATE product_variants SET ${varUpdates.join(',')} WHERE barcode=?`).run(...varVals);
  }

  logAudit({ userId, username, action: 'PRODUCT_UPDATE', recordId: barcode,
    oncekiDeger: JSON.stringify({ satisFiyati: toTL(existing.satis_fiyati_kurus) }),
    yeniDeger: JSON.stringify(updates) });
}

// STOK HAREKETI
function adjustStock({ barcode, miktar, islemTuru, belgeNo, aciklama, userId, username }) {
  const db = getDb();
  const adjust = db.transaction(() => {
    // Pasif ürünlerin de stok güncellenebilmesi ve gerektiğinde aktif edilmesi için active kontrolü esnetildi
    const prod = db.prepare("SELECT stok, model, numara, active FROM products WHERE barcode=?").get(barcode);
    if (!prod) throw new Error('Ürün bulunamadı');

    if (prod.active === 0) {
      db.prepare("UPDATE products SET active=1 WHERE barcode=?").run(barcode);
    }

    const oncekiStok = prod.stok;
    let yeniStok, degisim;

    if (islemTuru === 'GIRIS') {
      degisim = Math.abs(parseInt(miktar, 10));
      yeniStok = oncekiStok + degisim;
    } else if (islemTuru === 'CIKIS') {
      degisim = -Math.abs(parseInt(miktar, 10));
      yeniStok = oncekiStok + degisim;
      if (yeniStok < 0) throw new Error(`Yetersiz stok! Mevcut: ${oncekiStok}`);
    } else if (islemTuru === 'SAYIM_DUZELTME') {
      yeniStok = Math.max(0, parseInt(miktar, 10));
      degisim = yeniStok - oncekiStok;
    } else {
      throw new Error(`Geçersiz işlem türü: ${islemTuru}`);
    }

    db.prepare("UPDATE products SET stok=?, updated_at=datetime('now') WHERE barcode=?").run(yeniStok, barcode);
    db.prepare("UPDATE product_variants SET stok=?, updated_at=datetime('now') WHERE barcode=?").run(yeniStok, barcode);
    db.prepare(`
      INSERT INTO stock_movements(id, barcode, model, numara, islem_turu,
        onceki_stok, degisim, yeni_stok, belge_no, aciklama, kullanici_id, kullanici_adi)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), barcode, prod.model, prod.numara, islemTuru,
      oncekiStok, degisim, yeniStok, belgeNo || null, aciklama || null, userId, username);

    logAudit({ userId, username, action: 'STOCK_ADJUSTMENT', recordId: barcode,
      oncekiDeger: String(oncekiStok), yeniDeger: String(yeniStok),
      details: `${islemTuru}: ${degisim > 0 ? '+' : ''}${degisim}` });

    return { oncekiStok, yeniStok, degisim };
  });

  return adjust();
}

// POS CHECKOUT — Tam atomik transaction
function posCheckout({ items, indirimTL, nakitTL, kartTL, musteriNotu, kasiyerId, kasiyerAdi, idempotencyKey }) {
  const db = getDb();

  const checkout = db.transaction(() => {
    // İdempotency kontrolü
    if (idempotencyKey) {
      const existing = db.prepare("SELECT fis_no FROM sales WHERE idempotency_key=?").get(idempotencyKey);
      if (existing) {
        const sale = db.prepare("SELECT * FROM sales WHERE fis_no=?").get(existing.fis_no);
        const kalemler = db.prepare("SELECT * FROM sale_items WHERE fis_no=?").all(existing.fis_no);
        return {
          alreadyExists: true,
          fisNo: existing.fis_no,
          sale,
          kalemler: kalemler.map(si => ({
            barkod: si.barcode, model: si.model, numara: si.numara,
            adet: si.adet, birimFiyat: toTL(si.birim_satis_kurus),
            toplamFiyat: toTL(si.toplam_satis_kurus)
          }))
        };
      }
    }

    // 1. Stok kontrolü (tüm ürünler için)
    for (const item of items) {
      const prod = db.prepare("SELECT stok, model, numara FROM products WHERE barcode=? AND active=1").get(item.barkod);
      if (!prod) throw new Error(`Barkod bulunamadı: ${item.barkod}`);
      if (prod.stok < item.adet) {
        throw new Error(`Yetersiz stok! '${prod.model}' (${prod.numara} No) - Mevcut: ${prod.stok}, Talep: ${item.adet}`);
      }
    }

    // 2. Tutarları hesapla
    let toplamBrutKurus = 0;
    let toplamMaliyetKurus = 0;
    let toplamKdvKurus = 0;
    const saleItems = [];

    for (const item of items) {
      const prod = db.prepare("SELECT * FROM products WHERE barcode=?").get(item.barkod);
      const adet = parseInt(item.adet, 10);
      const birimSatisKurus = prod.satis_fiyati_kurus;
      const birimAlisKurus = prod.alis_fiyati_kurus;
      const satirSatisKurus = birimSatisKurus * adet;
      const satirAlisKurus = birimAlisKurus * adet;
      // İç KDV: Tutar × KDV / (100 + KDV)
      const satirKdvKurus = Math.round(satirSatisKurus * prod.kdv_orani / (100 + prod.kdv_orani));

      toplamBrutKurus += satirSatisKurus;
      toplamMaliyetKurus += satirAlisKurus;
      toplamKdvKurus += satirKdvKurus;

      saleItems.push({ prod, adet, birimSatisKurus, birimAlisKurus,
        satirSatisKurus, satirAlisKurus, satirKdvKurus });
    }

    const indirimKurus = toKurus(indirimTL);
    const netSatisKurus = Math.max(0, toplamBrutKurus - indirimKurus);
    const nakitKurus = toKurus(nakitTL);
    const kartKurus = toKurus(kartTL);

    if (kartKurus > netSatisKurus) {
      throw new Error(`Kredi kartı tahsilatı net satış tutarından (₺${toTL(netSatisKurus)}) fazla olamaz!`);
    }

    const toplamOdemeKurus = nakitKurus + kartKurus;
    const netKarKurus = netSatisKurus - toplamKdvKurus - toplamMaliyetKurus;

    if (toplamOdemeKurus < netSatisKurus) {
      throw new Error(`Tahsilat yetersiz! Gereken: ₺${toTL(netSatisKurus)}, Alınan: ₺${toTL(toplamOdemeKurus)}`);
    }

    const paraUstuKurus = toplamOdemeKurus - netSatisKurus;
    let odemeTuru = 'Nakit';
    if (nakitKurus > 0 && kartKurus > 0) odemeTuru = 'Bölünmüş';
    else if (kartKurus > 0) odemeTuru = 'Kredi Kartı';

    const fisNo = `FIS-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const toplamKalemAdedi = saleItems.reduce((acc, i) => acc + i.adet, 0);

    // 3. Satış kaydı oluştur
    db.prepare(`
      INSERT INTO sales(fis_no, kasiyer_id, kasiyer_adi, toplam_brut_kurus,
        indirim_kurus, net_satis_kurus, toplam_maliyet_kurus, toplam_kdv_kurus,
        net_kar_kurus, toplam_kalem_adedi, odeme_turu, nakit_tahsilat_kurus,
        kart_tahsilat_kurus, para_ustu_kurus, musteri_notu, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fisNo, kasiyerId, kasiyerAdi, toplamBrutKurus, indirimKurus, netSatisKurus,
      toplamMaliyetKurus, toplamKdvKurus, netKarKurus, toplamKalemAdedi, odemeTuru,
      nakitKurus, kartKurus, paraUstuKurus, musteriNotu || null, idempotencyKey || null);

    // 4. Ödeme kayıtları oluştur (payments tablosu)
    if (nakitKurus > 0) {
      db.prepare(`
        INSERT INTO payments(id, fis_no, odeme_yontemi, tutar_kurus, para_ustu_kurus, referans_no, kasiyer_id)
        VALUES (?, ?, 'Nakit', ?, ?, NULL, ?)
      `).run(crypto.randomUUID(), fisNo, nakitKurus, paraUstuKurus, kasiyerId);
    }
    if (kartKurus > 0) {
      db.prepare(`
        INSERT INTO payments(id, fis_no, odeme_yontemi, tutar_kurus, para_ustu_kurus, referans_no, kasiyer_id)
        VALUES (?, ?, 'Kredi Kartı', ?, 0, 'POS-KART-KAYIT', ?)
      `).run(crypto.randomUUID(), fisNo, kartKurus, kasiyerId);
    }

    // 5. Satış kalemleri & stok güncelleme
    for (const si of saleItems) {
      const itemId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO sale_items(id, fis_no, barcode, model, numara, adet,
          birim_satis_kurus, birim_alis_kurus, toplam_satis_kurus,
          toplam_alis_kurus, kdv_orani, kdv_kurus)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(itemId, fisNo, si.prod.barcode, si.prod.model, si.prod.numara,
        si.adet, si.birimSatisKurus, si.birimAlisKurus, si.satirSatisKurus,
        si.satirAlisKurus, si.prod.kdv_orani, si.satirKdvKurus);

      // Stok düş
      const oncekiStok = si.prod.stok;
      const yeniStok = oncekiStok - si.adet;
      db.prepare("UPDATE products SET stok=?, updated_at=datetime('now') WHERE barcode=?")
        .run(yeniStok, si.prod.barcode);
      db.prepare("UPDATE product_variants SET stok=?, updated_at=datetime('now') WHERE barcode=?")
        .run(yeniStok, si.prod.barcode);

      // Stok hareketi
      db.prepare(`
        INSERT INTO stock_movements(id, barcode, model, numara, islem_turu,
          onceki_stok, degisim, yeni_stok, belge_no, aciklama, kullanici_id, kullanici_adi)
        VALUES (?, ?, ?, ?, 'SATIS', ?, ?, ?, ?, 'POS Satış', ?, ?)
      `).run(crypto.randomUUID(), si.prod.barcode, si.prod.model, si.prod.numara,
        oncekiStok, -si.adet, yeniStok, fisNo, kasiyerId, kasiyerAdi);
    }

    logAudit({ userId: kasiyerId, username: kasiyerAdi, action: 'POS_SALE', recordId: fisNo,
      yeniDeger: JSON.stringify({ netSatis: toTL(netSatisKurus), odemeTuru }),
      details: `${toplamKalemAdedi} çift, ₺${toTL(netSatisKurus)}` });

    return {
      alreadyExists: false,
      fisNo, odemeTuru,
      netSatisKurus, nakitKurus, kartKurus, paraUstuKurus,
      toplamBrutKurus, indirimKurus, toplamKdvKurus, netKarKurus,
      kalemler: saleItems.map(si => ({
        barkod: si.prod.barcode, model: si.prod.model, numara: si.prod.numara,
        adet: si.adet, birimFiyat: toTL(si.birimSatisKurus),
        toplamFiyat: toTL(si.satirSatisKurus)
      }))
    };
  });

  return checkout();
}

// İADE (Kısmi iade destekli)
function processRefund({ fisNo, refundItems, iadeNedeni, kasiyerId, kasiyerAdi }) {
  const db = getDb();

  const refund = db.transaction(() => {
    const sale = db.prepare("SELECT * FROM sales WHERE fis_no=?").get(fisNo);
    if (!sale) throw new Error('Satış fişi bulunamadı');
    if (sale.durum === 'IPTAL') throw new Error('İptal edilmiş satış iade edilemez');

    let toplamIadeKurus = 0;

    for (const ri of refundItems) {
      const saleItem = db.prepare("SELECT * FROM sale_items WHERE id=? AND fis_no=?")
        .get(ri.saleItemId, fisNo);
      if (!saleItem) throw new Error(`Satış kalemi bulunamadı: ${ri.saleItemId}`);

      const kalan = saleItem.adet - saleItem.iade_edilen_adet;
      if (ri.adet > kalan) {
        throw new Error(`İade miktarı aşıldı! '${saleItem.model}' için kalan iade edilebilir: ${kalan}`);
      }

      // Sepet genel indirimini orantılı olarak iade tutarından düş (fazla para iadesini engelle)
      const brutBirimFiyat = Math.round(saleItem.toplam_satis_kurus / saleItem.adet);
      let iadeBirimFiyat = brutBirimFiyat;
      if (sale.toplam_brut_kurus > 0 && sale.indirim_kurus > 0) {
        const indirimOrani = sale.indirim_kurus / sale.toplam_brut_kurus;
        iadeBirimFiyat = Math.round(brutBirimFiyat * (1 - indirimOrani));
      }
      const iadeTutariKurus = iadeBirimFiyat * ri.adet;
      toplamIadeKurus += iadeTutariKurus;

      // İade kaydı
      db.prepare(`
        INSERT INTO returns(id, fis_no, sale_item_id, iade_adet, iade_tutari_kurus,
          iade_nedeni, stoğa_donus, kasiyer_id, kasiyer_adi)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), fisNo, ri.saleItemId, ri.adet, iadeTutariKurus,
        iadeNedeni || 'Belirtilmedi', ri.stoğaDonus !== false ? 1 : 0, kasiyerId, kasiyerAdi);

      // Satış kalemindeki iade sayacını güncelle
      db.prepare("UPDATE sale_items SET iade_edilen_adet=iade_edilen_adet+? WHERE id=?")
        .run(ri.adet, ri.saleItemId);

      // Stoğa geri dön
      if (ri.stoğaDonus !== false) {
        const prod = db.prepare("SELECT stok FROM products WHERE barcode=?").get(saleItem.barcode);
        if (prod) {
          const yeniStok = prod.stok + ri.adet;
          db.prepare("UPDATE products SET stok=?, updated_at=datetime('now') WHERE barcode=?")
            .run(yeniStok, saleItem.barcode);
          db.prepare("UPDATE product_variants SET stok=?, updated_at=datetime('now') WHERE barcode=?")
            .run(yeniStok, saleItem.barcode);
          db.prepare(`
            INSERT INTO stock_movements(id, barcode, model, numara, islem_turu,
              onceki_stok, degisim, yeni_stok, belge_no, aciklama, kullanici_id, kullanici_adi)
            VALUES (?, ?, ?, ?, 'IADE', ?, ?, ?, ?, ?, ?, ?)
          `).run(crypto.randomUUID(), saleItem.barcode, saleItem.model, saleItem.numara,
            prod.stok, ri.adet, yeniStok, fisNo,
            `İade: ${iadeNedeni || 'Belirtilmedi'}`, kasiyerId, kasiyerAdi);
        }
      }
    }

    // Satış durumunu güncelle
    const allItems = db.prepare("SELECT adet, iade_edilen_adet FROM sale_items WHERE fis_no=?").all(fisNo);
    const tamIade = allItems.every(i => i.adet === i.iade_edilen_adet);
    db.prepare("UPDATE sales SET durum=? WHERE fis_no=?")
      .run(tamIade ? 'KISMI_IADE' : 'KISMI_IADE', fisNo);

    logAudit({ userId: kasiyerId, username: kasiyerAdi, action: 'SALE_REFUND', recordId: fisNo,
      details: `İade tutarı: ₺${toTL(toplamIadeKurus)}, Neden: ${iadeNedeni}` });

    return { fisNo, toplamIadeKurus, tamIade };
  });

  return refund();
}

// SATIŞ İPTALİ (Tam iptal & stokların geri yüklenmesi)
function cancelSale({ fisNo, iptalNedeni, userId, username }) {
  const db = getDb();

  const cancel = db.transaction(() => {
    const sale = db.prepare("SELECT * FROM sales WHERE fis_no=?").get(fisNo);
    if (!sale) throw new Error('Satış fişi bulunamadı');
    if (sale.durum === 'IPTAL') throw new Error('Satış fişi zaten iptal edilmiş');

    const items = db.prepare("SELECT * FROM sale_items WHERE fis_no=?").all(fisNo);
    for (const item of items) {
      const kalanAdet = item.adet - item.iade_edilen_adet;
      if (kalanAdet > 0) {
        const prod = db.prepare("SELECT stok, model, numara FROM products WHERE barcode=?").get(item.barcode);
        if (prod) {
          const oncekiStok = prod.stok;
          const yeniStok = oncekiStok + kalanAdet;
          db.prepare("UPDATE products SET stok=?, updated_at=datetime('now') WHERE barcode=?")
            .run(yeniStok, item.barcode);
          db.prepare("UPDATE product_variants SET stok=?, updated_at=datetime('now') WHERE barcode=?")
            .run(yeniStok, item.barcode);

          db.prepare(`
            INSERT INTO stock_movements(id, barcode, model, numara, islem_turu,
              onceki_stok, degisim, yeni_stok, belge_no, aciklama, kullanici_id, kullanici_adi)
            VALUES (?, ?, ?, ?, 'IPTAL', ?, ?, ?, ?, ?, ?, ?)
          `).run(crypto.randomUUID(), item.barcode, prod.model, prod.numara,
            oncekiStok, kalanAdet, yeniStok, fisNo, `Satış İptali: ${iptalNedeni || 'Müşteri talebi'}`, userId, username);
        }
      }
    }

    db.prepare(`
      UPDATE sales SET
        durum='IPTAL',
        iptal_tarihi=datetime('now'),
        iptal_nedeni=?,
        iptal_kasiyer_id=?,
        iptal_kasiyer_adi=?
      WHERE fis_no=?
    `).run(iptalNedeni || 'Belirtilmedi', userId, username, fisNo);

    logAudit({
      userId, username,
      action: 'SALE_CANCEL',
      recordId: fisNo,
      oncekiDeger: JSON.stringify({ durum: sale.durum, netSatisKurus: sale.net_satis_kurus }),
      yeniDeger: JSON.stringify({ durum: 'IPTAL', iptalNedeni }),
      details: `Satış fişi iptal edildi: ${fisNo} - Sebep: ${iptalNedeni || 'Belirtilmedi'}`
    });

    return { fisNo, durum: 'IPTAL', iptalNedeni };
  });

  return cancel();
}

// SATIŞ SORGULAMA
function getSales(filters = {}) {
  const db = getDb();
  let q = `SELECT s.*, GROUP_CONCAT(si.model || ' (' || si.numara || ') x' || si.adet, ', ') as kalem_ozet
           FROM sales s LEFT JOIN sale_items si ON s.fis_no = si.fis_no WHERE 1=1`;
  const params = [];

  if (filters.dateFrom) { q += ` AND s.tarih >= ?`; params.push(`${filters.dateFrom}T00:00:00`); }
  if (filters.dateTo) { q += ` AND s.tarih <= ?`; params.push(`${filters.dateTo}T23:59:59`); }
  if (filters.durum) { q += ` AND s.durum = ?`; params.push(filters.durum); }
  if (filters.search) {
    q += ` AND (s.fis_no LIKE ? OR s.kasiyer_adi LIKE ? OR si.model LIKE ?)`;
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }

  q += ` GROUP BY s.fis_no ORDER BY s.tarih DESC`;
  if (filters.limit) { q += ` LIMIT ?`; params.push(filters.limit); }

  return db.prepare(q).all(...params).map(s => ({
    ...s,
    fisNo: s.fis_no,
    kasiyerAdi: s.kasiyer_adi,
    kasiyerId: s.kasiyer_id,
    odemeTuru: s.odeme_turu,
    musteriNotu: s.musteri_notu,
    toplamKalemAdedi: s.toplam_kalem_adedi,
    netSatis: toTL(s.net_satis_kurus),
    toplamBrut: toTL(s.toplam_brut_kurus),
    indirim: toTL(s.indirim_kurus),
    toplamKdv: toTL(s.toplam_kdv_kurus),
    netKar: toTL(s.net_kar_kurus),
    nakitTahsilat: toTL(s.nakit_tahsilat_kurus),
    kartTahsilat: toTL(s.kart_tahsilat_kurus),
    paraUstu: toTL(s.para_ustu_kurus),
    kalemler: s.kalem_ozet ? s.kalem_ozet.split(', ').map(k => ({ model: k, numara: '' })) : []
  }));
}

function getSaleWithItems(fisNo) {
  const db = getDb();
  const sale = db.prepare("SELECT * FROM sales WHERE fis_no=?").get(fisNo);
  if (!sale) return null;
  const items = db.prepare("SELECT * FROM sale_items WHERE fis_no=?").all(fisNo);
  const returns = db.prepare("SELECT * FROM returns WHERE fis_no=?").all(fisNo);
  return { ...sale, kalemler: items, iadeler: returns };
}

// DASHBOARD İSTATİSTİKLERİ
function getDashboardStats({ dateFrom, dateTo } = {}) {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const start = dateFrom || today;
  const end = dateTo || today;

  const stats = db.prepare(`
    SELECT
      COALESCE(SUM(net_satis_kurus), 0) as ciro_kurus,
      COALESCE(SUM(net_kar_kurus), 0) as kar_kurus,
      COALESCE(SUM(toplam_kdv_kurus), 0) as kdv_kurus,
      COALESCE(SUM(toplam_maliyet_kurus), 0) as maliyet_kurus,
      COALESCE(SUM(toplam_kalem_adedi), 0) as toplam_cift,
      COALESCE(SUM(nakit_tahsilat_kurus), 0) as nakit_kurus,
      COALESCE(SUM(kart_tahsilat_kurus), 0) as kart_kurus,
      COUNT(*) as islem_sayisi
    FROM sales
    WHERE durum IN ('TAMAMLANDI', 'KISMI_IADE')
      AND tarih >= ? AND tarih <= ?
  `).get(`${start}T00:00:00`, `${end}T23:59:59`);

  const starProducts = db.prepare(`
    SELECT si.model || ' (' || si.numara || ')' as model, SUM(si.adet) as adet
    FROM sale_items si JOIN sales s ON si.fis_no = s.fis_no
    WHERE s.durum IN ('TAMAMLANDI', 'KISMI_IADE') AND s.tarih >= ? AND s.tarih <= ?
    GROUP BY si.barcode ORDER BY adet DESC LIMIT 5
  `).all(`${start}T00:00:00`, `${end}T23:59:59`);

  const criticalStock = db.prepare(`
    SELECT barcode, marka, model, renk, numara, stok, min_stok
    FROM products WHERE active=1 AND stok <= min_stok ORDER BY stok ASC LIMIT 20
  `).all().map(p => ({
    barkod: p.barcode, marka: p.marka, model: p.model, numara: p.numara,
    stok: p.stok, minStok: p.min_stok,
    mesaj: `${p.numara} numara ${p.model}'dan son ${p.stok} adet kaldı!`
  }));

  const recentSales = getSales({ dateFrom: start, dateTo: end, limit: 8 });
  const recentMovements = db.prepare(`
    SELECT * FROM stock_movements ORDER BY created_at DESC LIMIT 8
  `).all();

  const ciro = toTL(stats.ciro_kurus);
  const netKar = toTL(stats.kar_kurus);
  const nakit = toTL(stats.nakit_kurus);
  const kart = toTL(stats.kart_kurus);
  const totalPay = nakit + kart;

  return {
    ciro, netKar,
    karMarji: ciro > 0 ? Number(((netKar / ciro) * 100).toFixed(1)) : 0,
    toplamKdv: toTL(stats.kdv_kurus),
    toplamMaliyet: toTL(stats.maliyet_kurus),
    toplamCift: stats.toplam_cift,
    islemSayisi: stats.islem_sayisi,
    nakitTahsilat: nakit, kartTahsilat: kart,
    nakitYuzde: totalPay > 0 ? Math.round((nakit / totalPay) * 100) : 50,
    kartYuzde: totalPay > 0 ? Math.round((kart / totalPay) * 100) : 50,
    starProducts, criticalStock, recentSales, recentMovements
  };
}

// STOK HAREKETLERİ
function getStockMovements(filters = {}) {
  const db = getDb();
  let q = "SELECT * FROM stock_movements WHERE 1=1";
  const params = [];
  if (filters.barcode) { q += " AND barcode=?"; params.push(filters.barcode); }
  q += " ORDER BY created_at DESC";
  if (filters.limit) { q += " LIMIT ?"; params.push(parseInt(filters.limit, 10)); }
  return db.prepare(q).all(...params);
}

// AYARLAR
function getSetting(key) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value, userId, username) {
  const db = getDb();
  const existing = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  db.prepare(`
    INSERT INTO settings(key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by
  `).run(key, String(value), `${userId}:${username}`);

  if (userId) {
    logAudit({ userId, username, action: 'SETTINGS_UPDATE', recordId: key,
      oncekiDeger: existing?.value, yeniDeger: String(value) });
  }
}

function getAllSettings() {
  const rows = getDb().prepare("SELECT key, value FROM settings").all();
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });
  return result;
}

// DENETİM GÜNLÜĞÜ
function logAudit({ userId, username, action, recordId, oncekiDeger, yeniDeger, sonuc, ipAdresi, details }) {
  try {
    getDb().prepare(`
      INSERT INTO audit_logs(id, user_id, username, action, record_id,
        onceki_deger, yeni_deger, sonuc, ip_adresi, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(), userId || null, username || 'Sistem', action,
      recordId || null, oncekiDeger || null, yeniDeger || null,
      sonuc || 'BASARILI', ipAdresi || null, details || null
    );
  } catch (e) {
    // Audit log hatası uygulamayı durdurmamalı
    console.error('[AUDIT ERROR]', e.message);
  }
}

function getAuditLogs(limit = 150) {
  return getDb().prepare("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?").all(limit);
}

// KASA İŞLEMLERİ
function openCashSession({ kasiyerId, kasiyerAdi, acilisNakitTL }) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM cash_sessions WHERE durum='ACIK'").get();
  if (existing) throw new Error('Zaten açık bir kasa oturumu var. Önce gün sonu yapın.');

  const id = `KASA-${Date.now()}`;
  db.prepare(`
    INSERT INTO cash_sessions(id, acilis_tarihi, acilis_nakdi_kurus, acilis_kasiyer_id, acilis_kasiyer_adi, nakit_giris_kurus, nakit_cikis_kurus)
    VALUES (?, datetime('now'), ?, ?, ?, 0, 0)
  `).run(id, toKurus(acilisNakitTL), kasiyerId, kasiyerAdi);
  logAudit({ userId: kasiyerId, username: kasiyerAdi, action: 'CASH_SESSION_OPEN', recordId: id,
    details: `Açılış nakdi: ₺${acilisNakitTL}` });
  return id;
}

function addCashTransaction({ sessionId, islemTuru, tutarTL, kategori, aciklama, userId, username }) {
  const db = getDb();
  const tx = db.transaction(() => {
    const session = db.prepare("SELECT * FROM cash_sessions WHERE id=? AND durum='ACIK'").get(sessionId);
    if (!session) throw new Error('Açık kasa oturumu bulunamadı');

    const tutarKurus = toKurus(tutarTL);
    if (tutarKurus <= 0) throw new Error('İşlem tutarı 0\'dan büyük olmalıdır.');

    const txId = `CTX-${Date.now()}`;
    db.prepare(`
      INSERT INTO cash_transactions(id, session_id, islem_turu, tutar_kurus, kategori, aciklama, kullanici_id, kullanici_adi)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(txId, sessionId, islemTuru, tutarKurus, kategori || 'Genel', aciklama || null, userId, username);

    if (islemTuru === 'GIRIS') {
      db.prepare("UPDATE cash_sessions SET nakit_giris_kurus=nakit_giris_kurus+? WHERE id=?").run(tutarKurus, sessionId);
    } else {
      db.prepare("UPDATE cash_sessions SET nakit_cikis_kurus=nakit_cikis_kurus+? WHERE id=?").run(tutarKurus, sessionId);
    }

    logAudit({ userId, username, action: `CASH_${islemTuru}`, recordId: txId,
      details: `${islemTuru}: ₺${tutarTL} - ${aciklama || kategori}` });

    return { txId, islemTuru, tutarTL, kategori, aciklama };
  });

  return tx();
}

function getCashTransactions(sessionId) {
  return getDb().prepare("SELECT * FROM cash_transactions WHERE session_id=? ORDER BY created_at DESC").all(sessionId);
}

function closeCashSession({ sessionId, sayilanNakitTL, kapanisKasiyerId, kapanisKasiyerAdi, kapanisNotu }) {
  const db = getDb();

  const close = db.transaction(() => {
    const session = db.prepare("SELECT * FROM cash_sessions WHERE id=? AND durum='ACIK'").get(sessionId);
    if (!session) throw new Error('Açık kasa oturumu bulunamadı');

    // Satış istatistikleri (kısmi iadeli satışlar dahil)
    const stats = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN odeme_turu != 'Kredi Kartı' THEN nakit_tahsilat_kurus ELSE 0 END), 0) as nakit_satis,
        COALESCE(SUM(kart_tahsilat_kurus), 0) as kart_satis
      FROM sales WHERE durum IN ('TAMAMLANDI', 'KISMI_IADE') AND tarih >= ?
    `).get(session.acilis_tarihi);

    // İade istatistikleri (BUG-02 Düzeltmesi: r.created_at ile filtrelenir)
    const iadeStats = db.prepare(`
      SELECT COALESCE(SUM(iade_tutari_kurus), 0) as iade_toplam
      FROM returns WHERE created_at >= ?
    `).get(session.acilis_tarihi);

    // Kasa içi nakit giriş/çıkış toplamı
    const txStats = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN islem_turu='GIRIS' THEN tutar_kurus ELSE 0 END), 0) as giris_toplam,
        COALESCE(SUM(CASE WHEN islem_turu='CIKIS' THEN tutar_kurus ELSE 0 END), 0) as cikis_toplam
      FROM cash_transactions WHERE session_id=?
    `).get(sessionId);

    const nakitSatisKurus = stats.nakit_satis;
    const kartSatisKurus = stats.kart_satis;
    const iadeKurus = iadeStats.iade_toplam;
    const nakitGirisKurus = txStats.giris_toplam;
    const nakitCikisKurus = txStats.cikis_toplam;

    // Formül: Beklenen Nakit = Açılış Nakdi + Nakit Satışlar + Nakit Girişleri - Nakit İadeler - Nakit Çıkışları
    const beklenenNakit = session.acilis_nakdi_kurus + nakitSatisKurus + nakitGirisKurus - iadeKurus - nakitCikisKurus;
    const sayilanKurus = toKurus(sayilanNakitTL);
    const farkKurus = sayilanKurus - beklenenNakit;

    db.prepare(`
      UPDATE cash_sessions SET
        kapanis_tarihi=datetime('now'), kapanis_kasiyer_id=?, kapanis_kasiyer_adi=?,
        nakit_satis_kurus=?, kart_satis_kurus=?, iade_kurus=?,
        nakit_giris_kurus=?, nakit_cikis_kurus=?,
        beklenen_nakit_kurus=?, sayilan_nakit_kurus=?, kasa_farki_kurus=?,
        kapanis_notu=?, durum='KAPALI'
      WHERE id=?
    `).run(kapanisKasiyerId, kapanisKasiyerAdi, nakitSatisKurus, kartSatisKurus,
      iadeKurus, nakitGirisKurus, nakitCikisKurus, beklenenNakit, sayilanKurus, farkKurus, kapanisNotu || null, sessionId);

    logAudit({ userId: kapanisKasiyerId, username: kapanisKasiyerAdi,
      action: 'CASH_SESSION_CLOSE', recordId: sessionId,
      details: `Beklenen: ₺${toTL(beklenenNakit)}, Sayılan: ₺${toTL(sayilanKurus)}, Kasa farkı: ₺${toTL(farkKurus)}` });

    return {
      nakitSatis: toTL(nakitSatisKurus), kartSatis: toTL(kartSatisKurus),
      iade: toTL(iadeKurus), nakitGiris: toTL(nakitGirisKurus), nakitCikis: toTL(nakitCikisKurus),
      beklenenNakit: toTL(beklenenNakit), sayilanNakit: toTL(sayilanKurus), kasaFarki: toTL(farkKurus)
    };
  });

  return close();
}

function getActiveCashSession() {
  return getDb().prepare("SELECT * FROM cash_sessions WHERE durum='ACIK' ORDER BY acilis_tarihi DESC LIMIT 1").get();
}

function getCashSessions(limit = 30) {
  return getDb().prepare("SELECT * FROM cash_sessions ORDER BY created_at DESC LIMIT ?").all(limit);
}

// YEDEKLEME
async function createBackup(userId, username) {
  const db = getDb();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folderName = `backup_${timestamp}`;
  const backupPath = path.join(BACKUPS_DIR, folderName);
  fs.mkdirSync(backupPath, { recursive: true });

  // SQLite online backup API kullan (WAL-safe, Promise döndürür)
  const backupFile = path.join(backupPath, 'yagzshoes.db');
  await db.backup(backupFile);

  // Hash doğrulama
  const fileBuffer = fs.readFileSync(backupFile);
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const boyut = fileBuffer.length;

  // Metadata dosyası
  fs.writeFileSync(path.join(backupPath, 'backup_meta.json'), JSON.stringify({
    timestamp, folderName, hash_sha256: hash, boyut_bayt: boyut,
    olusturan: username, version: '2.0'
  }, null, 2));

  // Kayıt
  const backupId = `BKP-${Date.now()}`;
  db.prepare(`
    INSERT INTO backup_history(id, klasor_adi, boyut_bayt, hash_sha256, olusturan_kullanici)
    VALUES (?, ?, ?, ?, ?)
  `).run(backupId, folderName, boyut, hash, username);

  logAudit({ userId, username, action: 'BACKUP_CREATE', recordId: backupId,
    details: `Yedek: ${folderName}, Hash: ${hash.substring(0, 16)}...` });

  return { folderName, hash, boyut };
}

function listBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const metaPath = path.join(BACKUPS_DIR, d.name, 'backup_meta.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
      const stat = fs.statSync(path.join(BACKUPS_DIR, d.name));
      return { name: d.name, date: stat.mtime.toISOString(), ...meta };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

async function restoreBackup(folderName, userId, username) {
  const safeName = path.basename(folderName);
  const backupPath = path.join(BACKUPS_DIR, safeName);
  const backupDb = path.join(backupPath, 'yagzshoes.db');
  const metaPath = path.join(backupPath, 'backup_meta.json');

  if (!fs.existsSync(backupDb)) throw new Error('Yedek veritabanı dosyası bulunamadı');

  // Hash doğrulama
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const currentHash = crypto.createHash('sha256')
      .update(fs.readFileSync(backupDb)).digest('hex');
    if (meta.hash_sha256 && meta.hash_sha256 !== currentHash) {
      throw new Error('Yedek bütünlük kontrolü BAŞARISIZ! Dosya bozulmuş olabilir.');
    }
  }

  // Mevcut DB'nin güvenlik yedeğini al
  const safetyName = `pre_restore_${Date.now()}`;
  const safetyPath = path.join(BACKUPS_DIR, safetyName);
  fs.mkdirSync(safetyPath, { recursive: true });

  // Mevcut DB kapat ve yedekle
  if (db) {
    await db.backup(path.join(safetyPath, 'yagzshoes.db'));
    db.close();
    db = null;
  }

  // Yedek dosyasını geri yükle
  fs.copyFileSync(backupDb, DB_PATH);
  try { if (fs.existsSync(DB_PATH + '-wal')) fs.unlinkSync(DB_PATH + '-wal'); } catch (_) {}
  try { if (fs.existsSync(DB_PATH + '-shm')) fs.unlinkSync(DB_PATH + '-shm'); } catch (_) {}

  // DB'yi yeniden aç ve şema doğrula
  db = null;
  const currentDb = getDb();
  const userCount = currentDb.prepare("SELECT COUNT(*) as cnt FROM users").get().cnt;

  if (userCount === 0) {
    // Yedek bozuk - geri dön
    if (db) { db.close(); db = null; }
    fs.copyFileSync(path.join(safetyPath, 'yagzshoes.db'), DB_PATH);
    db = getDb();
    throw new Error('Geri yükleme doğrulaması başarısız. Orijinal veritabanı korundu.');
  }

  logAudit({ userId, username, action: 'RESTORE_EXECUTED',
    details: `${safeName} yedeğinden geri yüklendi. Güvenlik yedeği: ${safetyName}` });

  return { safetyBackup: safetyName };
}

// EXCEL SYNC GEÇMİŞİ
function recordSyncHistory(entry) {
  return getDb().prepare(`
    INSERT INTO backup_history(id, klasor_adi, olusturan_kullanici, durum, boyut_bayt)
    VALUES (?, ?, ?, 'SYNC', ?)
  `).run(`SYNC-${Date.now()}`, entry.dosyaAdi || 'excel-sync', entry.kullanici, 0);
}

function getSyncHistory() {
  return getDb().prepare(`
    SELECT * FROM backup_history WHERE durum='SYNC' OR klasor_adi LIKE '%.xlsx%' OR klasor_adi LIKE '%.csv%'
    ORDER BY timestamp DESC LIMIT 50
  `).all();
}

// ============================================================
// STOK SAYIMI (INVENTORY COUNT & DISCREPANCY)
// ============================================================
function createStockCount({ items, aciklama, userId, username }) {
  const db = getDb();
  const countTx = db.transaction(() => {
    const countId = `SAYIM-${Date.now()}`;
    let toplamFarkAdet = 0;

    db.prepare(`
      INSERT INTO stock_counts(id, sayim_tarihi, kullanici_id, kullanici_adi, durum, toplam_fark_adet, aciklama)
      VALUES (?, datetime('now'), ?, ?, 'TAMAMLANDI', 0, ?)
    `).run(countId, userId, username, aciklama || 'Genel Stok Sayımı');

    for (const item of items) {
      const prod = db.prepare("SELECT barcode, model, numara, stok FROM products WHERE barcode=?").get(item.barcode);
      if (!prod) continue;

      const sayilan = parseInt(item.sayilanAdet, 10);
      const sistemStok = prod.stok;
      const fark = sayilan - sistemStok;
      toplamFarkAdet += Math.abs(fark);

      db.prepare(`
        INSERT INTO stock_count_items(id, count_id, barcode, model, numara, sistem_stok, sayilan_stok, fark)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), countId, prod.barcode, prod.model, prod.numara, sistemStok, sayilan, fark);

      if (fark !== 0) {
        db.prepare("UPDATE products SET stok=?, updated_at=datetime('now') WHERE barcode=?").run(sayilan, prod.barcode);
        db.prepare("UPDATE product_variants SET stok=?, updated_at=datetime('now') WHERE barcode=?").run(sayilan, prod.barcode);

        db.prepare(`
          INSERT INTO stock_movements(id, barcode, model, numara, islem_turu,
            onceki_stok, degisim, yeni_stok, belge_no, aciklama, kullanici_id, kullanici_adi)
          VALUES (?, ?, ?, ?, 'SAYIM_DUZELTME', ?, ?, ?, ?, 'Stok Sayım Farkı Düzeltmesi', ?, ?)
        `).run(crypto.randomUUID(), prod.barcode, prod.model, prod.numara,
          sistemStok, fark, sayilan, countId, userId, username);
      }
    }

    db.prepare("UPDATE stock_counts SET toplam_fark_adet=? WHERE id=?").run(toplamFarkAdet, countId);

    logAudit({ userId, username, action: 'STOCK_COUNT', recordId: countId,
      details: `Stok sayımı tamamlandı: ${items.length} kalem, toplam fark: ${toplamFarkAdet} adet` });

    return { countId, toplamFarkAdet, itemCount: items.length };
  });

  return countTx();
}

function getStockCounts(limit = 30) {
  return getDb().prepare("SELECT * FROM stock_counts ORDER BY sayim_tarihi DESC LIMIT ?").all(limit);
}

function getStockCountDetail(countId) {
  const db = getDb();
  const count = db.prepare("SELECT * FROM stock_counts WHERE id=?").get(countId);
  if (!count) return null;
  const items = db.prepare("SELECT * FROM stock_count_items WHERE count_id=?").all(countId);
  return { ...count, items };
}

// ============================================================
// FİYAT GEÇMİŞİ
// ============================================================
function getPriceHistory(barcode) {
  return getDb().prepare(`
    SELECT ph.*, p.model, p.numara
    FROM price_history ph
    JOIN products p ON ph.barcode = p.barcode
    WHERE ph.barcode = ?
    ORDER BY ph.created_at DESC
  `).all(barcode).map(r => ({
    ...r,
    eskiAlisFiyati: toTL(r.eski_alis_fiyati_kurus),
    yeniAlisFiyati: toTL(r.yeni_alis_fiyati_kurus),
    eskiSatisFiyati: toTL(r.eski_satis_fiyati_kurus),
    yeniSatisFiyati: toTL(r.yeni_satis_fiyati_kurus)
  }));
}

// ============================================================
// KULLANICI YÖNETİMİ EK İŞLEMLERİ
// ============================================================
function toggleUserStatus(userId, active, adminId, adminUsername) {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!user) throw new Error('Kullanıcı bulunamadı');
  if (user.role === 'admin' && !active) {
    const adminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role='admin' AND active=1").get()?.cnt || 0;
    if (adminCount <= 1) throw new Error('Son aktif yönetici hesabı devre dışı bırakılamaz.');
  }

  const newStatus = active ? 1 : 0;
  db.prepare("UPDATE users SET active=?, session_version=session_version+1, updated_at=datetime('now') WHERE id=?")
    .run(newStatus, userId);

  logAudit({
    userId: adminId, username: adminUsername,
    action: newStatus ? 'USER_ACTIVATE' : 'USER_DEACTIVATE',
    recordId: userId,
    details: `${user.username} hesabı ${newStatus ? 'aktif' : 'pasif'} yapıldı`
  });

  return { userId, active: newStatus === 1 };
}

function updateUserRole(userId, newRole, adminId, adminUsername) {
  const db = getDb();
  const validRoles = ['admin', 'kasiyer', 'stok_sorumlusu', 'rapor_goruntuleme'];
  if (!validRoles.includes(newRole)) throw new Error('Geçersiz kullanıcı rolü.');

  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!user) throw new Error('Kullanıcı bulunamadı');

  if (user.role === 'admin' && newRole !== 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role='admin' AND active=1").get()?.cnt || 0;
    if (adminCount <= 1) throw new Error('Son aktif yönetici hesabının rolü değiştirilemez.');
  }

  db.prepare("UPDATE users SET role=?, session_version=session_version+1, updated_at=datetime('now') WHERE id=?")
    .run(newRole, userId);

  logAudit({
    userId: adminId, username: adminUsername,
    action: 'USER_ROLE_CHANGE',
    recordId: userId,
    oncekiDeger: user.role, yeniDeger: newRole,
    details: `${user.username} rolü değiştirildi: ${newRole}`
  });

  return { userId, role: newRole };
}

// ============================================================
// KURULUM DURUMU & İLK KURULUM
// ============================================================
function getSetupStatus() {
  const db = getDb();
  const setupSetting = db.prepare("SELECT value FROM settings WHERE key='setup_tamamlandi'").get();
  const adminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role='admin' AND active=1").get()?.cnt || 0;
  const isComplete = setupSetting?.value === '1' && adminCount > 0;
  return { isSetupComplete: isComplete, hasAdmin: adminCount > 0 };
}

function setupInitialAdmin({ username, password, fullName, magazaAdi }) {
  const db = getDb();
  const setup = db.transaction(() => {
    const status = getSetupStatus();
    if (status.isSetupComplete) {
      throw new Error('Sistem ilk kurulumu zaten tamamlanmış.');
    }
    const bcrypt = require('bcryptjs');
    const adminHash = bcrypt.hashSync(password, 12);
    const adminId = 'USR-ADMIN-01';

    const existingUser = db.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").get(username);
    if (existingUser) {
      db.prepare(`
        UPDATE users SET
          username=?, password_hash=?, full_name=?, role='admin', active=1,
          must_change_password=0, failed_login_attempts=0, session_version=session_version+1,
          updated_at=datetime('now')
        WHERE id=?
      `).run(username, adminHash, fullName || 'Sistem Yöneticisi', existingUser.id);
    } else {
      db.prepare(`
        INSERT INTO users(id, username, password_hash, full_name, role, active, must_change_password, session_version)
        VALUES (?, ?, ?, ?, 'admin', 1, 0, 0)
      `).run(adminId, username, adminHash, fullName || 'Sistem Yöneticisi');
    }

    if (magazaAdi) {
      db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('magaza_adi', ?)").run(magazaAdi);
    }
    db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('setup_tamamlandi', '1')").run();

    logAudit({
      userId: existingUser?.id || adminId,
      username,
      action: 'SYSTEM_SETUP',
      details: 'Güvenli ilk yönetici kurulumu tamamlandı.'
    });

    return getUserById(existingUser?.id || adminId);
  });

  return setup();
}

module.exports = {
  getDb, initSchema, migrateFromJSON, validateMigration,
  // Kullanıcılar
  getUserByUsername, getUserById, getAllUsers, createUser,
  updateUserPassword, recordFailedLogin, clearFailedLogins, incrementSessionVersion,
  toggleUserStatus, updateUserRole,
  // Kurulum
  getSetupStatus, setupInitialAdmin,
  // Ürünler
  getProducts, getProductByBarcode, createProduct, updateProduct,
  // Fiyat Geçmişi & Sayım
  getPriceHistory, createStockCount, getStockCounts, getStockCountDetail,
  // Stok
  adjustStock, getStockMovements,
  // Satış & İptal & İade
  posCheckout, cancelSale, getSales, getSaleWithItems, processRefund,
  // Dashboard
  getDashboardStats,
  // Ayarlar
  getSetting, setSetting, getAllSettings,
  // Denetim
  logAudit, getAuditLogs,
  // Kasa
  openCashSession, closeCashSession, getActiveCashSession, getCashSessions,
  addCashTransaction, getCashTransactions,
  // Yedek
  createBackup, listBackups, restoreBackup,
  // Sync
  recordSyncHistory, getSyncHistory,
  toKurus, toTL,
  DB_PATH, BACKUPS_DIR
};
