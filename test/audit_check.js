/**
 * Production Readiness Audit Check Script
 * DB bütünlük, settings, trigger kontrolü
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getDb } = require('../data/sqlite');
const db = getDb();

console.log('=== DB TABLO KONTROL ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
tables.forEach(t => {
  const count = db.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get().c;
  console.log(` - ${t.name}: ${count} kayit`);
});

console.log('\n=== TRIGGER KONTROL ===');
const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all();
triggers.forEach(t => console.log(` - ${t.name}`));

console.log('\n=== SETTINGS ===');
const settings = db.prepare('SELECT key, value FROM settings').all();
settings.forEach(s => console.log(` - ${s.key} = ${s.value}`));

console.log('\n=== USERS ===');
const users = db.prepare('SELECT username, role, must_change_password, failed_login_attempts, active FROM users').all();
users.forEach(u => console.log(' -', JSON.stringify(u)));

console.log('\n=== PRODUCTS STOK ===');
const prods = db.prepare('SELECT barcode, model, numara, stok, min_stok FROM products ORDER BY stok ASC').all();
prods.forEach(p => console.log(' -', JSON.stringify(p)));

console.log('\n=== OPEN CASH SESSIONS ===');
const sessions = db.prepare("SELECT id, durum, acilis_tarihi FROM cash_sessions WHERE durum='ACIK'").all();
if (sessions.length === 0) console.log(' - Açık kasa oturumu yok');
sessions.forEach(s => console.log(' -', JSON.stringify(s)));

console.log('\n=== AUDIT TRIGGER TEST ===');
try {
  db.prepare('DELETE FROM audit_logs WHERE 1=1').run();
  console.log(' ❌ TRIGGER ÇALIŞMADI — GÜVENLİK AÇIĞI!');
} catch(e) {
  if (e.message.includes('Denetim kayıtları silinemez')) {
    console.log(' ✅ Audit trigger aktif');
  } else {
    console.log(' ⚠️ Farklı hata:', e.message);
  }
}

console.log('\n=== WAL MODE ===');
const walMode = db.pragma('journal_mode', { simple: true });
console.log(' -', walMode === 'wal' ? '✅ WAL aktif' : '❌ WAL KAPALI: ' + walMode);

console.log('\n=== FK CONSTRAINTS ===');
const fkOn = db.pragma('foreign_keys', { simple: true });
console.log(' -', fkOn === 1 ? '✅ FK aktif' : '❌ FK KAPALI');
