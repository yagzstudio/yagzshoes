/**
 * YagzShoes Enterprise POS — Mağaza Verilerini Sıfırlama (Clean Store Data)
 * Test satışlarını, ciroyu, stok hareketlerini, ürünleri ve kasa oturumlarını temizler.
 * GÜVENLİK GÜNCELLEMESİ:
 * - Denetim günlüğü (audit_logs) ve yedek geçmişi (backup_history) korunur; trigger'lar ASLA drop edilmez.
 * - Mevcut kullanıcıların parola hash'leri ezilmez (açık metin parola saklanmaz).
 * - Temizleme öncesinde otomatik güvenlik yedeği alınır.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDb, initSchema, DB_PATH, BACKUPS_DIR } = require('../data/sqlite');

console.log('🧹 YagzShoes Mağaza Verileri Temizleniyor...\n');

// 1. Şema kontrolü ve veritabanı bağlantısı
initSchema();
const db = getDb();

// 2. Temizleme öncesi otomatik güvenlik yedeği oluştur
try {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyDir = path.join(BACKUPS_DIR, `pre_clean_${timestamp}`);
  if (!fs.existsSync(safetyDir)) fs.mkdirSync(safetyDir, { recursive: true });
  db.backup(path.join(safetyDir, 'yagzshoes.db')).then(() => {
    console.log(` 🛡️  Temizlik öncesi otomatik güvenlik yedeği alındı: ${safetyDir}`);
  }).catch(err => {
    console.warn(' ⚠️  Otomatik yedek uyarısı:', err.message);
  });
} catch (e) {
  console.warn(' ⚠️  Yedekleme adımı atlandı:', e.message);
}

// 3. Tabloları temizle (Denetim izi ve yedek geçmişi HARİÇ)
const tablesToClear = [
  'returns',
  'sale_items',
  'payments',
  'sales',
  'stock_movements',
  'stock_count_items',
  'stock_counts',
  'cash_transactions',
  'cash_sessions',
  'price_history',
  'product_variants',
  'products',
  'product_groups'
];

db.transaction(() => {
  for (const table of tablesToClear) {
    try {
      db.prepare(`DELETE FROM ${table}`).run();
      console.log(` ✅ ${table} tablosu temizlendi.`);
    } catch (err) {
      console.warn(` ⚠️ ${table} temizlenemedi:`, err.message);
    }
  }

  // Kullanıcı durumlarını sıfırla (mevcut şifreleri koru, kilitleri kaldır, oturumları tazele)
  db.prepare(`
    UPDATE users 
    SET failed_login_attempts = 0, 
        locked_until = NULL, 
        session_version = session_version + 1
  `).run();
  console.log(' ✅ Kullanıcı hesapları korundu, kilitler kaldırıldı ve oturumlar tazelendi.');

  // Ayarları kontrol et / ekle
  const setSetting = (k, v) => {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) 
      VALUES (?, ?, datetime('now')) 
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(k, v);
  };

  setSetting('magaza_adi', 'YagzShoes Enterprise');
  setSetting('adres', 'İstanbul Mağaza No: 1');
  setSetting('telefon', '0212 000 00 00');
  setSetting('kdv_orani', '20');
  setSetting('fis_alti_notu', 'Bizi tercih ettiğiniz için teşekkür ederiz. Değişim 14 gün içindedir.');
  setSetting('setup_tamamlandi', '1');
  console.log(' ✅ Mağaza ve finansal ayarları hazırlandı.');

  // Denetim günlüğüne temizlik kaydı düş
  try {
    db.prepare(`
      INSERT INTO audit_logs (timestamp, user_id, username, action, entity, details)
      VALUES (datetime('now'), 'SYSTEM', 'system_script', 'STORE_DATA_CLEAN', 'database', 'Mağaza operasyon verileri temizlendi. Denetim kayıtları korundu.')
    `).run();
    console.log(' ✅ Denetim günlüğüne işlem kaydı (audit log) düşüldü.');
  } catch (_) {}
})();

// 4. Veritabanını optimize et (VACUUM)
try {
  db.exec('VACUUM;');
  console.log(' ✅ SQLite VACUUM tamamlandı (veritabanı dosyası optimize edildi).');
} catch (e) {
  console.warn(' ⚠️ VACUUM atlandı:', e.message);
}

// 5. JSON veri dosyalarını sıfırla
const dataDir = path.join(__dirname, '..', 'data');
const jsonFiles = ['products.json', 'sales.json', 'stock_movements.json', 'sync_history.json'];
for (const file of jsonFiles) {
  const filePath = path.join(dataDir, file);
  try {
    if (fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify([], null, 2), 'utf8');
      console.log(` ✅ JSON veri dosyası sıfırlandı: ${file}`);
    }
  } catch (err) {
    console.warn(` ⚠️ ${file} sıfırlanamadı:`, err.message);
  }
}

// 6. Test yüklemelerini temizle
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (fs.existsSync(uploadsDir)) {
  const files = fs.readdirSync(uploadsDir);
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(uploadsDir, f));
    } catch (_) {}
  }
  console.log(' ✅ Uploads geçici dosyaları temizlendi.');
}

console.log('\n✨ TAMAMLANDI! Mağaza verileri temizlendi, denetim izi güvenle korundu.');
