const xlsx = require('xlsx');
const path = require('path');

const sampleData = [
  { "Barkod": "869000101", "Model": "Nike Air Force 1 '07 Beyaz Sneaker", "Numara": 41, "Alış Fiyatı": 2400, "Satış Fiyatı": 4200, "Stok": 1, "KDV": 10 },
  { "Barkod": "869000102", "Model": "Nike Air Force 1 '07 Beyaz Sneaker", "Numara": 42, "Alış Fiyatı": 2400, "Satış Fiyatı": 4200, "Stok": 5, "KDV": 10 },
  { "Barkod": "869000103", "Model": "Nike Air Force 1 '07 Beyaz Sneaker", "Numara": 43, "Alış Fiyatı": 2400, "Satış Fiyatı": 4200, "Stok": 8, "KDV": 10 },
  { "Barkod": "869000201", "Model": "Adidas Stan Smith Klasik", "Numara": 40, "Alış Fiyatı": 1800, "Satış Fiyatı": 3200, "Stok": 6, "KDV": 10 },
  { "Barkod": "869000202", "Model": "Adidas Stan Smith Klasik", "Numara": 41, "Alış Fiyatı": 1800, "Satış Fiyatı": 3200, "Stok": 1, "KDV": 10 },
  { "Barkod": "869000301", "Model": "Puma Suede Vintage Siyah", "Numara": 42, "Alış Fiyatı": 1500, "Satış Fiyatı": 2750, "Stok": 12, "KDV": 10 },
  { "Barkod": "869000401", "Model": "New Balance 550 Beyaz/Gri", "Numara": 43, "Alış Fiyatı": 2800, "Satış Fiyatı": 4900, "Stok": 3, "KDV": 10 },
  { "Barkod": "869000501", "Model": "Vans Old Skool Classic", "Numara": 39, "Alış Fiyatı": 1200, "Satış Fiyatı": 2199, "Stok": 1, "KDV": 10 },
  { "Barkod": "869000601", "Model": "Converse Chuck Taylor All Star", "Numara": 42, "Alış Fiyatı": 1350, "Satış Fiyatı": 2490, "Stok": 4, "KDV": 10 }
];

const worksheet = xlsx.utils.json_to_sheet(sampleData);
const workbook = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(workbook, worksheet, "GunlukStokListesi");

const exportPath = path.join(__dirname, 'patron_gunluk_stok.xlsx');
xlsx.writeFile(workbook, exportPath);
console.log("Örnek Excel dosyası oluşturuldu:", exportPath);
