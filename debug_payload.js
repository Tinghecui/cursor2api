const fs = require('fs');
const txt = fs.readFileSync('last_payload.json', 'utf8');
const payload = JSON.parse(txt);
payload.forEach((m, i) => {
    const text = m.parts && m.parts[0] && m.parts[0].text ? m.parts[0].text : '';
    console.log(`--- Message ${i} [${m.role}] ---`);
    console.log(text.substring(0, 300));
    console.log('');
});
