const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'public', 'index.html');
let html = fs.readFileSync(filePath, 'utf8');

// 1. Setup functions
const setupFuncs = `
    // Ilk Kurulum Yonetimi
    function showSetupModal() {
      const el = document.getElementById('setupOverlay');
      if (el) { el.classList.remove('hidden'); el.classList.add('flex'); }
    }

    function hideSetupModal() {
      const el = document.getElementById('setupOverlay');
      if (el) { el.classList.add('hidden'); el.classList.remove('flex'); }
    }

    async function handleSetupAdmin(e) {
      e.preventDefault();
      const magazaAdi = document.getElementById('setupMagazaAdi').value.trim();
      const fullName = document.getElementById('setupFullName').value.trim();
      const username = document.getElementById('setupUsername').value.trim();
      const password = document.getElementById('setupPassword').value;
      const confirmPassword = document.getElementById('setupConfirmPassword').value;
      const errBox = document.getElementById('setupError');
      errBox.classList.add('hidden');

      if (password !== confirmPassword) {
        errBox.textContent = 'Parolalar eslesmiyor!';
        errBox.classList.remove('hidden');
        return;
      }

      try {
        const res = await fetch('/api/auth/setup-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, confirmPassword, fullName, magazaAdi })
        });
        const data = await res.json();
        if (data.success) {
          authToken = data.token;
          currentUser = data.user;
          localStorage.setItem('yagzshoes_token', authToken);
          hideSetupModal();
          updateHeaderUserInfo();
          navigateTo('dashboard');
          showToast('Ilk kurulum basariyla tamamlandi. Hos geldiniz!', 'success');
        } else {
          errBox.textContent = data.message || 'Kurulum basarisiz!';
          errBox.classList.remove('hidden');
        }
      } catch (err) {
        errBox.textContent = 'Sunucu baglanti hatasi!';
        errBox.classList.remove('hidden');
      }
    }

    async function executeSaleCancel(fisNo) {
      const iptalNedeni = prompt('\"' + fisNo + '\" numarali satisi iptal etmek istediginize emin misiniz?\\nIptal Nedeni Girin:', 'Musteri talebi / Yanlis fis');
      if (iptalNedeni === null) return;

      try {
        const res = await fetch('/api/pos/cancel', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + authToken
          },
          body: JSON.stringify({ fisNo, iptalNedeni: iptalNedeni.trim() || 'Musteri talebi' })
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message, 'success');
          loadSalesHistory();
          loadDashboardStats();
        } else {
          showToast(data.message || 'Iptal islemi basarisiz!', 'error');
        }
      } catch (e) {
        showToast('Iptal islemi esnasinda sunucu hatasi olustu!', 'error');
      }
    }
`;

if (!html.includes('function showSetupModal()')) {
  html = html.replace('function showLoginModal() {', setupFuncs + '\n    function showLoginModal() {');
}

// 2. DOMContentLoaded setup check
if (!html.includes('/api/auth/setup-status')) {
  html = html.replace(
    'initKeyboardListener();',
    `initKeyboardListener();

      try {
        const setupRes = await fetch('/api/auth/setup-status');
        const setupData = await setupRes.json();
        if (setupData.success && !setupData.isSetupComplete) {
          showSetupModal();
          return;
        }
      } catch (_) {}`
  );
}

// 3. Idempotency Key in executePosCheckout
if (!html.includes('idempotencyKey:')) {
  html = html.replace(
    'body: JSON.stringify({\n            items,',
    `body: JSON.stringify({
            idempotencyKey: 'IDEM-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase(),
            items,`
  );
}

// 4. Add "Iptal Et" button in sales history table
if (!html.includes('executeSaleCancel')) {
  html = html.replace(
    'class="text-xs text-rose-700 hover:text-rose-900 font-semibold">İade Et</button>',
    `class="text-xs text-rose-700 hover:text-rose-900 font-semibold">İade Et</button>
            <button onclick="executeSaleCancel('\${s.fisNo || s.fis_no || \\'\\'}')" class="text-xs text-slate-500 hover:text-red-700 font-semibold ml-2">İptal Et</button>`
  );
}

fs.writeFileSync(filePath, html, 'utf8');
console.log('✅ Frontend patched successfully with Setup Wizard, Idempotency, and Sale Cancellation!');
