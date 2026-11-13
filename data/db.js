const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DB_DIR = path.join(__dirname, '..', 'data');
const BACKUPS_DIR = path.join(__dirname, '..', 'backups');

const PRODUCTS_FILE = path.join(DB_DIR, 'products.json');
const SALES_FILE = path.join(DB_DIR, 'sales.json');
const USERS_FILE = path.join(DB_DIR, 'users.json');
const STOCK_MOVEMENTS_FILE = path.join(DB_DIR, 'stock_movements.json');
const AUDIT_LOGS_FILE = path.join(DB_DIR, 'audit_logs.json');
const SETTINGS_FILE = path.join(DB_DIR, 'settings.json');
const SYNC_HISTORY_FILE = path.join(DB_DIR, 'sync_history.json');

// Ensure directories exist
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

/**
 * Atomik Dosya Yazma (Yazma esnasında çökme durumunda dosya bozulmasını önler)
 */
function safeWriteJSON(filePath, data) {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    throw err;
  }
}

function safeReadJSON(filePath, defaultVal = []) {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return defaultVal;
    return JSON.parse(content);
  } catch (err) {
    console.error(`[DB ERROR] Dosya okuma hatası (${filePath}):`, err.message);
    try {
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, `${filePath}.corrupt.${Date.now()}`);
      }
    } catch (_) {}
    return defaultVal;
  }
}

// Varsayılan Ayarlar
function getDefaultSettings() {
  return {
    magazaAdi: "YagzShoes Ayakkabı Mağazası",
    varsayilanKdv: 10,
    paraBirimi: "TRY",
    paraSembol: "₺",
    minStokUyariLimiti: 2,
    fisBaslik: "YAGZSHOES AYAKKABI SAN. VE TİC. LTD. ŞTİ.",
    fisAdres: "İstiklal Cad. No:42 Beyoğlu / İstanbul",
    fisTelefon: "0212 555 00 90",
    fisVergiNo: "9000123456",
    otomatikYedekleme: true,
    otomatikYedeklemeGun: 1
  };
}

// Varsayılan Kullanıcılar (Bcrypt ile hashlenmiş)
function initDefaultUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const salt = bcrypt.genSaltSync(10);
    const users = [
      {
        id: "USR-001",
        username: "admin",
        passwordHash: bcrypt.hashSync("admin123", salt),
        fullName: "Yağız Yönetici",
        role: "admin", // admin, kasiyer, stok_sorumlusu, raporcu
        active: true,
        createdAt: new Date().toISOString()
      },
      {
        id: "USR-002",
        username: "kasiyer",
        passwordHash: bcrypt.hashSync("kasiyer123", salt),
        fullName: "Ahmet Satış Kasiyer",
        role: "kasiyer",
        active: true,
        createdAt: new Date().toISOString()
      },
      {
        id: "USR-003",
        username: "stokcu",
        passwordHash: bcrypt.hashSync("stok123", salt),
        fullName: "Mehmet Depo Sorumlusu",
        role: "stok_sorumlusu",
        active: true,
        createdAt: new Date().toISOString()
      }
    ];
    safeWriteJSON(USERS_FILE, users);
  }
}

function initDb() {
  initDefaultUsers();

  if (!fs.existsSync(SETTINGS_FILE)) {
    safeWriteJSON(SETTINGS_FILE, getDefaultSettings());
  }

  if (!fs.existsSync(PRODUCTS_FILE)) {
    const initialProducts = [
      { barkod: "869000101", marka: "Nike", model: "Air Force 1 '07", renk: "Beyaz", numara: 41, alisFiyati: 2400, satisFiyati: 4200, stok: 1, minStok: 2, kdvOrani: 10, aktif: true },
      { barkod: "869000102", marka: "Nike", model: "Air Force 1 '07", renk: "Beyaz", numara: 42, alisFiyati: 2400, satisFiyati: 4200, stok: 4, minStok: 2, kdvOrani: 10, aktif: true },
      { barkod: "869000103", marka: "Nike", model: "Air Force 1 '07", renk: "Beyaz", numara: 43, alisFiyati: 2400, satisFiyati: 4200, stok: 5, minStok: 2, kdvOrani: 10, aktif: true },
      { barkod: "869000201", marka: "Adidas", model: "Stan Smith", renk: "Beyaz/Yeşil", numara: 40, alisFiyati: 1800, satisFiyati: 3200, stok: 5, minStok: 2, kdvOrani: 10, aktif: true },
      { barkod: "869000202", marka: "Adidas", model: "Stan Smith", renk: "Beyaz/Yeşil", numara: 41, alisFiyati: 1800, satisFiyati: 3200, stok: 1, minStok: 2, kdvOrani: 10, aktif: true },
      { barkod: "869000301", marka: "Puma", model: "Suede Vintage", renk: "Siyah", numara: 42, alisFiyati: 1500, satisFiyati: 2750, stok: 6, minStok: 2, kdvOrani: 10, aktif: true },
      { barkod: "869000401", marka: "New Balance", model: "550", renk: "Beyaz/Gri", numara: 43, alisFiyati: 2800, satisFiyati: 4900, stok: 2, minStok: 2, kdvOrani: 10, aktif: true },
      { barkod: "869000501", marka: "Vans", model: "Old Skool", renk: "Siyah/Beyaz", numara: 39, alisFiyati: 1200, satisFiyati: 2199, stok: 1, minStok: 2, kdvOrani: 10, aktif: true },
      { barkod: "869000601", marka: "Converse", model: "Chuck Taylor All Star", renk: "Siyah", numara: 42, alisFiyati: 1350, satisFiyati: 2490, stok: 4, minStok: 2, kdvOrani: 10, aktif: true }
    ];
    safeWriteJSON(PRODUCTS_FILE, initialProducts);
  }

  if (!fs.existsSync(SALES_FILE)) {
    safeWriteJSON(SALES_FILE, []);
  }

  if (!fs.existsSync(STOCK_MOVEMENTS_FILE)) {
    safeWriteJSON(STOCK_MOVEMENTS_FILE, []);
  }

  if (!fs.existsSync(AUDIT_LOGS_FILE)) {
    safeWriteJSON(AUDIT_LOGS_FILE, []);
  }

  if (!fs.existsSync(SYNC_HISTORY_FILE)) {
    safeWriteJSON(SYNC_HISTORY_FILE, []);
  }
}

