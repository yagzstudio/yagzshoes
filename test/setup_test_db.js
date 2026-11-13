/**
 * YagzShoes Test DB Kurulum Scripti
 * Temiz, izole test veritabanı oluşturur (data/yagzshoes_test.db).
 * Üretim veritabanına kesinlikle dokunmaz.
 */
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', 'data', 'yagzshoes_test.db');
process.env.TEST_DB_PATH = TEST_DB_PATH;

// Eski test DB ve WAL dosyalarını temizle
for (const ext of ['', '-wal', '-shm']) {
  const p = TEST_DB_PATH + ext;
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
}
console.log('♻️  Eski test DB silindi.');

// sqlite.js modülünü TEST_DB_PATH ile başlat
const { getDb, initSchema } = require('../data/sqlite');
initSchema();

// reset_db.js ile aynı tohumlama (seed) verilerini yükle
require('./reset_db');

console.log('✅ İzole Test DB başarıyla oluşturuldu ve hazırlandı:', TEST_DB_PATH);
