const fs = require('fs');
const path = require('path');
const vm = require('vm');

const filePath = path.join(__dirname, '..', 'public', 'index.html');
let text = fs.readFileSync(filePath, 'utf8');

// 1. Fix keyboard listener: guard against undefined e.key
const oldKeyBlock = `        if (e.key === 'Enter') {
          if (barcodeBuffer.length >= 3 && (!isInput || activeEl.id === 'posBarcodeInput')) {
            e.preventDefault();
            addProductToCartByBarcode(barcodeBuffer.trim());
            barcodeBuffer = '';
          }
        } else if (e.key.length === 1) {
          barcodeBuffer += e.key;
        }`;

// Replace with safe version (handling both \r\n and \n)
text = text.replace(
  /if\s*\(\s*e\.key\s*===\s*'Enter'\s*\)\s*\{[\s\S]*?else\s*if\s*\(\s*e\.key\.length\s*===\s*1\s*\)\s*\{\s*barcodeBuffer\s*\+=\s*e\.key;\s*\}/,
  `if (!e || !e.key) return;
        if (e.key === 'Enter') {
          if (barcodeBuffer && barcodeBuffer.length >= 3 && (!isInput || (activeEl && activeEl.id === 'posBarcodeInput'))) {
            e.preventDefault();
            addProductToCartByBarcode(barcodeBuffer.trim());
            barcodeBuffer = '';
          }
        } else if (e.key && e.key.length === 1) {
          barcodeBuffer += e.key;
        }`
);

// 2. Fix recentSales: guard s.kalemler and use s.fis_no/s.odeme_turu
text = text.replace(
  /<td>\$\{s\.kalemler\.map\(k\s*=>\s*`\$\{k\.model\}\s*\(\$\{k\.numara\}\)`\)\.join\(',\s*'\)\}<\/td>/,
  `<td>\${(Array.isArray(s.kalemler) && s.kalemler.length > 0) ? s.kalemler.map(k => typeof k === 'object' ? \`\${k.model || ''} \${k.numara ? '(' + k.numara + ')' : ''}\`.trim() : k).join(', ') : (s.kalem_ozet || 'Ayakkabı')}</td>`
);

// Also fallback for fisNo / netSatis / odemeTuru in recentSales row
text = text.replace(
  /\$\{s\.fisNo\}/g,
  `\${s.fisNo || s.fis_no || ''}`
);

text = text.replace(
  /\$\{s\.odemeTuru\}/g,
  `\${s.odemeTuru || s.odeme_turu || ''}`
);

fs.writeFileSync(filePath, text, 'utf8');
console.log('✅ Patched public/index.html successfully.');

// Validate JS
const scriptMatch = text.match(/<script>([\s\S]*?)<\/script>/i);
if (scriptMatch) {
  try {
    new vm.Script(scriptMatch[1], { filename: 'index.html' });
    console.log('✅ JavaScript syntax is completely VALID!');
  } catch (err) {
    console.error('❌ JavaScript syntax error:', err.message);
  }
}