// Veritabanı Erişim Fonksiyonları
function getProducts() { return safeReadJSON(PRODUCTS_FILE, []); }
function saveProducts(data) { safeWriteJSON(PRODUCTS_FILE, data); }

function getSales() { return safeReadJSON(SALES_FILE, []); }
function saveSales(data) { safeWriteJSON(SALES_FILE, data); }

function getUsers() { return safeReadJSON(USERS_FILE, []); }
function saveUsers(data) { safeWriteJSON(USERS_FILE, data); }

function getStockMovements() { return safeReadJSON(STOCK_MOVEMENTS_FILE, []); }
function saveStockMovements(data) { safeWriteJSON(STOCK_MOVEMENTS_FILE, data); }

function getAuditLogs() { return safeReadJSON(AUDIT_LOGS_FILE, []); }
function saveAuditLogs(data) { safeWriteJSON(AUDIT_LOGS_FILE, data); }

function getSettings() { return safeReadJSON(SETTINGS_FILE, getDefaultSettings()); }
function saveSettings(data) { safeWriteJSON(SETTINGS_FILE, data); }

function getSyncHistory() { return safeReadJSON(SYNC_HISTORY_FILE, []); }
function saveSyncHistory(data) { safeWriteJSON(SYNC_HISTORY_FILE, data); }

/**
 * Denetim İzi (Audit Log) Kaydedici
 */
function logAudit(userId, username, action, details, ip = '127.0.0.1') {
  const logs = getAuditLogs();
  const entry = {
    id: `AUD-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    timestamp: new Date().toISOString(),
    userId: userId || 'SYSTEM',
    username: username || 'Sistem',
    action, // LOGIN, SALE, REFUND, STOCK_IN, STOCK_OUT, EXCEL_SYNC, USER_EDIT, SETTINGS_UPDATE vs.
    details: typeof details === 'string' ? details : JSON.stringify(details),
    ip
  };
  logs.push(entry);
  if (logs.length > 5000) logs.shift(); // Son 5000 log tut
  saveAuditLogs(logs);
}

/**
 * Stok Hareketi Kaydedici
 */
function recordStockMovement(movement) {
  const movements = getStockMovements();
  const entry = {
    id: `MOV-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    timestamp: new Date().toISOString(),
    barkod: movement.barkod,
    model: movement.model,
    numara: movement.numara,
    islemTuru: movement.islemTuru, // 'SATIS', 'IADE', 'GIRIS', 'CIKIS', 'SAYIM_DUZELTME', 'EXCEL_SYNC'
    oncekiStok: movement.oncekiStok,
    degisim: movement.degisim, // + veya -
    yeniStok: movement.yeniStok,
    belgeNo: movement.belgeNo || '',
    aciklama: movement.aciklama || '',
    kullanici: movement.kullanici || 'Sistem'
  };
  movements.push(entry);
  saveStockMovements(movements);
}

// Otomatik başlat
initDb();

module.exports = {
  DB_DIR,
  BACKUPS_DIR,
  initDb,
  getProducts,
  saveProducts,
  getSales,
  saveSales,
  getUsers,
  saveUsers,
  getStockMovements,
  recordStockMovement,
  getAuditLogs,
  logAudit,
  getSettings,
  saveSettings,
  getSyncHistory,
  saveSyncHistory,
  safeReadJSON,
  safeWriteJSON
};
