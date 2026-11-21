/* Timelace service worker: offline copy of the app + reminders that arrive even when the app is closed.
   The push message itself carries nothing private: it only says "wake up". The reminder text is read
   from this device's own storage (the app keeps an up-to-date list there). */
const C='timelace-v4',F=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.all(F.map(u=>c.add(u).catch(()=>{})))));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;
e.respondWith(fetch(e.request).then(r=>{if(r&&r.ok&&e.request.url.startsWith(self.location.origin)){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp)).catch(()=>{})}return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))))});

/* tiny key-value store shared with the app (IndexedDB "timelace-push") */
function db(){return new Promise((ok,no)=>{const r=indexedDB.open('timelace-push',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)})}
async function kvGet(k){const d=await db();return new Promise(ok=>{const q=d.transaction('kv').objectStore('kv').get(k);q.onsuccess=()=>ok(q.result);q.onerror=()=>ok(undefined)})}
async function kvSet(k,v){const d=await db();return new Promise(ok=>{const t=d.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=()=>ok();t.onerror=()=>ok()})}

self.addEventListener('push',e=>{e.waitUntil((async()=>{
  const now=Date.now();
  try{await kvSet('lastPush',now)}catch(x){}                /* the app shows this, to tell "never arrived" from "arrived but hidden" */
  try{
  let rem=[],shown={};
  try{rem=(await kvGet('rem'))||[];shown=(await kvGet('shown'))||{}}catch(x){}
  const due=rem.filter(r=>r&&r.at<=now+90000&&r.at>now-20*60000&&!shown[r.tag]);
  const wins=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const open=wins.some(w=>w.visibilityState==='visible');
  const test=due.filter(r=>String(r.tag).startsWith('t|'));
  if(open&&due.length&&!test.length)return;           /* the app is on screen: it rings the reminder itself (a test always shows) */
  if(!due.length){if(!open)await self.registration.showNotification('Timelace',{body:'Open Timelace to see what is next.',tag:'tl-wake',icon:'icon-192.png',badge:'icon-192.png'});return}
  for(const r of due.slice(0,4)){
    await self.registration.showNotification(r.title,{body:r.body||'',tag:r.tag,icon:'icon-192.png',badge:'icon-192.png',renotify:true,requireInteraction:!!r.alarm,vibrate:[200,100,200],data:{url:'./'}});
    shown[r.tag]=now;
  }
  Object.keys(shown).forEach(k=>{if(now-shown[k]>3*864e5)delete shown[k]});
  try{await kvSet('shown',shown)}catch(x){}
  }catch(err){
    /* never stay silent: if anything above failed, still show something */
    try{await self.registration.showNotification('Timelace',{body:'You have a reminder. Open Timelace to see it.',tag:'tl-wake',icon:'icon-192.png'})}catch(x){}
  }
})())});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil((async()=>{
  const wins=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const w of wins){if('focus' in w)return w.focus()}
  return self.clients.openWindow((e.notification.data&&e.notification.data.url)||'./');
})())});
