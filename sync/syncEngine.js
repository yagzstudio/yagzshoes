/**
 * YagzShoes Enterprise Modular Sync Engine
 * Desteklenen Formatlar: Excel (.xlsx, .xls), CSV (.csv)
 * Tasarım Deseni: Strategy & Factory Pattern
 * Güvenlik: Sütun doğrulaması, tip denetimi, barkod formatı teyidi, simülasyon (dry-run)
 */
const fs = require('fs');
const xlsx = require('xlsx');

class SyncProvider {
  async parse(filePath, options = {}) {
    throw new Error('parse metodu türetilen sınıfta uygulanmalıdır');
  }
}

class ExcelSyncProvider extends SyncProvider {
  async parse(filePath, options = {}) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Dosya bulunamadı: ${filePath}`);
    }

    const workbook = xlsx.readFile(filePath);
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new Error('Excel dosyasında geçerli bir çalışma sayfası bulunamadı.');
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawData = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (!rawData || rawData.length === 0) {
      throw new Error('Dosya içeriği boş veya okunamadı.');
    }

    const validRows = [];
    const invalidRows = [];
    const seenBarcodes = new Set();

    rawData.forEach((row, index) => {
      const rowIndex = index + 2; // Başlık 1. satır

      // Sütun eşleştirme (Esnek başlık yakalama)
      let barkodRaw = row['Barkod'] ?? row['barkod'] ?? row['BARKOD'] ?? row['Barcode'] ?? row['BARCODE'] ?? '';
      let barkod = String(barkodRaw).trim();
      if (typeof barkodRaw === 'number' && !Number.isInteger(barkodRaw)) {
        barkod = barkodRaw.toFixed(0);
      }

      const model = String(
        row['Model'] || row['model'] || row['MODEL'] || row['Ürün Adı'] || row['Urun Adi'] || row['Name'] || ''
      ).trim();

      const marka = String(
        row['Marka'] || row['marka'] || row['MARKA'] || row['Brand'] || 'Belirtilmedi'
      ).trim();

      const renk = String(
        row['Renk'] || row['renk'] || row['RENK'] || row['Color'] || 'Standart'
      ).trim();

      const numaraRaw = row['Numara'] ?? row['numara'] ?? row['NUMARA'] ?? row['Beden'] ?? row['Size'] ?? 40;
      const numara = parseFloat(String(numaraRaw).replace(',', '.'));

      const alisRaw = row['Alış Fiyatı'] ?? row['Alis Fiyati'] ?? row['Alis'] ?? row['Maliyet'] ?? row['Cost'] ?? 0;
      const alisFiyati = Math.round((parseFloat(String(alisRaw).replace(',', '.')) || 0) * 100) / 100;

      const satisRaw = row['Satış Fiyatı'] ?? row['Satis Fiyati'] ?? row['Satis'] ?? row['Price'] ?? 0;
      const satisFiyati = Math.round((parseFloat(String(satisRaw).replace(',', '.')) || 0) * 100) / 100;

      const stokRaw = row['Stok'] ?? row['stok'] ?? row['STOK'] ?? row['Adet'] ?? row['Miktar'] ?? row['Stock'] ?? 0;
      const stok = parseInt(stokRaw, 10);

      let kdvRaw = row['KDV'] ?? row['kdv'] ?? row['Kdv'] ?? row['KDV Oranı'] ?? row['kdvOrani'];
      if (typeof kdvRaw === 'string') {
        kdvRaw = kdvRaw.replace('%', '').trim();
      }
      let kdvOrani = 10;
      if (kdvRaw !== undefined && kdvRaw !== null && kdvRaw !== '') {
        const parsedKdv = parseInt(kdvRaw, 10);
        if (!isNaN(parsedKdv) && parsedKdv >= 0 && parsedKdv <= 100) {
          kdvOrani = parsedKdv;
        }
      }

      // Hata Denetimleri
      const errors = [];
      if (!barkod) errors.push('Barkod alanı boş.');
      if (barkod && barkod.length < 3) errors.push('Barkod geçersiz veya çok kısa.');
      if (!model) errors.push('Model/Ürün adı boş.');
      if (isNaN(numara) || numara < 15 || numara > 55) errors.push(`Geçersiz numara/beden (${numaraRaw}).`);
      if (isNaN(alisFiyati) || alisFiyati < 0) errors.push('Alış fiyatı geçersiz.');
      if (isNaN(satisFiyati) || satisFiyati < 0) errors.push('Satış fiyatı geçersiz.');
      if (isNaN(stok) || stok < 0) errors.push('Stok miktarı negatif veya geçersiz.');

      if (barkod && seenBarcodes.has(barkod)) {
        errors.push(`Yinelenen barkod (Dosya içinde birden fazla kez geçiyor: ${barkod})`);
      } else if (barkod) {
        seenBarcodes.add(barkod);
      }

      if (errors.length > 0) {
        invalidRows.push({
          satir: rowIndex,
          barkod: barkod || '-',
          model: model || '-',
          hatalar: errors
        });
      } else {
        validRows.push({
          satir: rowIndex,
          barkod,
          marka,
          model,
          renk,
          numara,
          alisFiyati,
          satisFiyati,
          stok,
          minStok: 2,
          kdvOrani,
          aktif: true
        });
      }
    });

    return {
      toplamSatir: rawData.length,
      gecerliAdet: validRows.length,
      hataliAdet: invalidRows.length,
      validRows,
      invalidRows
    };
  }
}

// Fabrika / Yönetici Sınıfı
class SyncManager {
  constructor() {
    this.providers = {
      excel: new ExcelSyncProvider(),
      csv: new ExcelSyncProvider()
    };
  }

  getProvider(type = 'excel') {
    const p = this.providers[type.toLowerCase()];
    if (!p) throw new Error(`Desteklenmeyen senkronizasyon tipi: ${type}`);
    return p;
  }
}

module.exports = {
  SyncManager,
  ExcelSyncProvider
};
