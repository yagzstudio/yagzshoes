# YagzShoes Enterprise POS & Stok Yönetim Sistemi v2.7

## Hızlı Başlatma

Sistemi başlatmak için aşağıdaki yöntemlerden birini kullanabilirsiniz:

### 1. Tek Tıkla Başlatma (En Kolay)
* Proje klasöründeki **`baslat.bat`** (veya **`start.bat`**) dosyasına **çift tıklayın**.
* Gerekli kontroller otomatik yapılır, sunucu başlatılır ve varsayılan tarayıcınızda `http://localhost:3000` adresi otomatik açılır.

### 2. Masaüstü Kısayolu Oluşturma
* `scripts/create_desktop_shortcut.bat` dosyasına çift tıklayarak Windows masaüstünüze doğrudan **"YagzShoes POS"** kısayolu ekleyebilirsiniz.

### 3. Komut Satırından Başlatma
```powershell
# Proje dizininde:
npm start

# veya PowerShell ile:
.\baslat.ps1
```

---

## Sunucuyu Durdurma

Sunucuyu kapatmak için 3 pratik yol vardır:

1. **Tek Tıkla Durdurma:** Proje klasöründeki **`durdur.bat`** (veya **`stop.bat`**) dosyasına **çift tıklayın**. Arka planda 3000 portunu dinleyen sunucuyu anında ve güvenle kapatır.
2. **Komut Penceresinden:** Açık olan siyah sunucu komut penceresinde klavyeden **`Ctrl + C`** yapın veya pencereyi kapatın (**X**).
3. **NPM / PowerShell ile:**
   ```powershell
   npm stop
   # veya
   .\durdur.ps1
   ```

---

## Testleri Çalıştırma

Tüm güvenlik, veri tabanı ve operasyonel testleri çalıştırmak için:
```powershell
npm run test:all
```
