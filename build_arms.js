const fs=require('fs');
const src=fs.readFileSync('public/index.html','utf8');
const anchor='<script>\nconst BUDGET = 100;';
if(!src.includes(anchor)){console.error('ANCHOR NOT FOUND');process.exit(1);}
const arms={noai:'public/index_noai.html',generic:'public/index_generic.html',tca:'public/index_tca.html'};
for(const [arm,out] of Object.entries(arms)){
  fs.writeFileSync(out, src.replace(anchor, `<script>\nwindow.FORCED_ARM=${JSON.stringify(arm)};\nconst BUDGET = 100;`));
  console.log('wrote',out);
}
