import fs from 'node:fs';
const p='D:/Coding/Enexcite/mobile-app/android/app/src/main/assets/tts/en_US-lessac-medium.onnx.json';
const m=JSON.parse(fs.readFileSync(p,'utf8'));
const map=m.phoneme_id_map;
const ks=Object.keys(map);
console.log('TOTAL', ks.length);
console.log('ALL KEYS:', ks.join(' '));
// show type
console.log('sample val type:', Array.isArray(map[ks[0]])?'array':'other', typeof map[ks[0]]);
