/**
 * YagzShoes Enterprise — Güçlendirilmiş JWT & RBAC Auth Middleware
 * - JWT secret .env'den zorunlu okunur, hardcoded fallback YOK
 * - Algorithm whitelist: sadece HS256
 * - sessionVersion invalidation
 * - Rol bazlı izin sistemi (RBAC)
 * - Brute-force hesap kilitleme DB katmanında
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');

// JWT_SECRET ortam değişkeninden okunur — eksikse uygulama BAŞLAMAZ
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET ortam değişkeni tanımlı değil veya çok kısa!');
  console.error('[FATAL] Lütfen .env dosyasına en az 32 karakterlik güçlü bir JWT_SECRET ekleyin.');
  process.exit(1);
}

const JWT_ALGORITHM = 'HS256';
const TOKEN_EXPIRY = '10h'; // Çalışma vardiyası

// ============================================================
// RBAC — İzin Matrisi
// ============================================================
const PERMISSIONS = {
  // POS & Satış
  'pos:checkout':          ['admin', 'kasiyer'],
  'pos:refund':            ['admin', 'kasiyer'],
  'pos:cancel':            ['admin', 'kasiyer'],
  'sales:view':            ['admin', 'kasiyer', 'stok_sorumlusu', 'rapor_goruntuleme'],
  'sales:view_cost':       ['admin'],           // Alış fiyatı, kâr marjı
  
  // Stok
  'stock:view':            ['admin', 'kasiyer', 'stok_sorumlusu', 'rapor_goruntuleme'],
  'stock:adjust':          ['admin', 'stok_sorumlusu'],
  'stock:count':           ['admin', 'stok_sorumlusu'],
  'product:create':        ['admin', 'stok_sorumlusu'],
  'product:edit':          ['admin', 'stok_sorumlusu'],

  // Raporlama
  'reports:view':          ['admin', 'rapor_goruntuleme'],
  'reports:financial':     ['admin'],           // Sadece admin kâr/zarar raporlarını görebilir

  // Entegrasyon
  'sync:preview':          ['admin', 'stok_sorumlusu'],
  'sync:apply':            ['admin', 'stok_sorumlusu'],
  'sync:history':          ['admin', 'stok_sorumlusu', 'rapor_goruntuleme'],

  // Kasa
  'cash:open':             ['admin', 'kasiyer'],
  'cash:close':            ['admin', 'kasiyer'],
  'cash:view':             ['admin', 'kasiyer', 'rapor_goruntuleme'],

  // Sistem
  'system:backup':         ['admin'],
  'system:restore':        ['admin'],
  'system:audit_view':     ['admin'],
  'system:settings_view':  ['admin', 'stok_sorumlusu', 'kasiyer'],
  'system:settings_edit':  ['admin'],
  'users:manage':          ['admin'],
};

function hasPermission(role, permission) {
  const allowed = PERMISSIONS[permission];
  return allowed ? allowed.includes(role) : false;
}

// Token Üretimi
function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      fullName: user.full_name || user.fullName,
      role: user.role,
      sessionVersion: user.session_version || 0
    },
    JWT_SECRET,
    { algorithm: JWT_ALGORITHM, expiresIn: TOKEN_EXPIRY }
  );
}

// Kimlik Doğrulama Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  if (!token) {
    return res.status(401).json({
      success: false, code: 'AUTH_REQUIRED',
      message: 'Bu işlem için yetkili oturum gereklidir.'
    });
  }

  try {
    // Algorithm whitelist — 'none' algoritması kesinlikle kabul edilmez
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });

    // sessionVersion kontrolü: şifre değişince eski tokenlar geçersizleşir
    const { getUserById } = require('../data/sqlite');
    const currentUser = getUserById(payload.id);
    if (!currentUser || !currentUser.active) {
      return res.status(403).json({ success: false, code: 'USER_INACTIVE', message: 'Hesap pasif veya bulunamadı.' });
    }
    if (payload.sessionVersion === undefined || currentUser.session_version > payload.sessionVersion) {
      return res.status(401).json({
        success: false, code: 'SESSION_INVALIDATED',
        message: 'Oturumunuz sonlandırılmış. Lütfen tekrar giriş yapın.'
      });
    }

    req.user = {
      id: currentUser.id, username: currentUser.username,
      fullName: currentUser.full_name || payload.fullName, role: currentUser.role,
      sessionVersion: currentUser.session_version
    };

    // İlk giriş şifre değiştirme zorlaması — sadece güvenli şifre değiştirme/çıkış/bilgi rotalarına izin ver
    const allowedMustChangePaths = ['/api/auth/change-password', '/api/auth/logout', '/api/auth/me'];
    if (currentUser.must_change_password && !allowedMustChangePaths.includes(req.path)) {
      return res.status(403).json({
        success: false, code: 'MUST_CHANGE_PASSWORD',
        message: 'İlk girişinizde şifrenizi değiştirmeniz zorunludur.'
      });
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, code: 'TOKEN_EXPIRED', message: 'Oturum süreniz doldu.' });
    }
    return res.status(403).json({ success: false, code: 'TOKEN_INVALID', message: 'Geçersiz oturum.' });
  }
}

// Yetki Denetimi — Rol Bazlı (Geriye dönük uyumluluk)
function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Kimlik doğrulanamadı.' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false, code: 'FORBIDDEN',
        message: `Bu işlem için yetkiniz yok. Rolünüz: ${req.user.role}`
      });
    }
    next();
  };
}

// Yetki Denetimi — İzin Bazlı (Tercih edilen)
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Kimlik doğrulanamadı.' });
    if (!hasPermission(req.user.role, permission)) {
      const { logAudit } = require('../data/sqlite');
      logAudit({
        userId: req.user.id, username: req.user.username,
        action: 'UNAUTHORIZED_ACCESS', sonuc: 'ENGELLENDI',
        ipAdresi: req.ip, details: `İzin: ${permission}, Rol: ${req.user.role}`
      });
      return res.status(403).json({
        success: false, code: 'FORBIDDEN',
        message: `Bu işlem için '${permission}' izni gereklidir.`
      });
    }
    next();
  };
}

// Parola Politikası Doğrulama
function validatePasswordPolicy(password) {
  const errors = [];
  if (!password || password.length < 8) errors.push('Şifre en az 8 karakter olmalıdır.');
  if (!/[A-Z]/.test(password)) errors.push('En az bir büyük harf içermelidir.');
  if (!/[a-z]/.test(password)) errors.push('En az bir küçük harf içermelidir.');
  if (!/[0-9]/.test(password)) errors.push('En az bir rakam içermelidir.');
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) {
    errors.push('En az bir özel karakter (!@#$%^&* vb.) içermelidir.');
  }
  if (/^(admin|kasiyer|stok|password|123456|yagz|shoes)/i.test(password)) {
    errors.push('Bu şifre çok tahmin edilebilir. Farklı bir şifre seçin.');
  }
  return errors;
}

module.exports = {
  JWT_SECRET, JWT_ALGORITHM, TOKEN_EXPIRY,
  generateToken, authenticateToken, authorizeRoles,
  requirePermission, hasPermission, validatePasswordPolicy, PERMISSIONS
};
