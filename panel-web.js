/**
 * Wolfric Web Panel — panel profesional de control
 * Puerto: PANEL_PORT (default 3000)
 * Clave: PANEL_KEY (env). Si no se define, se genera una sola vez y se
 * guarda en panel_key.txt para que el panel NUNCA quede abierto por defecto.
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PANEL_PORT = Number(process.env.PANEL_PORT || 3000)
const PANEL_KEY_FILE = path.join(process.cwd(), 'panel_key.txt')

let PANEL_KEY = process.env.PANEL_KEY || ''
let panelKeyOrigen = PANEL_KEY ? 'variable de entorno' : ''
if (!PANEL_KEY) {
    try {
        if (fs.existsSync(PANEL_KEY_FILE)) {
            PANEL_KEY = fs.readFileSync(PANEL_KEY_FILE, 'utf8').trim()
            panelKeyOrigen = 'panel_key.txt'
        }
    } catch (_) {}
}
if (!PANEL_KEY) {
    PANEL_KEY = crypto.randomBytes(9).toString('hex')
    panelKeyOrigen = 'generada automáticamente'
    try { fs.writeFileSync(PANEL_KEY_FILE, PANEL_KEY) } catch (_) {}
}

function htmlPage() {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#0b1220"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<link rel="manifest" href="/manifest.json"/>
<title>Wolfric · Operations</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
:root{--bg:#0b1220;--card:#132033;--card2:#0f1a2b;--line:#24344a;--text:#e8eef6;--muted:#8fa3b8;--red:#b42318;--green:#12b76a;--blue:#175cd3;--accent:#c5a572;--radius:8px;--shadow:0 8px 24px #0003}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'IBM Plex Sans',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;background-image:linear-gradient(180deg,#0b1220,#0e1730)}
.shell{max-width:1180px;margin:0 auto;padding:18px 16px 48px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px}
.mark{width:44px;height:44px;border-radius:12px;background:linear-gradient(145deg,#1e3a5f,#0f172a);border:1px solid #c5a57255;display:grid;place-items:center;font-size:22px;box-shadow:none}
.brand h1{font-size:1.15rem;font-weight:700}
.brand p{color:var(--muted);font-size:.78rem}
.pill{font-size:.75rem;padding:7px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);font-family:'IBM Plex Mono',monospace}
.pill.on{color:var(--green);border-color:#34d39944}.pill.off{color:var(--red);border-color:#ff3b3b44}
/* Fondo animado tipo "dot grid" (inspirado en los backgrounds de reactbits.dev), en canvas puro sin dependencias */
#bgFx{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.55}
.shell{position:relative;z-index:1}
/* Título con efecto "shine" (texto con brillo que recorre, tipo reactbits Shiny Text) */
.brand h1.shine{background:linear-gradient(100deg,#c5a572 40%,#f4e4c1 50%,#c5a572 60%);background-size:220% auto;background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:shine 4s linear infinite}
@keyframes shine{to{background-position:-220% center}}
@keyframes letraIn{to{opacity:1;transform:translateY(0)}}
/* Hover-lift en cards, sutil, tipo "Tilted Card" de reactbits pero simplificado */
.card{transition:transform .18s ease, box-shadow .18s ease}
.card:hover{transform:translateY(-3px);box-shadow:0 14px 32px #0005}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.tabs button{border:1px solid var(--line);background:var(--card);color:var(--muted);padding:9px 14px;border-radius:999px;cursor:pointer;font:500 .85rem 'IBM Plex Sans',sans-serif}
.tabs button.active{color:#fff;background:#1e3a5f;border-color:#c5a57266;color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:14px}
.card{background:linear-gradient(180deg,var(--card),#0d0d14);border:1px solid var(--line);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow)}
.card h2{font-size:.92rem;margin-bottom:10px}.card h3{font-size:.85rem;color:var(--muted);font-weight:500;margin-bottom:8px}
.stat{font-size:1.7rem;font-weight:700;font-family:'IBM Plex Mono',monospace}
.muted{color:var(--muted);font-size:.8rem}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
label{display:block;font-size:.78rem;color:var(--muted);margin-top:10px}
input,select,textarea{width:100%;margin-top:6px;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:11px 12px;font:400 .9rem 'IBM Plex Sans',sans-serif}
.btn{background:#1e3a5f;border:none;color:#fff;padding:10px 14px;border-radius:10px;cursor:pointer;font:600 .85rem 'IBM Plex Sans',sans-serif}
.btn2{background:var(--card2);border:1px solid var(--line);color:var(--text);padding:10px 14px;border-radius:10px;cursor:pointer;font:500 .85rem 'IBM Plex Sans',sans-serif}
.btn3{background:#60a5fa22;border:1px solid #60a5fa55;color:#93c5fd;padding:10px 14px;border-radius:10px;cursor:pointer;font:500 .85rem 'IBM Plex Sans',sans-serif}
.btn4{background:#34d39922;border:1px solid #34d39955;color:#6ee7b7;padding:10px 14px;border-radius:10px;cursor:pointer;font:500 .85rem 'IBM Plex Sans',sans-serif}
.page{display:none}.page.active{display:block}
table{width:100%;border-collapse:collapse;font-size:.84rem}
th,td{padding:9px 6px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
.toast{position:fixed;right:16px;bottom:16px;background:#15151f;border:1px solid var(--line);padding:12px 16px;border-radius:12px;display:none;z-index:20;box-shadow:var(--shadow)}
.toast.show{display:block}
.login{max-width:380px;margin:12vh auto}
.mono{font-family:'IBM Plex Mono',monospace;font-size:.8rem}
.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:720px){.split{grid-template-columns:1fr}}
.hr{height:1px;background:var(--line);margin:14px 0}
</style>
</head>
<body>
<canvas id="bgFx"></canvas>
<div class="shell">
  <div id="loginView" class="card login" style="display:none">
    <div class="brand" style="margin-bottom:14px"><div class="mark">🐺</div><div><h1 class="shine">Wolfric Protocol</h1><p>Consola de operaciones</p></div></div>
    <label>Clave del panel</label>
    <input id="loginKey" type="password" placeholder="PANEL_KEY"/>
    <div class="row"><button class="btn" onclick="doLogin()">Entrar</button></div>
  </div>
  <div id="appView">
    <div class="top">
      <div class="brand"><div class="mark">🐺</div><div><h1 id="title" class="shine">Wolfric Console</h1><p>Operaciones · economía · cumplimiento</p></div></div>
      <div id="statusPill" class="pill off">● offline</div>
    </div>
    <div class="tabs">
      <button class="active" data-page="dash">Resumen</button>
      <button data-page="economy">Tesorería</button>
      <button data-page="users">Cuentas</button>
      <button data-page="guilds">Organizaciones</button>
      <button data-page="config">Identidad</button>
      <button data-page="balance">Balance</button>
      <button data-page="audit">Auditoría</button>
      <button data-page="tools">Mantenimiento</button>
    </div>
    <section id="dash" class="page active">
      <div class="grid">
        <div class="card"><h3>Estado del bot</h3><div class="stat" id="sBot">—</div><div class="muted" id="sMode">—</div></div>
        <div class="card"><h3>Cuentas</h3><div class="stat" id="sUsers">0</div><div class="muted">perfiles</div></div>
        <div class="card"><h3>Organizaciones</h3><div class="stat" id="sGuilds">0</div><div class="muted">activos</div></div>
        <div class="card"><h3>Monedas totales</h3><div class="stat" id="sCoins">0</div><div class="muted">global</div></div>
      </div>
      <div class="card"><h2>Acciones</h2>
        <div class="row">
          <button class="btn4" onclick="api('POST','/api/bot',{action:'on'})">Activar servicio</button>
          <button class="btn" onclick="api('POST','/api/bot',{action:'off'})">Suspender servicio</button>
          <button class="btn3" onclick="api('POST','/api/bot',{action:'public'})">Modo público</button>
          <button class="btn2" onclick="api('POST','/api/bot',{action:'private'})">Modo restringido</button>
          <button class="btn2" onclick="refresh()">Actualizar</button>
        </div>
      </div>
    </section>
    <section id="economy" class="page">
      <div class="split">
        <div class="card"><h2>Ajuste de saldo</h2>
          <label>ID jugador</label><input id="ecoId" placeholder="54911... o lid"/>
          <label>Cantidad (+/-)</label><input id="ecoAmount" type="number" placeholder="1000"/>
          <div class="row"><button class="btn4" onclick="giveCoins()">Aplicar</button></div>
        </div>
        <div class="card"><h2>Asignar activo</h2>
          <label>ID jugador</label><input id="itemId" placeholder="54911..."/>
          <label>Nombre ítem</label><input id="itemName" placeholder="Poción Neón Pequeña"/>
          <label>Cantidad</label><input id="itemQty" type="number" value="1"/>
          <div class="row"><button class="btn3" onclick="giveItem()">Asignar</button></div>
        </div>
      </div>
      <div class="card" style="margin-top:12px"><h2>Edición de campo</h2>
        <div class="split">
          <div><label>ID</label><input id="stId"/></div>
          <div><label>Campo</label>
            <select id="stField">
              <option value="coins">coins</option><option value="level">level</option><option value="exp">exp</option>
              <option value="bounty">bounty</option><option value="gems">gems</option><option value="hp">hp</option><option value="energy">energy</option>
            </select>
          </div>
        </div>
        <label>Valor</label><input id="stValue" type="number"/>
        <div class="row"><button class="btn" onclick="setStat()">Guardar campo</button></div>
      </div>
    </section>
    <section id="users" class="page">
      <div class="card"><h2>Cuentas</h2>
        <div class="row">
          <select id="sortBy" onchange="renderUsers()"><option value="coins">Monedas</option><option value="bounty">Bounty</option><option value="level">Nivel</option></select>
          <input id="userFilter" placeholder="Filtrar..." oninput="renderUsers()" style="max-width:220px"/>
        </div>
        <div style="overflow:auto;max-height:480px;margin-top:10px">
          <table><thead><tr><th>#</th><th>ID</th><th>Lv</th><th>Coins</th><th>Bounty</th><th>Gems</th><th>Guild</th></tr></thead><tbody id="usersBody"></tbody></table>
        </div>
      </div>
    </section>
    <section id="guilds" class="page">
      <div class="card"><h2>Organizaciones</h2>
        <table><thead><tr><th>Nombre</th><th>Miembros</th><th>Líder</th></tr></thead><tbody id="guildsBody"></tbody></table>
      </div>
    </section>
    <section id="config" class="page">
      <div class="card"><h2>Identidad</h2>
        <label>Nombre</label><input id="cfgName"/>
        <label>Emoji</label><input id="cfgEmoji"/>
        <label>Nota</label><textarea id="cfgWelcome" rows="3"></textarea>
        <div class="row"><button class="btn" onclick="saveConfig()">Guardar</button></div>
        <div class="hr"></div>
        <p class="muted">Foto: en WhatsApp <span class="mono">.setpp</span> (instala <span class="mono">npm install jimp</span>).</p>
      </div>
    </section>
    <section id="balance" class="page">
      <div class="grid">
        <div class="card"><h3>Dinero destruido (impuesto mercado)</h3><div class="stat" id="bDestruido">0</div><div class="muted">acumulado histórico</div></div>
      </div>
      <div class="split">
        <div class="card"><h2>Ítems más usados</h2><div id="bItems"></div></div>
        <div class="card"><h2>Frutas más obtenidas</h2><div id="bFrutas"></div></div>
      </div>
    </section>
    <section id="audit" class="page">
      <div class="card"><h2>Acciones de owner/admin</h2>
        <div style="overflow:auto;max-height:340px">
          <table><thead><tr><th>Fecha</th><th>Quién</th><th>Acción</th><th>Detalle</th><th>Objetivo</th></tr></thead><tbody id="auditBody"></tbody></table>
        </div>
      </div>
      <div class="card" style="margin-top:12px"><h2>Reportes de usuarios</h2>
        <div style="overflow:auto;max-height:340px">
          <table><thead><tr><th>Fecha</th><th>De</th><th>Sobre</th><th>Motivo</th></tr></thead><tbody id="reportsBody"></tbody></table>
        </div>
      </div>
    </section>
    <section id="tools" class="page">
      <div class="card"><h2>Mantenimiento</h2>
        <div class="row">
          <button class="btn2" onclick="api('POST','/api/tools',{action:'backup'})">Backup economía</button>
          <button class="btn4" onclick="bajarNube()">Descargar partida (nube)</button>
          <button class="btn2" onclick="api('POST','/api/tools',{action:'reload-economia'})">Recargar economía</button>
          <button class="btn" style="background:#b42318" onclick="if(confirm('¿Reiniciar el proceso del bot ahora?')) api('POST','/api/tools',{action:'restart'})">Reiniciar bot</button>
        </div>
        <div class="hr"></div>
        <p class="muted">Proteger panel: <span class="mono">PANEL_KEY=tuclave node index.js</span></p>
        <p class="muted">Reiniciar solo corta el proceso — para que vuelva solo necesitás correrlo con un supervisor (pm2, o un loop en Termux).</p>
      </div>
    </section>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const $ = s => document.querySelector(s)
let DATA = { users:[], guilds:[], config:{}, bot:{}, stats:{} }
let KEY = localStorage.getItem('wolfric_panel_key') || ''
document.querySelectorAll('.tabs button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
    btn.classList.add('active'); $('#'+btn.dataset.page).classList.add('active')
    if (btn.dataset.page === 'balance') loadBalance()
    if (btn.dataset.page === 'audit') loadAuditoria()
  }
})
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200) }
function headers(){ const h={'Content-Type':'application/json'}; if(KEY) h['x-panel-key']=KEY; return h }
async function bajarNube(){
  try{
    const r=await fetch('/api/export',{headers:headers()})
    if(r.status===401){showLogin();return}
    const data=await r.json()
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'})
    const a=document.createElement('a')
    a.href=URL.createObjectURL(blob)
    a.download='wolfric-partida-'+new Date().toISOString().slice(0,10)+'.json'
    a.click()
    toast('Partida descargada (sin sesion/)')
  }catch(e){toast('No se pudo exportar')}
}
async function api(method, path, body){
  const opt={method,headers:headers()}; if(body) opt.body=JSON.stringify(body)
  const r=await fetch(path,opt); const j=await r.json().catch(()=>({}))
  if(r.status===401){ showLogin(); toast('Clave incorrecta'); return j }
  if(!r.ok) toast(j.error||'Error'); else toast(j.ok||'OK')
  await refresh(); return j
}
function showLogin(){ $('#loginView').style.display='block'; $('#appView').style.display='none' }
function hideLogin(){ $('#loginView').style.display='none'; $('#appView').style.display='block' }
function doLogin(){ KEY=$('#loginKey').value||''; localStorage.setItem('wolfric_panel_key',KEY); hideLogin(); refresh() }
function renderUsers(){
  const key=$('#sortBy').value; const f=($('#userFilter').value||'').toLowerCase()
  let list=[...(DATA.users||[])]; if(f) list=list.filter(u=>String(u.id).toLowerCase().includes(f))
  list.sort((a,b)=>(b[key]||0)-(a[key]||0)); list=list.slice(0,80)
  $('#usersBody').innerHTML=list.map((u,i)=>'<tr><td>'+(i+1)+'</td><td class="mono">'+u.id+'</td><td>'+(u.level||1)+'</td><td>'+(u.coins||0)+'</td><td>'+(u.bounty||0)+'</td><td>'+(u.gems||0)+'</td><td>'+(u.guild||'—')+'</td></tr>').join('')||'<tr><td colspan="7">Sin datos</td></tr>'
}
function renderGuilds(){
  $('#guildsBody').innerHTML=(DATA.guilds||[]).map(g=>'<tr><td>'+g.name+'</td><td>'+g.members+'</td><td class="mono">'+(g.leader||'—')+'</td></tr>').join('')||'<tr><td colspan="3">Sin gremios</td></tr>'
}
function barra(nombre, valor, max){
  const pct = max>0 ? Math.max(4, Math.round(valor/max*100)) : 0
  return '<div style="margin:9px 0"><div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:4px"><span>'+nombre+'</span><span class="mono muted">'+valor+'</span></div><div style="background:var(--card2);border-radius:999px;height:8px;overflow:hidden"><div style="width:'+pct+'%;height:100%;background:linear-gradient(90deg,#175cd3,#c5a572)"></div></div></div>'
}
async function loadBalance(){
  try{
    const r=await fetch('/api/balance',{headers:headers()}); if(r.status===401)return
    const b=await r.json()
    $('#bDestruido').textContent = b.dineroDestruido||0
    const items=Object.entries(b.items||{}).sort((a,z)=>z[1]-a[1]).slice(0,10)
    const frutas=Object.entries(b.frutas||{}).sort((a,z)=>z[1]-a[1]).slice(0,10)
    const maxI=Math.max(1,...items.map(x=>x[1])), maxF=Math.max(1,...frutas.map(x=>x[1]))
    $('#bItems').innerHTML = items.map(([n,v])=>barra(n,v,maxI)).join('') || '<p class="muted">Todavía no hay datos.</p>'
    $('#bFrutas').innerHTML = frutas.map(([n,v])=>barra(n,v,maxF)).join('') || '<p class="muted">Todavía no hay datos.</p>'
  }catch(e){}
}
async function loadAuditoria(){
  try{
    const r=await fetch('/api/auditoria',{headers:headers()}); if(r.status===401)return
    const a=await r.json()
    const log=[...(a.adminLog||[])].reverse().slice(0,80)
    $('#auditBody').innerHTML = log.map(x=>'<tr><td class="mono">'+new Date(x.fecha||Date.now()).toLocaleString()+'</td><td class="mono">'+String(x.admin||'—').split('@')[0]+'</td><td>'+(x.comando||'—')+'</td><td>'+(x.parametros||'')+'</td><td class="mono">'+String(x.objetivo||'').split('@')[0]+'</td></tr>').join('') || '<tr><td colspan="5">Sin registros</td></tr>'
    const reps=[...(a.reportes||[])].reverse().slice(0,80)
    $('#reportsBody').innerHTML = reps.map(x=>'<tr><td class="mono">'+new Date(x.fecha).toLocaleString()+'</td><td class="mono">'+String(x.reportadoPor||'').split('@')[0]+'</td><td class="mono">'+String(x.reportado||'').split('@')[0]+'</td><td>'+(x.motivo||'')+'</td></tr>').join('') || '<tr><td colspan="4">Sin reportes</td></tr>'
  }catch(e){}
}
function fillConfig(){
  $('#cfgName').value=DATA.config.botName||''; $('#cfgEmoji').value=DATA.config.botEmoji||''; $('#cfgWelcome').value=DATA.config.welcomeMsg||''
  $('#title').textContent=(DATA.config.botEmoji||'🐺')+' '+(DATA.config.botName||'Wolfric')+' Console'
}
async function saveConfig(){ await api('POST','/api/config',{botName:$('#cfgName').value,botEmoji:$('#cfgEmoji').value,welcomeMsg:$('#cfgWelcome').value}) }
async function giveCoins(){ await api('POST','/api/economy',{action:'coins',id:$('#ecoId').value,amount:Number($('#ecoAmount').value||0)}) }
async function giveItem(){ await api('POST','/api/economy',{action:'item',id:$('#itemId').value,name:$('#itemName').value,qty:Number($('#itemQty').value||1)}) }
async function setStat(){ await api('POST','/api/economy',{action:'set',id:$('#stId').value,field:$('#stField').value,value:Number($('#stValue').value||0)}) }
async function refresh(){
  try{
    const r=await fetch('/api/status',{headers:headers()}); if(r.status===401){showLogin();return}
    hideLogin(); DATA=await r.json(); const on=!!DATA.bot.on
    $('#statusPill').className='pill '+(on?'on':'off'); $('#statusPill').textContent=on?'● online':'● offline'
    $('#sBot').textContent=on?'ONLINE':'OFFLINE'; $('#sMode').textContent=(DATA.bot.private?'Modo restringido':'Modo público')+' · v'+(DATA.config.botVersion||'?')
    $('#sUsers').textContent=DATA.stats.users; $('#sGuilds').textContent=DATA.stats.guilds; $('#sCoins').textContent=DATA.stats.coins
    fillConfig(); renderUsers(); renderGuilds()
  }catch(e){ toast('No se pudo conectar') }
}
refresh(); setInterval(refresh,8000)

// Fondo animado: grilla de puntos que respiran suave y reaccionan al mouse
// (canvas puro, sin dependencias, inspirado en los backgrounds interactivos de
// reactbits.dev pero liviano para no gastar batería/CPU de más).
;(function(){
  const cv = document.getElementById('bgFx')
  if (!cv) return
  const ctx2 = cv.getContext('2d')
  let w, h, puntos = []
  const mouse = { x: -9999, y: -9999 }
  const RADIO_MOUSE = 130
  function medir(){
    w = cv.width = window.innerWidth
    h = cv.height = window.innerHeight
    const espacio = 34
    puntos = []
    for (let x = espacio/2; x < w; x += espacio) {
      for (let y = espacio/2; y < h; y += espacio) {
        puntos.push({ x, y, fase: Math.random() * Math.PI * 2 })
      }
    }
  }
  function dibujar(t){
    ctx2.clearRect(0, 0, w, h)
    for (const p of puntos) {
      const dx = p.x - mouse.x, dy = p.y - mouse.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const cercania = Math.max(0, 1 - dist / RADIO_MOUSE) // 0..1, 1 = justo debajo del cursor
      const respirar = (Math.sin(t / 1800 + p.fase) + 1) / 2 // 0..1
      const brillo = Math.min(1, respirar * 0.35 + cercania * 0.9)
      const radio = 1.1 + cercania * 2.2 // los puntos cerca del mouse se agrandan
      ctx2.beginPath()
      ctx2.arc(p.x, p.y, radio, 0, Math.PI * 2)
      ctx2.fillStyle = 'rgba(197,165,114,' + (0.06 + brillo * 0.5) + ')'
      ctx2.fill()
    }
    requestAnimationFrame(dibujar)
  }
  medir()
  window.addEventListener('resize', medir)
  window.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY })
  window.addEventListener('mouseleave', () => { mouse.x = -9999; mouse.y = -9999 })
  window.addEventListener('touchmove', e => { if (e.touches[0]) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY } }, { passive: true })
  requestAnimationFrame(dibujar)
})()

// Texto letra por letra (tipo "Split Text" de reactbits): separa el título en
// spans y los anima entrando de a uno, con un pequeño rebote al asentarse.
function splitTextAnim(el){
  if (!el || el.dataset.split) return
  el.dataset.split = '1'
  const texto = el.textContent
  el.textContent = ''
  el.style.display = 'inline-block'
  texto.split('').forEach((ch, i) => {
    const span = document.createElement('span')
    span.textContent = ch === ' ' ? '\u00A0' : ch
    span.style.display = 'inline-block'
    span.style.opacity = '0'
    span.style.transform = 'translateY(14px)'
    span.style.animation = 'letraIn .5s cubic-bezier(.2,1.4,.4,1) forwards'
    span.style.animationDelay = (i * 0.035) + 's'
    el.appendChild(span)
  })
}
document.querySelectorAll('.shine').forEach(splitTextAnim)
</script>
</body>
</html>`
}

function createPanel(ctx) {
    const authOk = (req) => {
        if (!PANEL_KEY) return true
        const h = req.headers['x-panel-key'] || ''
        try {
            const u = new URL(req.url, 'http://127.0.0.1')
            return h === PANEL_KEY || (u.searchParams.get('key') || '') === PANEL_KEY
        } catch (_) { return h === PANEL_KEY }
    }

    const server = http.createServer((req, res) => {
        let pathname = '/'
        try { pathname = new URL(req.url, 'http://127.0.0.1').pathname } catch (_) {}

        const send = (code, data, type = 'application/json') => {
            res.writeHead(code, {
                'Content-Type': type,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, x-panel-key'
            })
            res.end(typeof data === 'string' ? data : JSON.stringify(data))
        }

        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, x-panel-key'
            })
            return res.end()
        }

        if (pathname === '/' || pathname === '/index.html') return send(200, htmlPage(), 'text/html; charset=utf-8')
        if (pathname === '/manifest.json') {
            return send(200, {
                name: 'Wolfric Panel',
                short_name: 'Wolfric',
                start_url: '/',
                display: 'standalone',
                background_color: '#0b1220',
                theme_color: '#0b1220'
            })
        }
        if (!authOk(req) && pathname.startsWith('/api/')) return send(401, { error: 'Unauthorized' })

        const readBody = () => new Promise((resolve) => {
            let body = ''
            req.on('data', c => body += c)
            req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch (_) { resolve({}) } })
        })

        if (pathname === '/api/status' && req.method === 'GET') {
            const economia = ctx.getEconomia() || {}
            const users = Object.entries(economia).map(([id, u]) => ({
                id: id.split('@')[0], level: u.level || 1, coins: u.coins || 0,
                bounty: u.bounty || 0, gems: u.gems || 0, guild: u.guild || null
            }))
            const gremios = ctx.getGremios() || new Map()
            const guilds = [...gremios.entries()].map(([name, g]) => ({
                name, members: (g.miembros || []).length, leader: (g.creador || '').split('@')[0]
            }))
            const coins = users.reduce((a, u) => a + (u.coins || 0), 0)
            return send(200, {
                bot: { on: ctx.getBotOn(), private: ctx.getPrivado() },
                config: ctx.getConfig(),
                stats: { users: users.length, guilds: guilds.length, coins },
                users, guilds
            })
        }

        // Balance del juego: qué ítems y frutas se usan más, y cuánto dinero se destruyó
        // (impuesto del mercado). Sirve para ajustar precios sin adivinar.
        if (pathname === '/api/balance' && req.method === 'GET') {
            return send(200, ctx.getUsoStats ? ctx.getUsoStats() : { items: {}, frutas: {}, dineroDestruido: 0 })
        }

        // Auditoría: acciones de owner/admin (kick, ban, sets, etc.) y reportes de usuarios
        if (pathname === '/api/auditoria' && req.method === 'GET') {
            return send(200, {
                adminLog: ctx.getAdminLog ? ctx.getAdminLog() : [],
                reportes: ctx.getReportes ? ctx.getReportes() : []
            })
        }

        if (pathname === '/api/bot' && req.method === 'POST') {
            return readBody().then(j => {
                if (j.action === 'on') ctx.setBotOn(true)
                if (j.action === 'off') ctx.setBotOn(false)
                if (j.action === 'private') ctx.setPrivado(true)
                if (j.action === 'public') ctx.setPrivado(false)
                if (ctx.log) ctx.log('INFO', 'Panel: bot ' + j.action)
                send(200, { ok: 'Bot → ' + j.action })
            })
        }

        if (pathname === '/api/config' && req.method === 'POST') {
            return readBody().then(j => {
                const cfg = ctx.getConfig()
                if (j.botName != null) cfg.botName = String(j.botName).slice(0, 40)
                if (j.botEmoji != null) cfg.botEmoji = String(j.botEmoji).slice(0, 8)
                if (j.welcomeMsg != null) cfg.welcomeMsg = String(j.welcomeMsg).slice(0, 300)
                ctx.setConfig(cfg)
                send(200, { ok: 'Config guardada' })
            })
        }

        if (pathname === '/api/economy' && req.method === 'POST') {
            return readBody().then(j => {
                try {
                    if (typeof ctx.mutateEconomia !== 'function') return send(500, { error: 'Economía no disponible' })
                    const result = ctx.mutateEconomia(j)
                    if (!result.ok) return send(400, { error: result.error || 'Error' })
                    send(200, { ok: result.ok })
                } catch (e) { send(500, { error: String(e.message || e) }) }
            })
        }

        if (pathname === '/api/export' && req.method === 'GET') {
            const leer = (f) => {
                const p = path.join(process.cwd(), f)
                try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) {}
                return null
            }
            return send(200, {
                version: 1,
                fecha: new Date().toISOString(),
                nota: 'Sin sesion/. Restaurar solo en el servidor del bot.',
                economia: leer('economia.json'),
                gremios: leer('gremios.json'),
                grupos_config: leer('grupos_config.json'),
                bot_config: leer('bot_config.json'),
                frontier_mundo: leer('frontier_mundo.json'),
                uso_stats: leer('uso_stats.json')
            })
        }

        if (pathname === '/api/tools' && req.method === 'POST') {
            return readBody().then(j => {
                if (j.action === 'backup') {
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
                    const eco = path.join(process.cwd(), 'economia.json')
                    const bak = path.join(process.cwd(), 'economia.backup-' + stamp + '.json')
                    if (fs.existsSync(eco)) fs.copyFileSync(eco, bak)
                    return send(200, { ok: 'Backup: ' + path.basename(bak) })
                }
                if (j.action === 'reload-economia') {
                    if (typeof ctx.reloadEconomia === 'function') ctx.reloadEconomia()
                    return send(200, { ok: 'Economía recargada' })
                }
                if (j.action === 'restart') {
                    send(200, { ok: 'Reiniciando... si no vuelve solo, necesitás correrlo con un supervisor (pm2, o un loop de Termux) para que se relance.' })
                    setTimeout(() => process.exit(1), 400) // da tiempo a que salga la respuesta antes de cerrar
                    return
                }
                send(400, { error: 'Acción desconocida' })
            })
        }

        send(404, { error: 'Not found' })
    })

    const PANEL_BIND = process.env.PANEL_BIND || '127.0.0.1'
    server.listen(PANEL_PORT, PANEL_BIND, () => {
        if (ctx.log) {
            ctx.log('SUCCESS', 'Panel web en http://' + PANEL_BIND + ':' + PANEL_PORT)
            ctx.log('SYS', `Panel protegido. Clave (${panelKeyOrigen}): ${PANEL_KEY}`)
            if (panelKeyOrigen !== 'variable de entorno') {
                ctx.log('SYS', `Clave guardada en ${PANEL_KEY_FILE} — cámbiala con PANEL_KEY=clave node index.js`)
            }
        }
    })
    return server
}

module.exports = { createPanel, PANEL_PORT }
