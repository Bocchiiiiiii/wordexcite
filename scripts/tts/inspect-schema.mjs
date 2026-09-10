import fs from 'node:fs';
const d=JSON.parse(fs.readFileSync('D:/Coding/Enexcite/words/knowledge-cet6.json','utf8'));
const w=Object.values(d).find(x=>x&&x.en);
const mk=w.meanings&&w.meanings[0];
console.log('meaning keys:', mk?Object.keys(mk).join(','):'none');
console.log('meaning[0]:', JSON.stringify(mk).slice(0,500));
console.log('phrases[0]:', w.phrases&&JSON.stringify(w.phrases[0]).slice(0,200));
const anyW=Object.values(d).find(x=>x.meanings&&x.meanings.some(m=>m&&typeof m.example==='string'&&m.example));
console.log('has example english?', !!anyW);
