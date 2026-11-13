const fs = require('fs');
const path = require('path');
const vm = require('vm');

const filePath = path.join(__dirname, '..', 'public', 'index.html');
let text = fs.readFileSync(filePath, 'utf8');

text = text.replace(/\u00C5\u009E/g, 'Ş');
text = text.replace(/\u00C4\u009E/g, 'Ğ');
text = text.replace(/\u00EF\u00B8\u008F/g, '');
text = text.replace(/\u00EF\u00B8/g, '');

fs.writeFileSync(filePath, text, 'utf8');

const suspicious = text.match(/[\u00C0-\u00FF][\u0080-\u00BF]/g);
console.log('Suspicious remaining:', suspicious ? suspicious.length : 0);
if (suspicious) {
  console.log('Uniq:', [...new Set(suspicious)]);
} else {
  console.log('🎉 100% clean UTF-8 text!');
}
