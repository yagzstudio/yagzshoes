/**
 * YagzShoes Enterprise POS — Master Prompt 02 Operasyonel & Güvenlik Ek Test Paketi
 */
require('dotenv').config();
const http = require('http');

const PORT = process.env.TEST_PORT || process.env.PORT || 3000;
const BASE = process.env.TEST_URL || `http://127.0.0.1:${PORT}`;
let results = [];

// Canlı ortam koruması
if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_TESTS_ON_PRODUCTION) {
  console.error('\n🛑 [GÜVENLİK ENGELİ] Canlı üretim ortamında (NODE_ENV=production) operasyonel test çalıştırmak engellendi.\n');
  process.exit(1);
}

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: {
        'Content-Type': 'application/json',
        'x-test-mode': 'true',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const r = http.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function test(name, passed, detail = '') {
  const status = passed ? '✅ GEÇTI' : '❌ BAŞARISIZ';
  results.push({ name, passed, detail });
  console.log(`${status} | ${name}${detail ? ` — ${detail}` : ''}`);
}

async function runOperationalTests() {
  console.log('\n========= MASTER PROMPT 02: OPERASYONEL & EK GÜVENLİK TESTLERİ =========\n');

  // 1. Setup Status API
  const setupStatus = await req('GET', '/api/auth/setup-status');
  test('O1. İlk Kurulum Durum API çalışıyor',
    setupStatus.status === 200 && setupStatus.body?.success,
    `isSetupComplete: ${setupStatus.body?.isSetupComplete}, hasAdmin: ${setupStatus.body?.hasAdmin}`);

  // Admin Login
  const adminLogin = await req('POST', '/api/auth/login', { username: 'admin', password: 'Magaza@2026#Admin' });
  const adminToken = adminLogin.body?.token;
  test('O2. Admin oturumu açıldı', adminLogin.status === 200 && !!adminToken);

  // Kasiyer Login
  const kasLogin = await req('POST', '/api/auth/login', { username: 'kasiyer', password: 'Magaza@2026#Kas' });
  const kasToken = kasLogin.body?.token;
  test('O3. Kasiyer oturumu açıldı', kasLogin.status === 200 && !!kasToken);

  // 4. Kasiyer Alış Fiyatı İzolasyonu (/api/products)
  const prodsKas = await req('GET', '/api/products', null, kasToken);
  const kasHasAlisFiyati = prodsKas.body?.data?.some(p => p.alisFiyati !== undefined || p.alis_fiyati_kurus !== undefined);
  test('O4. Kasiyer ürün alış fiyatlarını GÖREMEZ (/api/products)',
    prodsKas.status === 200 && !kasHasAlisFiyati,
    'Alış fiyatı başarıyla gizlendi');

  // 5. Kasiyer Fiyat Geçmişi İzolasyonu
  const priceHistoryKas = await req('GET', '/api/products/price-history/869000102', null, kasToken);
  test('O5. Kasiyer fiyat geçmişine erişemez (RBAC 403)',
    priceHistoryKas.status === 403,
    `HTTP ${priceHistoryKas.status}: ${priceHistoryKas.body?.code}`);

  // 6. Admin Fiyat Geçmişi Erişimi
  const priceHistoryAdmin = await req('GET', '/api/products/price-history/869000102', null, adminToken);
  test('O6. Admin fiyat geçmişini görüntüleyebilir',
    priceHistoryAdmin.status === 200 && priceHistoryAdmin.body?.success);

  // 7. Kasa Açma & Nakit Giriş / Çıkış (Masraf)
  const activeCash = await req('GET', '/api/cash/active', null, adminToken);
  let sessionId = activeCash.body?.data?.id;
  if (!sessionId) {
    const openRes = await req('POST', '/api/cash/open', { acilisNakit: 1000 }, adminToken);
    sessionId = openRes.body?.sessionId;
  }

  const cashIn = await req('POST', '/api/cash/transaction', {
    sessionId, islemTuru: 'GIRIS', tutar: 250, kategori: 'Kasa Nakit Takviyesi', aciklama: 'Bozuk para'
  }, adminToken);
  test('O7. Kasaya nakit girişi kaydedildi',
    cashIn.status === 200 && cashIn.body?.success,
    `Tutar: ₺${cashIn.body?.data?.tutarTL}`);

  const cashOut = await req('POST', '/api/cash/transaction', {
    sessionId, islemTuru: 'CIKIS', tutar: 50, kategori: 'Masraf', aciklama: 'Kırtasiye harcaması'
  }, adminToken);
  test('O8. Kasadan nakit çıkışı (masraf) kaydedildi',
    cashOut.status === 200 && cashOut.body?.success,
    `Tutar: ₺${cashOut.body?.data?.tutarTL}`);

  // 8. Stok Sayımı (Inventory Count)
  const countRes = await req('POST', '/api/stock/count', {
    items: [
      { barcode: '869000102', sayilanAdet: 10 },
      { barcode: '869000201', sayilanAdet: 10 }
    ],
    aciklama: 'Master Prompt 02 Otomasyon Test Sayımı'
  }, adminToken);
  test('O9. Stok sayım fişi ve fark düzeltmesi başarıyla işlendi',
    countRes.status === 200 && countRes.body?.success,
    `Toplam fark: ${countRes.body?.data?.toplamFarkAdet} adet`);

  // 9. Kasiyer Kullanıcı Yönetemez
  const kasUserManage = await req('GET', '/api/system/users', null, kasToken);
  test('O10. Kasiyer kullanıcı listesini göremez (RBAC 403)',
    kasUserManage.status === 403,
    `HTTP ${kasUserManage.status}: ${kasUserManage.body?.code}`);

  // 10. Bölünmüş Ödeme Testi (Nakit + Kredi Kartı)
  const splitSale = await req('POST', '/api/pos/checkout', {
    items: [{ barkod: '869000102', adet: 1 }],
    nakitTutar: 2000,
    kartTutar: 2200 // Toplam 4200 TL
  }, adminToken);
  test('O11. Bölünmüş ödeme kaydı (2000₺ Nakit + 2200₺ Kart)',
    splitSale.status === 200 && splitSale.body?.data?.odemeTuru === 'Bölünmüş',
    `Ödeme Türü: ${splitSale.body?.data?.odemeTuru}, Fiş: ${splitSale.body?.data?.fisNo}`);

  // Payments tablosu kontrolü
  const { getDb } = require('../data/sqlite');
  const payments = getDb().prepare("SELECT * FROM payments WHERE fis_no=?").all(splitSale.body?.data?.fisNo);
  test('O12. Payments tablosuna nakit ve kart ayrı ayrı işlendi',
    payments.length === 2 && payments.some(p => p.odeme_yontemi === 'Nakit') && payments.some(p => p.odeme_yontemi === 'Kredi Kartı'),
    `Ödeme kayıt adedi: ${payments.length}`);

  // Kasa Kapat
  if (sessionId) {
    await req('POST', '/api/cash/close', {
      sessionId, sayilanNakit: 5000, kapanisNotu: 'Operasyonel test sonu kapanışı'
    }, adminToken);
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log('\n=================================================================');
  console.log(`Operasyonel Test Sonucu: Toplam: ${results.length} | GEÇEN: ${passed} ✅ | BAŞARISIZ: ${failed} ❌`);
  console.log('=================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runOperationalTests().catch(e => {
  console.error('[OPERATIONAL TEST HATA]', e.message);
  process.exit(1);
});
