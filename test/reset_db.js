/**
 * Test öncesi DB sıfırlama scripti
 * Test kullanıcılarını ve test ürünlerini hazırlar, stokları ve kasa oturumlarını ayarlar.
 */
require('dotenv').config();
const { getDb, initSchema } = require('../data/sqlite');
const bcrypt = require('bcryptjs');

initSchema();
const db = getDb();

// 1. Kullanıcıları doğrula veya ekle
const usersToEnsure = [
  { id: 'USR-001', username: 'admin', role: 'admin', name: 'Yağız Yönetici', pass: 'Magaza@2026#Admin' },
  { id: 'USR-002', username: 'kasiyer', role: 'kasiyer', name: 'Ahmet Satış Kasiyer', pass: 'Magaza@2026#Kas' },
  { id: 'USR-003', username: 'stokcu', role: 'stok_sorumlusu', name: 'Mehmet Depo Sorumlusu', pass: 'Magaza@2026#Stok' }
];

for (const u of usersToEnsure) {
  const hash = bcrypt.hashSync(u.pass, 12);
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(u.username);
  if (!exists) {
    db.prepare(`
      INSERT INTO users (id, username, password_hash, full_name, role, active, must_change_password, session_version, failed_login_attempts)
      VALUES (?, ?, ?, ?, ?, 1, 0, 1, 0)
    `).run(u.id, u.username, hash, u.name, u.role);
  } else {
    db.prepare(`
      UPDATE users 
      SET password_hash=?, must_change_password=0, failed_login_attempts=0, locked_until=NULL, session_version=session_version+1
      WHERE username=?
    `).run(hash, u.username);
  }
}

// 2. Test ürünlerini doğrula veya ekle
const seedProducts = [
  { barcode: '869000101', marka: 'Nike', model: "Nike Air Force 1 '07 Beyaz Sneaker", renk: 'Beyaz', numara: 41, alis: 240000, satis: 420000, stok: 1, minStok: 2, kdv: 10 },
  { barcode: '869000102', marka: 'Nike', model: "Nike Air Force 1 '07 Beyaz Sneaker", renk: 'Beyaz', numara: 42, alis: 240000, satis: 420000, stok: 10, minStok: 2, kdv: 10 },
  { barcode: '869000103', marka: 'Nike', model: "Nike Air Force 1 '07 Beyaz Sneaker", renk: 'Beyaz', numara: 43, alis: 240000, satis: 420000, stok: 8, minStok: 2, kdv: 10 },
  { barcode: '869000201', marka: 'Adidas', model: 'Adidas Stan Smith Klasik', renk: 'Beyaz/Yeşil', numara: 40, alis: 180000, satis: 320000, stok: 10, minStok: 2, kdv: 10 },
  { barcode: '869000202', marka: 'Adidas', model: 'Adidas Stan Smith Klasik', renk: 'Beyaz/Yeşil', numara: 41, alis: 180000, satis: 320000, stok: 5, minStok: 2, kdv: 10 },
  { barcode: '869000301', marka: 'Puma', model: 'Puma Suede Vintage Siyah', renk: 'Siyah', numara: 42, alis: 150000, satis: 275000, stok: 10, minStok: 2, kdv: 10 },
  { barcode: '869000401', marka: 'New Balance', model: 'New Balance 550 Beyaz/Gri', renk: 'Gri', numara: 43, alis: 280000, satis: 490000, stok: 10, minStok: 2, kdv: 10 },
  { barcode: '869000501', marka: 'Vans', model: 'Vans Old Skool Classic', renk: 'Siyah/Beyaz', numara: 39, alis: 120000, satis: 219900, stok: 1, minStok: 2, kdv: 10 },
  { barcode: '869000601', marka: 'Converse', model: 'Converse Chuck Taylor All Star', renk: 'Siyah', numara: 42, alis: 135000, satis: 249000, stok: 4, minStok: 2, kdv: 10 }
];

for (const p of seedProducts) {
  const existing = db.prepare('SELECT barcode FROM products WHERE barcode=?').get(p.barcode);
  if (!existing) {
    db.prepare(`
      INSERT INTO products (barcode, marka, model, renk, numara, alis_fiyati_kurus, satis_fiyati_kurus, kdv_orani, stok, min_stok, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(p.barcode, p.marka, p.model, p.renk, p.numara, p.alis, p.satis, p.kdv, p.stok, p.minStok);
  } else {
    db.prepare(`
      UPDATE products 
      SET stok=?, active=1, alis_fiyati_kurus=?, satis_fiyati_kurus=?, kdv_orani=?
      WHERE barcode=?
    `).run(p.stok, p.alis, p.satis, p.kdv, p.barcode);
  }

  // product_variants senkronizasyonu
  try {
    const varExists = db.prepare('SELECT id FROM product_variants WHERE barcode=?').get(p.barcode);
    if (!varExists) {
      db.prepare(`
        INSERT INTO product_variants (id, barcode, model, renk, numara, stok, alis_fiyati_kurus, satis_fiyati_kurus)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`VAR-${p.barcode}`, p.barcode, p.model, p.renk, p.numara, p.stok, p.alis, p.satis);
    } else {
      db.prepare('UPDATE product_variants SET stok=? WHERE barcode=?').run(p.stok, p.barcode);
    }
  } catch (_) {}
}

// 3. Açık kasa oturumlarını kapat
db.prepare("UPDATE cash_sessions SET durum='KAPALI' WHERE durum='ACIK'").run();

console.log('✅ DB sıfırlandı: Test kullanıcıları, test ürünleri ve kasa oturumları hazırlandı.');

const users = db.prepare('SELECT username, must_change_password, failed_login_attempts, session_version FROM users').all();
users.forEach(u => console.log(' - User:', JSON.stringify(u)));

const prods = db.prepare('SELECT barcode, model, stok FROM products').all();
console.log(` - Toplam ${prods.length} test ürünü hazır.`);
