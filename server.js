/**
 * YagzShoes Enterprise POS v2.6 — Ana Sunucu
 * SQLite + Atomik Transaction + RBAC + Rate Limiting + Helmet
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const sq = require('./data/sqlite');
const { authenticateToken, authorizeRoles, requirePermission,
        generateToken, validatePasswordPolicy } = require('./middleware/auth');
const { SyncManager } = require('./sync/syncEngine');

// === VERİTABANI BAŞLAT ===
sq.initSchema();
const migration = sq.migrateFromJSON();
if (!migration.skipped) {
  console.log(`[DB] JSON → SQLite Migration: ${migration.users} kullanıcı, ${migration.products} ürün, ${migration.sales} satış`);
  if (migration.errors.length > 0) console.warn('[DB] Migration uyarıları:', migration.errors);
  const validation = sq.validateMigration();
  if (!validation.urunler.eslesme || !validation.stokToplami.eslesme) {
    console.warn('[DB] Migration doğrulama uyarısı:', validation);
  } else {
    console.log('[DB] Migration bütünlük doğrulaması BAŞARILI.');
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const syncManager = new SyncManager();

// === GÜVENLİK MİDDLEWARE ===
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'unpkg.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'cdn.jsdelivr.net', 'unpkg.com', 'https:']
    }
  },
  crossOriginEmbedderPolicy: false
}));

// Localhost-only CORS
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));

// === RATE LIMITING ===
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  skip: (req) => process.env.NODE_ENV === 'test',
  message: { success: false, message: 'Çok fazla giriş denemesi. 15 dakika bekleyin.' },
  standardHeaders: true, legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300,
  skip: (req) => process.env.NODE_ENV === 'test',
  message: { success: false, message: 'İstek sınırı aşıldı.' }
});

app.use('/api/', apiLimiter);

// === STATİK DOSYALAR ===
app.use(express.static(path.join(__dirname, 'public')));

// === MULTER (Güvenli dosya yükleme) ===
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) return cb(null, true);
    cb(new Error('Sadece .xlsx, .xls veya .csv dosyaları kabul edilir.'));
  }
});
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
}

// IP helper (proxy arkasında güvenilir IP)
function getClientIP(req) {
  return req.ip || req.connection?.remoteAddress || '127.0.0.1';
}

// ============================================================
// 1. KİMLİK DOĞRULAMA & İLK KURULUM API
// ============================================================

// Kurulum Durumu Sorgulama
app.get('/api/auth/setup-status', (req, res) => {
  const status = sq.getSetupStatus();
  res.json({ success: true, ...status });
});

// Güvenli İlk Yönetici Kurulumu (Varsayılan şifre olmadan)
app.post('/api/auth/setup-admin', (req, res) => {
  const { username, password, confirmPassword, fullName, magazaAdi } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Kullanıcı adı ve şifre zorunludur.' });
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Şifreler eşleşmiyor.' });
  }

  const policyErrors = validatePasswordPolicy(password);
  if (policyErrors.length > 0) {
    return res.status(400).json({ success: false, message: policyErrors.join(' ') });
  }

  try {
    const adminUser = sq.setupInitialAdmin({
      username: String(username).trim(),
      password,
      fullName: fullName || 'Sistem Yöneticisi',
      magazaAdi
    });
    const token = generateToken(adminUser);
    res.json({
      success: true,
      message: 'İlk kurulum ve yönetici hesabı başarıyla tamamlandı.',
      token,
      user: { id: adminUser.id, username: adminUser.username, fullName: adminUser.full_name, role: adminUser.role }
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Giriş
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIP(req);

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Kullanıcı adı ve şifre zorunludur.' });
  }

  const user = sq.getUserByUsername(String(username).trim());

  if (!user || !user.active) {
    sq.logAudit({ username: username, action: 'LOGIN_FAILED', sonuc: 'ENGELLENDI', ipAdresi: ip,
      details: 'Kullanıcı bulunamadı veya pasif' });
    return res.status(401).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı.' });
  }

  // Hesap kilitleme kontrolü
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const remaining = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
    return res.status(423).json({
      success: false, code: 'ACCOUNT_LOCKED',
      message: `Hesabınız ${remaining} dakika kilitli. Çok fazla hatalı giriş denemesi.`
    });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    const result = sq.recordFailedLogin(user.id);
    sq.logAudit({ userId: user.id, username: user.username, action: 'LOGIN_FAILED',
      sonuc: 'ENGELLENDI', ipAdresi: ip, details: `Hatalı deneme: ${result.attempts}/5` });
    return res.status(401).json({
      success: false,
      message: result.lockedUntil
        ? `Çok fazla hatalı giriş. Hesabınız 15 dakika kilitlendi.`
        : `Kullanıcı adı veya şifre hatalı. (${result.attempts}/5 deneme)`
    });
  }

  sq.clearFailedLogins(user.id);
  const token = generateToken(user);
  sq.logAudit({ userId: user.id, username: user.username, action: 'LOGIN_SUCCESS', ipAdresi: ip });

  res.json({
    success: true, token,
    mustChangePassword: user.must_change_password === 1,
    user: {
      id: user.id, username: user.username,
      fullName: user.full_name, role: user.role
    }
  });
});

// Oturum Bilgisi
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Şifre Değiştirme (giriş yapmış kullanıcı)
app.post('/api/auth/change-password', authenticateToken, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Mevcut ve yeni şifre zorunludur.' });
  }
  if (confirmPassword !== undefined && newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Yeni şifreler eşleşmiyor.' });
  }

  const policyErrors = validatePasswordPolicy(newPassword);
  if (policyErrors.length > 0) {
    return res.status(400).json({ success: false, message: policyErrors.join(' ') });
  }

  const user = sq.getUserById(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ success: false, message: 'Mevcut şifreniz hatalı.' });
  }
  if (bcrypt.compareSync(newPassword, user.password_hash)) {
    return res.status(400).json({ success: false, message: 'Yeni şifre mevcut şifreden farklı olmalıdır.' });
  }

  const newHash = bcrypt.hashSync(newPassword, 12);
  sq.updateUserPassword(user.id, newHash, true); // sessionVersion artır → eski tokenlar geçersizleşir

  sq.logAudit({ userId: user.id, username: user.username, action: 'PASSWORD_CHANGE', ipAdresi: getClientIP(req) });

  // Yeni token üret (must_change_password artık 0)
  const updatedUser = sq.getUserById(user.id);
  const newToken = generateToken(updatedUser);
  res.json({ success: true, message: 'Şifreniz değiştirildi.', token: newToken });
});

// Yönetici: Kullanıcının şifresini sıfırla
app.post('/api/auth/admin-reset-password', authenticateToken, requirePermission('users:manage'), (req, res) => {
  const { targetUserId, newPassword } = req.body;
  if (!targetUserId || !newPassword) {
    return res.status(400).json({ success: false, message: 'Kullanıcı ID ve yeni şifre zorunludur.' });
  }

  const policyErrors = validatePasswordPolicy(newPassword);
  if (policyErrors.length > 0) {
    return res.status(400).json({ success: false, message: policyErrors.join(' ') });
  }

  const targetUser = sq.getUserById(targetUserId);
  if (!targetUser) return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });

  const newHash = bcrypt.hashSync(newPassword, 12);
  // must_change_password=1 ile kaydet + eski oturumları geçersiz kıl
  sq.getDb().prepare(`
    UPDATE users SET password_hash=?, session_version=session_version+1, must_change_password=1, updated_at=datetime('now') WHERE id=?
  `).run(newHash, targetUserId);

  sq.logAudit({ userId: req.user.id, username: req.user.username,
    action: 'ADMIN_PASSWORD_RESET', recordId: targetUserId, ipAdresi: getClientIP(req) });

  res.json({ success: true, message: `${targetUser.username} şifresi sıfırlandı. Kullanıcı bir sonraki girişte şifre değiştirmek zorunda kalacak.` });
});

// Oturumu Kapat (sunucu tarafında session version artır)
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  sq.incrementSessionVersion(req.user.id);
  sq.logAudit({ userId: req.user.id, username: req.user.username, action: 'LOGOUT', ipAdresi: getClientIP(req) });
  res.json({ success: true, message: 'Oturum sonlandırıldı.' });
});

// Yönetici: Başka kullanıcının oturumunu kapat
app.post('/api/auth/force-logout', authenticateToken, requirePermission('users:manage'), (req, res) => {
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ success: false, message: 'Kullanıcı ID zorunludur.' });
  if (targetUserId === req.user.id) return res.status(400).json({ success: false, message: 'Kendi oturumunuzu bu yolla kapatamassınız.' });

  sq.incrementSessionVersion(targetUserId);
  const target = sq.getUserById(targetUserId);
  sq.logAudit({ userId: req.user.id, username: req.user.username,
    action: 'FORCE_LOGOUT', recordId: targetUserId, ipAdresi: getClientIP(req),
    details: `${target?.username} oturumu zorla sonlandırıldı` });

  res.json({ success: true, message: 'Kullanıcı oturumu sonlandırıldı.' });
});

// ============================================================
// 2. ÜRÜN VE STOK API
// ============================================================

// Ürün Listesi
app.get('/api/products', authenticateToken, requirePermission('stock:view'), (req, res) => {
  const { search = '', status = 'active', minStock } = req.query;
  const products = sq.getProducts({
    activeOnly: status !== 'all',
    search: search.trim() || undefined,
    criticalOnly: minStock === 'critical'
  });

  // Kasiyer alış fiyatlarını göremez
  const canSeeCost = req.user.role === 'admin';
  const filtered = products.map(p => canSeeCost ? p : { ...p, alisFiyati: undefined });
  res.json({ success: true, total: filtered.length, data: filtered });
});

// Barkod Sorgu (POS için)
app.get('/api/products/barcode/:barcode', authenticateToken, requirePermission('pos:checkout'), (req, res) => {
  const barcode = req.params.barcode.trim();
  if (!barcode || barcode.length < 3) {
    return res.status(400).json({ success: false, message: 'Geçersiz barkod.' });
  }
  let product = sq.getProductByBarcode(barcode);
  if (!product && barcode.length === 8 && barcode.startsWith('86900')) {
    // 8 haneli eksik sıfırlı barkod toleransı (örn: 86900201 -> 869000201)
    const padded = barcode.slice(0, 5) + '0' + barcode.slice(5);
    product = sq.getProductByBarcode(padded);
  }
  if (!product) {
    return res.status(404).json({ success: false, message: 'Ürün bulunamadı!' });
  }
  // Kasiyere alış fiyatını gösterme
  const data = req.user.role === 'admin' ? product : { ...product, alisFiyati: undefined };
  res.json({ success: true, data });
});

// Yeni Ürün
app.post('/api/products', authenticateToken, requirePermission('product:create'), (req, res) => {
  const { barkod, marka, model, renk, numara, alisFiyati, satisFiyati, stok, minStok, kdvOrani } = req.body;
  if (!barkod || !model || numara === undefined || satisFiyati === undefined) {
    return res.status(400).json({ success: false, message: 'Barkod, model, numara ve satış fiyatı zorunludur.' });
  }
  if (sq.getProductByBarcode(String(barkod).trim())) {
    return res.status(400).json({ success: false, message: 'Bu barkod zaten kayıtlı!' });
  }

  try {
    sq.createProduct(
      { barkod: String(barkod).trim(), marka, model, renk, numara: parseFloat(numara),
        alisFiyati: parseFloat(alisFiyati) || 0, satisFiyati: parseFloat(satisFiyati),
        stok: parseInt(stok, 10) || 0, minStok: parseInt(minStok, 10) || 2,
        kdvOrani: parseInt(kdvOrani, 10) || sq.getSetting('varsayilan_kdv') || 10 },
      req.user.id, req.user.username
    );
    res.json({ success: true, message: 'Ürün kartı oluşturuldu.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Ürün Güncelleme
app.put('/api/products/:barcode', authenticateToken, requirePermission('product:edit'), (req, res) => {
  try {
    sq.updateProduct(req.params.barcode, req.body, req.user.id, req.user.username);
    res.json({ success: true, message: 'Ürün güncellendi.' });
  } catch (e) {
    res.status(e.message.includes('bulunamadı') ? 404 : 500).json({ success: false, message: e.message });
  }
});

// Manuel Stok Ayarı
app.post('/api/stock/adjust', authenticateToken, requirePermission('stock:adjust'), (req, res) => {
  const { barkod, miktar, islemTuru, belgeNo, aciklama } = req.body;
  if (!barkod || !miktar || !islemTuru) {
    return res.status(400).json({ success: false, message: 'Barkod, miktar ve işlem türü zorunludur.' });
  }
  try {
    const result = sq.adjustStock({
      barcode: barkod, miktar, islemTuru, belgeNo, aciklama,
      userId: req.user.id, username: req.user.username
    });
    res.json({ success: true, message: 'Stok hareketi kaydedildi.', data: result });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Stok Hareketleri
app.get('/api/stock/movements', authenticateToken, requirePermission('stock:view'), (req, res) => {
  const movements = sq.getStockMovements({ barcode: req.query.barkod, limit: req.query.limit || 100 });
  res.json({ success: true, count: movements.length, data: movements });
});

// Alış/Satış Fiyat Değişim Geçmişi (Sadece admin görebilir)
app.get('/api/products/price-history/:barcode', authenticateToken, requirePermission('sales:view_cost'), (req, res) => {
  const history = sq.getPriceHistory(req.params.barcode);
  res.json({ success: true, count: history.length, data: history });
});

// Stok Sayımı Başlat & Kaydet
app.post('/api/stock/count', authenticateToken, requirePermission('stock:count'), (req, res) => {
  const { items, aciklama } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Sayım listesi boş olamaz.' });
  }
  try {
    const result = sq.createStockCount({
      items, aciklama,
      userId: req.user.id,
      username: req.user.fullName || req.user.username
    });
    res.json({ success: true, message: `Stok sayımı tamamlandı. Toplam fark: ${result.toplamFarkAdet} adet`, data: result });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Stok Sayım Oturumları Geçmişi
app.get('/api/stock/counts', authenticateToken, requirePermission('stock:count'), (req, res) => {
  res.json({ success: true, data: sq.getStockCounts(50) });
});

// Belirli Sayım Detayı
app.get('/api/stock/counts/:id', authenticateToken, requirePermission('stock:count'), (req, res) => {
  const count = sq.getStockCountDetail(req.params.id);
  if (!count) return res.status(404).json({ success: false, message: 'Sayım kaydı bulunamadı.' });
  res.json({ success: true, data: count });
});

// ============================================================
// 3. POS & SATIŞ API
// ============================================================

// POS Checkout — Atomik Transaction + Idempotency
app.post('/api/pos/checkout', authenticateToken, requirePermission('pos:checkout'), (req, res) => {
  const { items, indirimTutari = 0, nakitTutar = 0, kartTutar = 0, musteriNotu, idempotencyKey } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Sepette ürün bulunmuyor.' });
  }

  try {
    const result = sq.posCheckout({
      items: items.map(i => ({ barkod: i.barkod, adet: parseInt(i.adet, 10) || 1 })),
      indirimTL: parseFloat(indirimTutari) || 0,
      nakitTL: parseFloat(nakitTutar) || 0,
      kartTL: parseFloat(kartTutar) || 0,
      musteriNotu, idempotencyKey: idempotencyKey || null,
      kasiyerId: req.user.id, kasiyerAdi: req.user.fullName || req.user.username
    });

    if (result.alreadyExists) {
      return res.status(200).json({
        success: true,
        message: 'Bu işlem zaten kaydedilmiş (idempotent yanıt).',
        data: {
          fisNo: result.fisNo,
          duplicate: true,
          netSatis: sq.toTL(result.sale?.net_satis_kurus || 0),
          odemeTuru: result.sale?.odeme_turu,
          kalemler: result.kalemler
        }
      });
    }

    res.json({
      success: true,
      message: `Satış başarıyla tamamlandı. Fiş: ${result.fisNo}`,
      data: {
        fisNo: result.fisNo, odemeTuru: result.odemeTuru,
        netSatis: sq.toTL(result.netSatisKurus),
        toplamBrut: sq.toTL(result.toplamBrutKurus),
        indirim: sq.toTL(result.indirimKurus),
        toplamKdv: sq.toTL(result.toplamKdvKurus),
        netKar: req.user.role === 'admin' ? sq.toTL(result.netKarKurus) : undefined,
        nakitTahsilat: sq.toTL(result.nakitKurus),
        kartTahsilat: sq.toTL(result.kartKurus),
        paraUstu: sq.toTL(result.paraUstuKurus),
        kalemler: result.kalemler
      }
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Satış Geçmişi
app.get('/api/sales', authenticateToken, requirePermission('sales:view'), (req, res) => {
  const { dateFrom, dateTo, search, durum } = req.query;
  const sales = sq.getSales({ dateFrom, dateTo, search, durum });
  // Kasiyer kâr bilgisini göremez
  const canSeeCost = req.user.role === 'admin';
  const filtered = sales.map(s => canSeeCost ? s : { ...s, netKar: undefined, toplam_kar_kurus: undefined });
  res.json({ success: true, count: filtered.length, data: filtered });
});

// Belirli Satış Detayı (İade & İptal işlemi için)
app.get('/api/sales/:fisNo', authenticateToken, requirePermission('sales:view'), (req, res) => {
  const sale = sq.getSaleWithItems(req.params.fisNo);
  if (!sale) return res.status(404).json({ success: false, message: 'Satış kaydı bulunamadı.' });

  const canSeeCost = req.user.role === 'admin';
  const sanitized = canSeeCost ? sale : {
    ...sale,
    netKar: undefined, net_kar_kurus: undefined,
    toplamMaliyet: undefined, toplam_maliyet_kurus: undefined,
    kalemler: sale.kalemler?.map(k => ({
      ...k,
      birim_alis_kurus: undefined, toplam_alis_kurus: undefined,
      birimAlisFiyati: undefined
    }))
  };
  res.json({ success: true, data: sanitized });
});

// İade İşlemi (Kısmi iade destekli)
app.post('/api/pos/refund', authenticateToken, requirePermission('pos:refund'), (req, res) => {
  const { fisNo, refundItems, iadeNedeni } = req.body;
  if (!fisNo || !refundItems || !Array.isArray(refundItems) || refundItems.length === 0) {
    return res.status(400).json({ success: false, message: 'Fiş no ve iade edilecek kalemler zorunludur.' });
  }
  try {
    const result = sq.processRefund({
      fisNo, refundItems,
      iadeNedeni: iadeNedeni || 'Belirtilmedi',
      kasiyerId: req.user.id, kasiyerAdi: req.user.fullName || req.user.username
    });
    res.json({
      success: true,
      message: `İade işlendi. Toplam iade tutarı: ₺${sq.toTL(result.toplamIadeKurus)}`,
      data: result
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Satış İptali (Tam iptal & stokların geri yüklenmesi)
app.post('/api/pos/cancel', authenticateToken, requirePermission('pos:cancel'), (req, res) => {
  const { fisNo, iptalNedeni } = req.body;
  if (!fisNo) {
    return res.status(400).json({ success: false, message: 'Fiş numarası zorunludur.' });
  }
  try {
    const result = sq.cancelSale({
      fisNo,
      iptalNedeni: iptalNedeni || 'Müşteri talebi / Yanlış fiş',
      userId: req.user.id,
      username: req.user.fullName || req.user.username
    });
    res.json({
      success: true,
      message: `Satış fişi başarıyla iptal edildi ve stoklar geri yüklendi. Fiş: ${fisNo}`,
      data: result
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// ============================================================
// 4. DASHBOARD
// ============================================================
app.get('/api/dashboard/stats', authenticateToken, (req, res) => {
  const { startDate, endDate } = req.query;
  const stats = sq.getDashboardStats({ dateFrom: startDate, dateTo: endDate });
  // Kasiyer kâr bilgisini göremez
  if (req.user.role !== 'admin') {
    stats.netKar = undefined;
    stats.karMarji = undefined;
    stats.toplamMaliyet = undefined;
    stats.recentSales = stats.recentSales?.map(s => ({ ...s, netKar: undefined }));
  }
  res.json({ success: true, data: stats });
});

// ============================================================
// 5. KASA MODÜLÜ
// ============================================================

// Kasa Aç
app.post('/api/cash/open', authenticateToken, requirePermission('cash:open'), (req, res) => {
  const acilisNakit = req.body.acilisNakit ?? req.body.acilisNakdi ?? 0; // frontend compat
  try {
    const sessionId = sq.openCashSession({
      kasiyerId: req.user.id, kasiyerAdi: req.user.fullName || req.user.username,
      acilisNakitTL: parseFloat(acilisNakit) || 0
    });
    res.json({ success: true, message: 'Kasa açıldı.', sessionId });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Kasa Kapat
app.post('/api/cash/close', authenticateToken, requirePermission('cash:close'), (req, res) => {
  const sessionId = req.body.sessionId ?? req.body.kasaId; // frontend compat
  const { sayilanNakit, kapanisNotu } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, message: 'Kasa oturumu ID zorunludur.' });
  try {
    const result = sq.closeCashSession({
      sessionId, sayilanNakitTL: parseFloat(sayilanNakit) || 0,
      kapanisNotu,
      kapanisKasiyerId: req.user.id, kapanisKasiyerAdi: req.user.fullName || req.user.username
    });
    res.json({ success: true, message: 'Gün sonu kapatıldı.', data: result });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Aktif Kasa Durumu
app.get('/api/cash/active', authenticateToken, requirePermission('cash:view'), (req, res) => {
  const session = sq.getActiveCashSession();
  res.json({ success: true, data: session || null });
});

// Kasa Geçmişi
app.get('/api/cash/sessions', authenticateToken, requirePermission('cash:view'), (req, res) => {
  const sessions = sq.getCashSessions(50);
  res.json({ success: true, data: sessions });
});

// Kasa Nakit Giriş / Çıkış (Masraf, Kasa Tahsilat vb.)
app.post('/api/cash/transaction', authenticateToken, requirePermission('cash:open'), (req, res) => {
  const { sessionId, islemTuru, tutar, kategori, aciklama } = req.body;
  if (!sessionId || !islemTuru || !tutar) {
    return res.status(400).json({ success: false, message: 'Kasa oturumu ID, işlem türü ve tutar zorunludur.' });
  }
  try {
    const result = sq.addCashTransaction({
      sessionId, islemTuru, tutarTL: parseFloat(tutar),
      kategori, aciklama,
      userId: req.user.id, username: req.user.fullName || req.user.username
    });
    res.json({ success: true, message: `Kasa ${islemTuru === 'GIRIS' ? 'nakit girişi' : 'nakit çıkışı'} kaydedildi.`, data: result });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Kasa Hareketleri Listesi
app.get('/api/cash/sessions/:id/transactions', authenticateToken, requirePermission('cash:view'), (req, res) => {
  const txs = sq.getCashTransactions(req.params.id);
  res.json({ success: true, data: txs.map(t => ({ ...t, tutar: sq.toTL(t.tutar_kurus) })) });
});

// ============================================================
// 6. EXCEL SENKRONİZASYONU
// ============================================================

// Önizleme (Dry-run)
app.post('/api/sync/preview', authenticateToken, requirePermission('sync:preview'), upload.single('file'), async (req, res) => {
  let targetPath = '';
  try {
    targetPath = req.file ? req.file.path : path.join(__dirname, 'sync', 'patron_gunluk_stok.xlsx');
    if (!fs.existsSync(targetPath)) {
      return res.status(400).json({ success: false, message: 'Dosya bulunamadı.' });
    }
    const provider = syncManager.getProvider('excel');
    const result = await provider.parse(targetPath);

    const currentProducts = sq.getProducts({ activeOnly: false });
    let yeniUrun = 0, guncellenecek = 0;
    result.validRows.forEach(row => {
      currentProducts.some(p => p.barkod === row.barkod) ? guncellenecek++ : yeniUrun++;
    });

    res.json({
      success: true, data: {
        toplamSatir: result.toplamSatir, gecerliAdet: result.gecerliAdet,
        hataliAdet: result.hataliAdet, yeniUrunSayisi: yeniUrun, guncellenecekSayisi: guncellenecek,
        hatalar: result.invalidRows.slice(0, 20),
        onizleme: result.validRows.slice(0, 5)
      }
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
  }
});

// Uygulama
app.post('/api/sync/apply', authenticateToken, requirePermission('sync:apply'), upload.single('file'), async (req, res) => {
  let targetPath = '';
  try {
    targetPath = req.file ? req.file.path : path.join(__dirname, 'sync', 'patron_gunluk_stok.xlsx');
    if (!fs.existsSync(targetPath)) {
      return res.status(400).json({ success: false, message: 'Dosya bulunamadı.' });
    }

    const provider = syncManager.getProvider('excel');
    const parseResult = await provider.parse(targetPath);
    if (parseResult.gecerliAdet === 0) {
      return res.status(400).json({ success: false, message: 'Geçerli satır bulunamadı.' });
    }

    const db = sq.getDb();
    let eklenen = 0, guncellenen = 0;

    const applyAll = db.transaction(() => {
      parseResult.validRows.forEach(item => {
        const existing = sq.getProductByBarcode(item.barkod);
        if (existing) {
          const oldStok = existing.stok;
          sq.updateProduct(item.barkod, {
            marka: item.marka, model: item.model, renk: item.renk,
            alisFiyati: item.alisFiyati, satisFiyati: item.satisFiyati, kdvOrani: item.kdvOrani
          }, req.user.id, req.user.username);
          if (oldStok !== item.stok) {
            sq.adjustStock({
              barcode: item.barkod, miktar: item.stok,
              islemTuru: 'SAYIM_DUZELTME', belgeNo: 'EXCEL-SYNC',
              aciklama: 'Patron Excel Senkronizasyonu', userId: req.user.id, username: req.user.username
            });
          }
          guncellenen++;
        } else {
          sq.createProduct(item, req.user.id, req.user.username);
          eklenen++;
        }
      });
    });

    applyAll();

    sq.logAudit({ userId: req.user.id, username: req.user.username,
      action: 'EXCEL_SYNC', details: `+${eklenen} yeni, ${guncellenen} güncellendi` });

    res.json({
      success: true,
      message: `Senkronizasyon tamamlandı: +${eklenen} yeni ürün, ${guncellenen} güncellendi.`,
      stats: { eklenen, guncellenen, hataliAdet: parseResult.hataliAdet }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
  }
});

// ============================================================
// 7. SİSTEM — YEDEK, KULLANICI, AYARLAR, DENETİM
// ============================================================

// Yedek Al (SQLite online backup API)
app.post('/api/system/backup', authenticateToken, requirePermission('system:backup'), async (req, res) => {
  try {
    const result = await sq.createBackup(req.user.id, req.user.username);
    res.json({ success: true, message: `Yedek alındı: ${result.folderName}`, data: result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Yedekleri Listele
app.get('/api/system/backups', authenticateToken, requirePermission('system:backup'), (req, res) => {
  res.json({ success: true, data: sq.listBackups() });
});

// Yedekten Geri Yükle
app.post('/api/system/restore', authenticateToken, requirePermission('system:restore'), async (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ success: false, message: 'Klasör adı zorunludur.' });
  try {
    const result = await sq.restoreBackup(folderName, req.user.id, req.user.username);
    res.json({
      success: true,
      message: `Geri yükleme başarılı. Önceki durum '${result.safetyBackup}' olarak saklandı.`
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Denetim Günlüğü (Sadece admin)
app.get('/api/system/audit-logs', authenticateToken, requirePermission('system:audit_view'), (req, res) => {
  const logs = sq.getAuditLogs(200);
  res.json({ success: true, count: logs.length, data: logs });
});

// Sistem Ayarları
app.get('/api/system/settings', authenticateToken, requirePermission('system:settings_view'), (req, res) => {
  res.json({ success: true, data: sq.getAllSettings() });
});

app.post('/api/system/settings', authenticateToken, requirePermission('system:settings_edit'), (req, res) => {
  const allowedKeys = ['magaza_adi', 'varsayilan_kdv', 'min_stok_limiti', 'fis_baslik',
                       'fis_adres', 'fis_telefon', 'fis_vergi_no', 'para_sembolu', 'termal_yazici_genislik'];
  const updates = Object.entries(req.body).filter(([k]) => allowedKeys.includes(k));
  updates.forEach(([k, v]) => sq.setSetting(k, v, req.user.id, req.user.username));
  res.json({ success: true, message: 'Ayarlar güncellendi.', data: sq.getAllSettings() });
});

// Kullanıcı Yönetimi
app.get('/api/system/users', authenticateToken, requirePermission('users:manage'), (req, res) => {
  res.json({ success: true, data: sq.getAllUsers() });
});

app.post('/api/system/users', authenticateToken, requirePermission('users:manage'), (req, res) => {
  const { username, password, fullName, role } = req.body;
  if (!username || !password || !fullName || !role) {
    return res.status(400).json({ success: false, message: 'Tüm alanlar zorunludur.' });
  }
  const policyErrors = validatePasswordPolicy(password);
  if (policyErrors.length > 0) {
    return res.status(400).json({ success: false, message: policyErrors.join(' ') });
  }
  if (sq.getUserByUsername(username)) {
    return res.status(400).json({ success: false, message: 'Bu kullanıcı adı zaten mevcut.' });
  }
  try {
    const id = sq.createUser({
      username: String(username).trim(), fullName, role,
      passwordHash: bcrypt.hashSync(password, 12),
      createdBy: req.user.id, createdByName: req.user.username
    });
    res.json({ success: true, message: 'Kullanıcı oluşturuldu.', data: { id } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Kullanıcı Durumu Değiştir (Aktif / Pasif)
app.put('/api/system/users/:id/status', authenticateToken, requirePermission('users:manage'), (req, res) => {
  const { active } = req.body;
  if (active === undefined) return res.status(400).json({ success: false, message: 'Durum (active) zorunludur.' });
  try {
    const result = sq.toggleUserStatus(req.params.id, !!active, req.user.id, req.user.username);
    res.json({ success: true, message: `Kullanıcı ${result.active ? 'aktif' : 'pasif'} yapıldı.`, data: result });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Kullanıcı Rolü Değiştir
app.put('/api/system/users/:id/role', authenticateToken, requirePermission('users:manage'), (req, res) => {
  const { role } = req.body;
  if (!role) return res.status(400).json({ success: false, message: 'Rol zorunludur.' });
  try {
    const result = sq.updateUserRole(req.params.id, role, req.user.id, req.user.username);
    res.json({ success: true, message: `Kullanıcı rolü güncellendi: ${role}`, data: result });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// ============================================================
// 8. RAPORLAMA
// ============================================================

// Satış Özet Raporu
app.get('/api/reports/sales-summary', authenticateToken, requirePermission('reports:view'), (req, res) => {
  const { period = 'daily', dateFrom, dateTo } = req.query;
  const db = sq.getDb();
  const isAdmin = req.user.role === 'admin';

  let groupBy, labelExpr;
  if (period === 'monthly') {
    groupBy = "strftime('%Y-%m', tarih)";
    labelExpr = "strftime('%Y-%m', tarih)";
  } else if (period === 'weekly') {
    groupBy = "strftime('%Y-W%W', tarih)";
    labelExpr = "strftime('%Y-W%W', tarih)";
  } else {
    groupBy = "date(tarih)";
    labelExpr = "date(tarih)";
  }

  let whereClauses = ["durum IN ('TAMAMLANDI', 'KISMI_IADE')"];
  const params = {};
  if (dateFrom) { whereClauses.push("date(tarih) >= @dateFrom"); params.dateFrom = dateFrom; }
  if (dateTo)   { whereClauses.push("date(tarih) <= @dateTo");   params.dateTo   = dateTo;   }
  const where = whereClauses.join(' AND ');

  const rows = db.prepare(`
    SELECT
      ${labelExpr} AS donem,
      COUNT(*) AS islem_sayisi,
      SUM(toplam_kalem_adedi) AS toplam_cift,
      SUM(net_satis_kurus) AS ciro_kurus,
      SUM(toplam_kdv_kurus) AS kdv_kurus,
      ${isAdmin ? 'SUM(net_kar_kurus) AS kar_kurus,' : ''}
      ${isAdmin ? 'SUM(toplam_maliyet_kurus) AS maliyet_kurus,' : ''}
      SUM(nakit_tahsilat_kurus) AS nakit_kurus,
      SUM(kart_tahsilat_kurus) AS kart_kurus
    FROM sales WHERE ${where}
    GROUP BY ${groupBy}
    ORDER BY donem DESC
    LIMIT 90
  `).all(params);

  res.json({ success: true, period, data: rows.map(r => ({
    donem: r.donem,
    islemSayisi: r.islem_sayisi,
    toplamCift: r.toplam_cift,
    ciro: sq.toTL(r.ciro_kurus),
    kdv: sq.toTL(r.kdv_kurus),
    nakit: sq.toTL(r.nakit_kurus),
    kart: sq.toTL(r.kart_kurus),
    ...(isAdmin ? { kar: sq.toTL(r.kar_kurus), maliyet: sq.toTL(r.maliyet_kurus) } : {})
  }))});
});

// Personel Performans Raporu
app.get('/api/reports/staff', authenticateToken, requirePermission('reports:view'), (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const db = sq.getDb();
  const isAdmin = req.user.role === 'admin';

  let whereClauses = ["durum IN ('TAMAMLANDI', 'KISMI_IADE')"];
  const params = {};
  if (dateFrom) { whereClauses.push("date(tarih) >= @dateFrom"); params.dateFrom = dateFrom; }
  if (dateTo)   { whereClauses.push("date(tarih) <= @dateTo");   params.dateTo   = dateTo;   }
  const where = whereClauses.join(' AND ');

  const rows = db.prepare(`
    SELECT
      kasiyer_adi,
      COUNT(*) AS islem_sayisi,
      SUM(toplam_kalem_adedi) AS toplam_cift,
      SUM(net_satis_kurus) AS ciro_kurus
      ${isAdmin ? ', SUM(net_kar_kurus) AS kar_kurus' : ''}
    FROM sales WHERE ${where}
    GROUP BY kasiyer_id
    ORDER BY ciro_kurus DESC
  `).all(params);

  res.json({ success: true, data: rows.map(r => ({
    kasiyerAdi: r.kasiyer_adi,
    islemSayisi: r.islem_sayisi,
    toplamCift: r.toplam_cift,
    ciro: sq.toTL(r.ciro_kurus),
    ...(isAdmin ? { kar: sq.toTL(r.kar_kurus) } : {})
  }))});
});

// İade Raporu
app.get('/api/reports/returns', authenticateToken, requirePermission('reports:view'), (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const db = sq.getDb();

  let whereClauses = ['1=1'];
  const params = {};
  if (dateFrom) { whereClauses.push("date(r.created_at) >= @dateFrom"); params.dateFrom = dateFrom; }
  if (dateTo)   { whereClauses.push("date(r.created_at) <= @dateTo");   params.dateTo   = dateTo;   }
  const where = whereClauses.join(' AND ');

  // returns tablosu: id, fis_no, sale_item_id, iade_adet, iade_tutari_kurus, iade_nedeni, stoğa_donus
  const rows = db.prepare(`
    SELECT
      r.id, r.fis_no, r.iade_nedeni, r.created_at,
      r.iade_adet,
      r.iade_tutari_kurus AS iade_toplam_kurus,
      r.stoğa_donus,
      p.model, p.barcode, p.numara
    FROM returns r
    LEFT JOIN sale_items si ON si.id = r.sale_item_id
    LEFT JOIN products p ON p.barcode = si.barcode
    WHERE ${where}
    ORDER BY r.created_at DESC
    LIMIT 200
  `).all(params);

  res.json({ success: true, count: rows.length, data: rows });
});

// Kritik Stok Raporu
app.get('/api/reports/low-stock', authenticateToken, requirePermission('reports:view'), (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const db = sq.getDb();
  const minStok = parseInt(req.query.minStok || sq.getSetting('min_stok_limiti') || '5', 10);
  const rows = db.prepare(
    `SELECT barcode, model, numara, renk, stok, min_stok FROM products WHERE stok <= @minStok AND stok >= 0 ORDER BY stok ASC LIMIT @limit`
  ).all({ minStok, limit });
  res.json({ success: true, minStokLimiti: minStok, data: rows });
});

// Kasa Oturumları Raporu
app.get('/api/reports/cash-sessions', authenticateToken, requirePermission('reports:view'), (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const db = sq.getDb();

  let whereClauses = ['1=1'];
  const params = {};
  // Gerçek şema: acilis_tarihi kolonu
  if (dateFrom) { whereClauses.push("date(cs.acilis_tarihi) >= @dateFrom"); params.dateFrom = dateFrom; }
  if (dateTo)   { whereClauses.push("date(cs.acilis_tarihi) <= @dateTo");   params.dateTo   = dateTo;   }
  const where = whereClauses.join(' AND ');

  const rows = db.prepare(`
    SELECT
      cs.*,
      cs.acilis_kasiyer_adi AS acilis_yapan
    FROM cash_sessions cs
    WHERE ${where}
    ORDER BY cs.acilis_tarihi DESC
    LIMIT 60
  `).all(params);

  res.json({ success: true, data: rows });
});

// ============================================================
// 9. SENKRONIZASYON GEÇMİŞİ
// ============================================================
app.get('/api/sync/history', authenticateToken, requirePermission('sync:history'), (req, res) => {
  res.json({ success: true, data: sq.getSyncHistory() });
});

// SPA yönlendirme
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'API uç noktası bulunamadı.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global hata yakalama
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'Dosya boyutu çok büyük (max 15MB).' });
  }
  console.error('[SERVER ERROR]', err.message, err.stack);
  res.status(500).json({ success: false, message: 'Sunucu hatası oluştu.' });
});

// Çökme önleyici işlem dinleyicileri
process.on('uncaughtException', (err) => {
  const msg = `[UNCAUGHT EXCEPTION] ${new Date().toISOString()} ${err.message}\n${err.stack}\n`;
  console.error(msg);
  try { fs.appendFileSync(path.join(__dirname, 'server_lifecycle.log'), msg); } catch (_) {}
});
process.on('unhandledRejection', (reason, promise) => {
  const msg = `[UNHANDLED REJECTION] ${new Date().toISOString()} ${reason}\n`;
  console.error(msg);
  try { fs.appendFileSync(path.join(__dirname, 'server_lifecycle.log'), msg); } catch (_) {}
});
process.on('exit', (code) => {
  const msg = `[PROCESS EXIT] ${new Date().toISOString()} Code: ${code}\n`;
  console.log(msg);
  try { fs.appendFileSync(path.join(__dirname, 'server_lifecycle.log'), msg); } catch (_) {}
});
process.on('SIGINT', () => {
  const msg = `[SIGINT RECEIVED] ${new Date().toISOString()}\n`;
  console.log(msg);
  try { fs.appendFileSync(path.join(__dirname, 'server_lifecycle.log'), msg); } catch (_) {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  const msg = `[SIGTERM RECEIVED] ${new Date().toISOString()}\n`;
  console.log(msg);
  try { fs.appendFileSync(path.join(__dirname, 'server_lifecycle.log'), msg); } catch (_) {}
  process.exit(0);
});

// === SUNUCU BAŞLAT ===
app.listen(PORT, () => {
  console.log('==========================================================');
  console.log(' YagzShoes Enterprise POS v2.6');
  console.log(` Veritabanı : SQLite WAL (${sq.DB_PATH})`);
  console.log(` Güvenlik   : JWT HS256 | Helmet | Rate Limiting | RBAC`);
  console.log(` Erişim     : http://localhost:${PORT} veya http://127.0.0.1:${PORT}`);
  console.log('==========================================================');
});
