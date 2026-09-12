/*
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  WOLFRIC PROTOCOL — Bot de WhatsApp (RPG/gacha)                ║
 * ╠═══════════════════════════════════════════════════════════════╣
 * ║  © Wolfric Protocol. Todos los derechos reservados.            ║
 * ║  Canal oficial: https://whatsapp.com/channel/0029VbDSzOv8KMqcStjGog1T
 * ║                                                                 ║
 * ║  Prohibida la redistribución, reventa, o publicación de copias ║
 * ║  modificadas de este código bajo otro nombre sin autorización  ║
 * ║  expresa de los autores. Si conseguiste este código y no sos   ║
 * ║  quien lo escribió, dale crédito: no te lo adjudiques como     ║
 * ║  propio ni lo vendas como tuyo.                                ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, Browsers } = require('@itsliaaa/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const fs = require('fs')
const qrcode = require('qrcode-terminal')
const { execFile } = require('child_process')
const util = require('util')
// execFileAsync no pasa por una shell: los argumentos van como array,
// así que un link/nombre de búsqueda con comillas, `;`, `$()`, etc. no puede
// romper el comando ni ejecutar código en el sistema (inyección de comandos).
// Ya no queda ningún exec()/execAsync() con shell en todo el archivo — se
// migró todo (stickers y descargas) a execFileAsync cuando se cerró esa
// vulnerabilidad, así que se sacó el import de `exec` por completo.
const execFileAsync = util.promisify(execFile)
const os = require('os')
const path = require('path')
const crypto = require('crypto')
let createPanel = null
let PANEL_PORT_MOSTRAR = 3000
try {
    const panelMod = require('./panel-web')
    createPanel = panelMod.createPanel
    PANEL_PORT_MOSTRAR = panelMod.PANEL_PORT || 3000
} catch (e) { console.log('[WOLFRIC] panel-web.js no encontrado (opcional)') }

// ========== BLINDAJE: nunca dejar que un error suelto tumbe el proceso ==========
// Antes, un error no capturado en cualquier handler (un comando, un evento, un
// callback de ffmpeg/yt-dlp) mataba el bot entero sin aviso claro. Con esto,
// Wolfric loguea el error y sigue vivo en vez de crashear en Termux.
process.on('uncaughtException', (err) => {
    console.log('[WOLFRIC] uncaughtException (no crashea, sigue corriendo):', err && err.stack ? err.stack : err)
})
process.on('unhandledRejection', (reason) => {
    console.log('[WOLFRIC] unhandledRejection (no crashea, sigue corriendo):', reason)
})

let prefix = '.' // se sincroniza con botConfig.prefix apenas carga la config (ver más abajo)
// Símbolos aceptados como prefijo. Los 4 SIEMPRE se reconocen al parsear un comando
// (así nadie queda "trabado" si cambia el prefijo y se confunde) — lo que cambia con
// .setprefix es cuál se muestra en los menús/ayuda como el prefijo "oficial".
const PREFIJOS_PERMITIDOS = ['.', '!', '#', '/']

// ⚠️ Los OWNERS se identifican EXCLUSIVAMENTE por su LID de WhatsApp (@lid).
// NO se usan números de teléfono/JID (@s.whatsapp.net) para esta lista.
// Dejá el array vacío y agregá tu(s) propio(s) LID acá antes de correr el bot.
// Para encontrar tu LID: escribile al bot ya corriendo y fijate en la consola/logs,
// o usá el comando .whoami una vez que el bot ya esté andando con algún owner temporal.
const OWNERS = [
    '16970086887468@lid',
    '41343522992148@lid',
    '83769193189377@lid'
]


// ====== Vinculación: QR o código, a elección de quien arranca el bot ======
// Prioridad: variables de entorno (para correrlo con pm2/supervisor sin
// que quede esperando una respuesta) > prompt interactivo en la terminal
// (si hay TTY) > por defecto, QR.
//   WOLFRIC_LINK_METHOD=qr|code
//   WOLFRIC_PHONE=549... (solo si el método es "code")
const readline = require('readline')
async function preguntarMetodoVinculacion() {
    const metodoEnv = (process.env.WOLFRIC_LINK_METHOD || '').toLowerCase()
    if (metodoEnv === 'code') return { metodo: 'code', numero: (process.env.WOLFRIC_PHONE || '').replace(/\D/g, '') }
    if (metodoEnv === 'qr') return { metodo: 'qr', numero: null }

    if (!process.stdin.isTTY) return { metodo: 'qr', numero: null } // sin terminal interactiva (ej. corriendo con pm2): QR por defecto

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const preguntar = (q) => new Promise(res => rl.question(q, res))
    console.log('\n¿Cómo querés vincular el bot?')
    console.log('  [1] Código QR (escanear con WhatsApp)')
    console.log('  [2] Código de vinculación (poner el número de teléfono)')
    const opcion = (await preguntar('Elegí 1 o 2 (Enter = QR): ')).trim()
    if (opcion !== '2') { rl.close(); return { metodo: 'qr', numero: null } }
    const numero = (await preguntar('Número con código de país, sin + ni espacios (ej: 5215512345678): ')).trim().replace(/\D/g, '')
    rl.close()
    return { metodo: 'code', numero }
}

// Estado del bot: encendido/apagado y modo privado
let botOn = true
let modoPrivado = false

// ========== CONFIG PERSONALIZABLE DEL BOT (se guarda en bot_config.json) ==========
const BOT_CONFIG_FILE = './bot_config.json'
let botConfig = {
    botName: 'Wolfric',
    botEmoji: '🐺',
    botVersion: '3.2.0',
    welcomeMsg: '',
    channelUrl: 'https://whatsapp.com/channel/0029VbDSzOv8KMqcStjGog1T',  // canal oficial de Wolfric
    channelName: 'Canal Wolfric',
    welcomeOn: true,       // bienvenida al entrar al grupo
    backupHoras: 6,        // backup automatico de economia cada N horas
    stickerPack: 'Wolfric',            // nombre de pack que se ve al mantener presionado un sticker
    stickerAuthor: 'Wolfric Protocol', // autor/publicador del pack
    grupoAvisos: null,                 // jid del grupo donde se publican avisos automáticos (ranking, bosses)
    impuestoMercadoPct: 5,             // % que se destruye en cada venta del mercado de jugadores
    rankingDia: 0,                     // día de la semana (0=domingo) para publicar el ranking automático
    rankingHora: 20,                   // hora (0-23) para publicar el ranking automático
    rankingUltimoPost: null,           // fecha ISO del último ranking publicado, para no repetir
    prefix: '.',                        // prefijo "oficial" que se muestra en menús/ayuda (. ! # /)
    anticall: false                    // rechaza automáticamente cualquier llamada entrante al bot
}

// Config por grupo (anti-link, etc.)
const GRUPOS_CONFIG_FILE = './grupos_config.json'
let gruposConfig = {}
function cargarGruposConfig() {
    try {
        if (fs.existsSync(GRUPOS_CONFIG_FILE)) gruposConfig = JSON.parse(fs.readFileSync(GRUPOS_CONFIG_FILE, 'utf8')) || {}
    } catch (e) { gruposConfig = {} }
}
function guardarGruposConfig() {
    try { fs.writeFileSync(GRUPOS_CONFIG_FILE, JSON.stringify(gruposConfig, null, 2)) } catch (e) {}
}
cargarGruposConfig()
function getGrupoCfg(jid) {
    if (!gruposConfig[jid]) gruposConfig[jid] = {}
    const d = gruposConfig[jid]
    if (d.antilink === undefined) d.antilink = false
    if (d.antispam === undefined) d.antispam = false
    if (d.welcome === undefined) d.welcome = true
    if (d.goodbye === undefined) d.goodbye = false
    if (!d.welcomeText) d.welcomeText = ''
    if (!d.goodbyeText) d.goodbyeText = ''
    if (d.botOn === undefined) d.botOn = true   // apagado por grupo (distinto del apagado global .off)
    if (!d.idioma) d.idioma = 'es'              // idioma del bot para ESE grupo: es | en | pt
    if (d.iaChat === undefined) d.iaChat = false // modo chat con IA (Gemini): responde a todo, no solo comandos
    if (!Array.isArray(d.comandosDesactivados)) d.comandosDesactivados = [] // comandos puntuales apagados en ESTE grupo
    if (d.antiraid === undefined) d.antiraid = false   // detecta entradas masivas sospechosas (posible raid/spam)
    if (!d.antiraidUmbral) d.antiraidUmbral = 5         // cuántas entradas en la ventana disparan la alerta
    if (!d.antiraidVentanaSeg) d.antiraidVentanaSeg = 30 // ventana de tiempo, en segundos
    if (!d.antiraidAccion) d.antiraidAccion = 'alerta'  // 'alerta' (solo avisa) | 'cerrar' (además revoca el link de invitación)
    if (d.antipeleas === undefined) d.antipeleas = false // detecta peleas/insultos con IA (sin strike real ni baneo a nadie)
    if (!d.antipeleasAccion) d.antipeleasAccion = 'cerrar' // 'aviso' (solo etiqueta y avisa) | 'cerrar' (además cierra el grupo un rato)
    if (!d.antipeleasMinutos) d.antipeleasMinutos = 3      // minutos que queda cerrado antes de reabrirse solo
    if (d.antidelete === undefined) d.antidelete = false   // repostea en el mismo grupo lo que alguien borra (transparente, no a escondidas)
    if (d.viewonce === undefined) d.viewonce = false       // repostea al instante las fotos/videos "de una vista" (visible para todos, no en privado)
    if (d.anticall === undefined) d.anticall = false       // rechaza llamadas entrantes automáticamente
    if (!d.warnLimit) d.warnLimit = 3
    if (d.adminOnly === undefined) d.adminOnly = false
    if (!d.msgCounts || typeof d.msgCounts !== 'object') d.msgCounts = {}
    if (!d.lastSeen || typeof d.lastSeen !== 'object') d.lastSeen = {}
    return d
}

// ====================== IDIOMAS (es / pt / en) ======================
const IDIOMAS_NOMBRE = { es: 'Español', pt: 'Português', en: 'English' }
function normalizarIdioma(valor) {
    const v = String(valor || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
    if (['pt', 'pt-br', 'ptbr', 'por', 'portugues', 'portuguesa', 'portuguese', 'brasil', 'brazil', 'br'].includes(v)) return 'pt'
    if (['es', 'esp', 'espanol', 'espanola', 'spanish', 'castellano'].includes(v)) return 'es'
    if (['en', 'eng', 'ingles', 'inglesa', 'english', 'us', 'usa', 'uk'].includes(v)) return 'en'
    return null
}
function obtenerIdioma(from, sender) {
    try {
        if (sender) {
            const clave = (typeof claveEconomia === 'function') ? claveEconomia(sender) : sender
            const u = economia && economia[clave]
            if (u && (u.idioma === 'es' || u.idioma === 'pt' || u.idioma === 'en')) return u.idioma
        }
        if (from && String(from).endsWith('@g.us')) {
            const g = getGrupoCfg(from)
            if (g.idioma === 'es' || g.idioma === 'pt' || g.idioma === 'en') return g.idioma
        }
    } catch (_) {}
    return 'es'
}
// tr(lang, es, pt, en) — si falta la traducción al inglés, cae al español (para que nada quede vacío
// mientras se van traduciendo por partes los comandos más viejos del bot).
function tr(lang, es, pt, en) {
    if (lang === 'pt') return pt || es
    if (lang === 'en') return en || es
    return es
}

function lore(lang, texto) {
    if (!texto) return texto
    if (lang !== 'pt' && lang !== 'en') return texto
    const PT = {
        'Una armadura sin rostro que protege una ruta que no aparece en ningún mapa.': 'Uma armadura sem rosto que protege uma rota que não aparece em mapa nenhum.',
        'El guardián analiza a los intrusos.': 'O guardião analisa os invasores.',
        'La armadura abre sus sellos y acelera el patrón de ataque.': 'A armadura abre os selos e acelera o padrão de ataque.',
        'El núcleo queda expuesto: cada golpe provoca una respuesta.': 'O núcleo fica exposto: cada golpe provoca uma resposta.',
        'Una entidad de cristal que cambia de forma cada vez que alguien lee su patrón.': 'Uma entidade de cristal que muda de forma sempre que alguém lê o padrão.',
        'El bosque refleja todas las siluetas.': 'A floresta reflete todas as silhuetas.',
        'El gardián divide su núcleo en tres trayectorias.': 'O guardião divide o núcleo em três trajetórias.',
        'El guardián divide su núcleo en tres trayectorias.': 'O guardião divide o núcleo em três trajetórias.',
        'La luz converge en un único punto vulnerable.': 'A luz converge num único ponto vulnerável.',
        'El primer Soberano no gobierna una especie: gobierna la anomalía que mantiene unido el mundo.': 'O primeiro Soberano não governa uma espécie: governa a anomalia que mantém o mundo unido.',
        'El Soberano observa y no ataca.': 'O Soberano observa e não ataca.',
        'La Ruina se pliega sobre sí misma.': 'A Ruína se dobra sobre si mesma.',
        'La señal se rompe: cada acción cambia el campo de batalla.': 'O sinal quebra: cada ação muda o campo de batalha.',
        'Una memoria viva crece debajo del Bosque Prismático y repite las decisiones de cada explorador.': 'Uma memória viva cresce debaixo do Bosque Prismático e repete as decisões de cada explorador.',
        'El Jardín aprende los nombres del equipo.': 'O Jardim aprende os nomes do time.',
        'Las raíces copian las habilidades usadas contra ellas.': 'As raízes copiam as habilidades usadas contra elas.',
        'La memoria se divide: integrar, aislar o reprogramar.': 'A memória se divide: integrar, isolar ou reprogramar.',
        'Ciudad segura. Aquí se registran exploradores, se aceptan misiones y se prepara el equipo.': 'Cidade segura. Aqui se registram exploradores, se aceitam missões e se prepara o equipamento.',
        'Una extensión gris donde las criaturas rápidas cazan a los recién llegados.': 'Uma extensão cinza onde criaturas rápidas caçam os recém-chegados.',
        'Un bosque de rutas cambiantes, señales falsas y materiales de alta pureza.': 'Uma floresta de rotas mutantes, sinais falsos e materiais de alta pureza.',
        'Restos de una civilización que dejó máquinas, guardianes y mensajes incompletos.': 'Restos de uma civilização que deixou máquinas, guardiões e mensagens incompletas.',
        'La región cambia cuando cae la noche. Algunas rutas solo existen durante el eclipse.': 'A região muda quando cai a noite. Algumas rotas só existem durante o eclipse.',
        'Zona de riesgo extremo. Las reglas de combate y gravedad no son confiables.': 'Zona de risco extremo. As regras de combate e gravidade não são confiáveis.',
        'El arma que nunca se rompe.': 'A arma que nunca quebra.',
        'Ataque estable. No consume recursos.': 'Ataque estável. Não consome recursos.',
        'Aumenta la probabilidad de evitar el próximo contraataque.': 'Aumenta a chance de evitar o próximo contra-ataque.',
        'Convierte parte de TEC en daño adicional.': 'Converte parte de TEC em dano extra.',
        'Daño aumentado contra enemigos de nivel superior.': 'Dano aumentado contra inimigos de nível maior.',
        'Revela una pista adicional al explorar zonas peligrosas.': 'Revela uma pista extra ao explorar zonas perigosas.',
        'Artes de alto riesgo para encuentros únicos.': 'Artes de alto risco para encontros únicos.',
        'Dibuja rutas que solo aparecen cuando una señal cambia de frecuencia.': 'Desenha rotas que só aparecem quando um sinal muda de frequência.',
        'El mapa no está incompleto. Está esperando que alguien lo lea de la forma correcta.': 'O mapa não está incompleto. Está esperando que alguém leia do jeito certo.',
        'Un técnico de núcleo que reconoce la pureza de cada material.': 'Um técnico de núcleo que reconhece a pureza de cada material.',
        'Una buena arma no nace de la fuerza. Nace de saber qué no debe romperse.': 'Uma boa arma não nasce da força. Nasce de saber o que não pode quebrar.',
        'Custodia los registros de los Guardianes que fueron borrados del mapa.': 'Guarda os registros dos Guardiões que foram apagados do mapa.',
        'El mundo no castiga la curiosidad. Castiga entrar sin haber entendido el precio.': 'O mundo não pune a curiosidade. Pune entrar sem ter entendido o preço.',
        'Acepta encargos de alto riesgo para quienes ya conocen el miedo.': 'Aceita missões de alto risco pra quem já conhece o medo.',
        'Si el cielo se apaga, no mires arriba. Mira las sombras que todavía se mueven.': 'Se o céu apagar, não olhe pra cima. Olhe as sombras que ainda se mexem.',
        'Marca monstruos que aprendieron a esconder sus niveles.': 'Marca monstros que aprenderam a esconder o nível.',
        'Un monstruo élite no es solo más fuerte. Es un monstruo que ya sobrevivió a tus métodos.': 'Um monstro elite não é só mais forte. É um monstro que já sobreviveu aos seus métodos.',
        'Escucha la memoria de las raíces y traduce sus silencios.': 'Escuta a memória das raízes e traduz os silêncios.',
        'El bosque no quiere que lo conquistes. Quiere saber qué harás cuando tengas la oportunidad.': 'A floresta não quer que você a conquiste. Quer saber o que você faz quando tiver a chance.',
        'Clasifica patrones de combate recuperados de cámaras antiguas.': 'Classifica padrões de combate recuperados de câmaras antigas.',
        'Cada arma es una hipótesis. La batalla decide si era correcta.': 'Cada arma é uma hipótese. A batalha decide se estava certa.',
        'Solo aparece cuando el valle pierde su segunda sombra.': 'Só aparece quando o vale perde a segunda sombra.',
        'El eclipse no oculta el camino. Oculta quién estaba caminando contigo.': 'O eclipse não esconde o caminho. Esconde quem estava andando com você.',
        'Explora dos veces las Llanuras de Ceniza.': 'Explore duas vezes as Planícies de Cinza.',
        'Reúne 8 unidades de Seda Prismática.': 'Junte 8 unidades de Seda Prismática.',
        'Forja la Lanza de la Divinidad.': 'Forje a Lança da Divindade.',
        'Derrota al Soberano de la Ruptura.': 'Derrote o Soberano da Ruptura.',
        'La ruta que no figura': 'A rota que não aparece',
        'Pureza Prismática': 'Pureza Prismática',
        'El fragmento que recuerda': 'O fragmento que lembra',
        'Cruzar el eclipse': 'Cruzar o eclipse',
        'Cartógrafa de anomalías': 'Cartógrafa de anomalias',
        'Ingeniero de materiales': 'Engenheiro de materiais',
        'Archivista de las Ruinas': 'Arquivista das Ruínas',
        'Explorador veterano': 'Explorador veterano',
        'Cazadora de élites': 'Caçadora de elites',
        'Intérprete del bosque': 'Intérprete da floresta',
        'Archivista de combate': 'Arquivista de combate',
        'Guía del eclipse': 'Guia do eclipse',
        'nadie': 'ninguém',
        'No tiene encargos disponibles.': 'Não tem missões disponíveis.'
    }
    const EN = {
        'Una armadura sin rostro que protege una ruta que no aparece en ningún mapa.': 'A faceless armor that guards a route that is not on any map.',
        'El guardián analiza a los intrusos.': 'The guardian studies the intruders.',
        'La armadura abre sus sellos y acelera el patrón de ataque.': 'The armor opens its seals and speeds up the attack pattern.',
        'El núcleo queda expuesto: cada golpe provoca una respuesta.': 'The core is exposed: every hit triggers a reply.',
        'Una entidad de cristal que cambia de forma cada vez que alguien lee su patrón.': 'A crystal entity that changes shape every time someone reads its pattern.',
        'El bosque refleja todas las siluetas.': 'The forest mirrors every silhouette.',
        'El guardián divide su núcleo en tres trayectorias.': 'The guardian splits its core into three paths.',
        'La luz converge en un único punto vulnerable.': 'The light converges on a single weak point.',
        'El primer Soberano no gobierna una especie: gobierna la anomalía que mantiene unido el mundo.': 'The first Sovereign does not rule a species: it rules the anomaly that holds the world together.',
        'El Soberano observa y no ataca.': 'The Sovereign watches and does not attack.',
        'La Ruina se pliege sobre sí misma.': 'The Ruin folds in on itself.',
        'La Ruina se pliega sobre sí misma.': 'The Ruin folds in on itself.',
        'La señal se rompe: cada acción cambia el campo de batalla.': 'The signal breaks: every action changes the battlefield.',
        'Una memoria viva crece debajo del Bosque Prismático y repite las decisiones de cada explorador.': 'A living memory grows under the Prismatic Forest and repeats every explorer\'s choices.',
        'El Jardín aprende los nombres del equipo.': 'The Garden learns the team\'s names.',
        'Las raíces copian las habilidades usadas contra ellas.': 'The roots copy the skills used against them.',
        'La memoria se divide: integrar, aislar o reprogramar.': 'The memory splits: integrate, isolate or reprogram.',
        'Ciudad segura. Aquí se registran exploradores, se aceptan misiones y se prepara el equipo.': 'Safe city. Explorers register here, take quests and prep gear.',
        'Una extensión gris donde las criaturas rápidas cazan a los recién llegados.': 'A gray stretch where fast creatures hunt newcomers.',
        'Un bosque de rutas cambiantes, señales falsas y materiales de alta pureza.': 'A forest of shifting routes, fake signals and high-purity mats.',
        'Restos de una civilización que dejó máquinas, guardianes y mensajes incompletos.': 'Ruins of a civilization that left machines, guardians and unfinished messages.',
        'La región cambia cuando cae la noche. Algunas rutas solo existen durante el eclipse.': 'The region changes at night. Some routes only exist during the eclipse.',
        'Zona de riesgo extremo. Las reglas de combate y gravedad no son confiables.': 'Extreme-risk zone. Combat and gravity rules are not reliable.',
        'El arma que nunca se rompe.': 'The weapon that never breaks.',
        'Ataque estable. No consume recursos.': 'Stable attack. Costs nothing.',
        'Aumenta la probabilidad de evitar el próximo contraataque.': 'Raises the chance to dodge the next counter.',
        'Convierte parte de TEC en daño adicional.': 'Turns part of TEC into extra damage.',
        'Daño aumentado contra enemigos de nivel superior.': 'Bonus damage vs higher-level enemies.',
        'Revela una pista adicional al explorar zonas peligrosas.': 'Reveals an extra clue when exploring dangerous zones.',
        'Artes de alto riesgo para encuentros únicos.': 'High-risk Arts for unique encounters.',
        'Dibuja rutas que solo aparecen cuando una señal cambia de frecuencia.': 'Draws routes that only show up when a signal changes frequency.',
        'El mapa no está incompleto. Está esperando que alguien lo lea de la forma correcta.': 'The map is not incomplete. It is waiting for someone to read it the right way.',
        'Un técnico de núcleo que reconoce la pureza de cada material.': 'A core tech who can read the purity of every material.',
        'Una buena arma no nace de la fuerza. Nace de saber qué no debe romperse.': 'A good weapon is not born from strength. It is born from knowing what must not break.',
        'Custodia los registros de los Guardianes que fueron borrados del mapa.': 'Keeps the records of Guardians erased from the map.',
        'El mundo no castiga la curiosidad. Castiga entrar sin haber entendido el precio.': 'The world does not punish curiosity. It punishes walking in without knowing the price.',
        'Acepta encargos de alto riesgo para quienes ya conocen el miedo.': 'Takes high-risk jobs for people who already know fear.',
        'Si el cielo se apaga, no mires arriba. Mira las sombras que todavía se mueven.': 'If the sky goes dark, do not look up. Look at the shadows that still move.',
        'Marca monstruos que aprendieron a esconder sus niveles.': 'Marks monsters that learned to hide their levels.',
        'Un monstruo élite no es solo más fuerte. Es un monstruo que ya sobrevivió a tus métodos.': 'An elite is not just stronger. It is a monster that already survived your methods.',
        'Escucha la memoria de las raíces y traduce sus silencios.': 'Listens to the memory of the roots and translates their silence.',
        'El bosque no quiere que lo conquistes. Quiere saber qué harás cuando tengas la oportunidad.': 'The forest does not want you to conquer it. It wants to know what you will do when you get the chance.',
        'Clasifica patrones de combate recuperados de cámaras antiguas.': 'Sorts combat patterns recovered from old chambers.',
        'Cada arma es una hipótesis. La batalla decide si era correcta.': 'Every weapon is a hypothesis. The fight decides if it was right.',
        'Solo aparece cuando el valle pierde su segunda sombra.': 'Only shows up when the valley loses its second shadow.',
        'El eclipse no oculta el camino. Oculta quién estaba caminando contigo.': 'The eclipse does not hide the path. It hides who was walking with you.',
        'Explora dos veces las Llanuras de Ceniza.': 'Explore Ash Plains twice.',
        'Reúne 8 unidades de Seda Prismática.': 'Gather 8 Prismatic Silk.',
        'Forja la Lanza de la Divinidad.': 'Forge the Lance of Divinity.',
        'Derrota al Soberano de la Ruptura.': 'Defeat the Sovereign of the Rift.',
        'La ruta que no figura': 'The route that is not listed',
        'El fragmento que recuerda': 'The fragment that remembers',
        'Cruzar el eclipse': 'Cross the eclipse',
        'Cartógrafa de anomalías': 'Anomaly cartographer',
        'Ingeniero de materiales': 'Materials engineer',
        'Archivista de las Ruinas': 'Ruins archivist',
        'Explorador veterano': 'Veteran explorer',
        'Cazadora de élites': 'Elite hunter',
        'Intérprete del bosque': 'Forest interpreter',
        'Archivista de combate': 'Combat archivist',
        'Guía del eclipse': 'Eclipse guide',
        'nadie': 'nobody',
        'No tiene encargos disponibles.': 'No quests available.'
    }
    return lang === 'pt' ? (PT[texto] || texto) : (EN[texto] || texto)
}


// Comandos del juego: el nombre OFICIAL es inglés.
// Lo que está a la izquierda es lo que escribe el usuario; a la derecha, el handler interno.
// Los nombres viejos en español siguen andando como alias.
const ALIAS_COMANDO_EN = {
    register: 'crearperfil', createprofile: 'crearperfil',
    profile: 'perfil',
    status: 'estado',
    start: 'inicio',
    guide: 'guia',
    skills: 'habilidades',
    orientation: 'orientacion',
    where: 'pordonde',
    map: 'mapa',
    regions: 'regiones',
    go: 'ir',
    gear: 'equipo',
    forge: 'forjar',
    equipweapon: 'equipararma',
    arts: 'artes',
    learnart: 'aprenderarte',
    equipart: 'equipararte',
    clues: 'pistas',
    stages: 'escenarios',
    track: 'rastrear',
    guardians: 'guardianes',
    sovereign: 'soberano',
    subzones: 'subzonas',
    frontieruse: 'usarfrontera',
    frontierstart: 'iniciarfrontera',
    frontierjoin: 'unirsefrontera',
    frontierskill: 'habilidadfrontera',
    frontierfruit: 'frutafrontera',
    frontierdecide: 'decidirfrontera',
    frontierrun: 'huirfrontera',
    frontierattack: 'atacarfrontera',
    run: 'huir',
    flee: 'huir',
    combat: 'combate',
    dungeon: 'mazmorra',
    join: 'unirme',
    dungeonattack: 'mazmatacar',
    dungeonskill: 'mazmhabilidad',
    sell: 'vender',
    market: 'mercado',
    marketbuy: 'comprarmercado',
    marketcancel: 'cancelarventa',
    buyer: 'comprador',
    quicksell: 'venderrapido',
    shop: 'tienda',
    buyitem: 'compraritem',
    use: 'usar',
    hunt: 'cazar',
    roulette: 'ruleta',
    event: 'evento',
    bet: 'apostar',
    bag: 'inventario',
    achievements: 'logros',
    myfruits: 'misfrutas',
    equipfruit: 'equiparfruta',
    styles: 'estilos',
    buystyle: 'comprarestilo',
    equipstyle: 'equiparestilo',
    awaken: 'despertar',
    defend: 'defender',
    talknpc: 'hablarnpc',
    reputation: 'reputacion',
    frontiermissions: 'misionesfrontier',
    acceptquest: 'aceptarmision',
    turninquest: 'entregarmision',
    recipes: 'recetas',
    craft: 'fabricar',
    season: 'temporada',
    frontierworld: 'mundofrontier',
    frontierrank: 'clasificacionfrontier',
    resonance: 'resonancia',
    startresonance: 'iniciaresonancia',
    joinresonance: 'unirresonancia',
    attackresonance: 'atacarresonancia',
    artresonance: 'arteresonancia',
    fruitresonance: 'frutaresonancia',
    decideresonance: 'decidirresonancia',
    runresonance: 'huirresonancia',
    travel: 'viajar',
    island: 'isla',
    explore: 'explorar',
    islandhome: 'volverislaprincipal',
    attackislandboss: 'atacarbossisla',
    seas: 'mares',
    quests: 'misiones',
    quest: 'mision',
    claimquest: 'reclamarmision',
    dailyquest: 'misiondia',
    frontier: 'frontera',
    disable: 'desactivar',
    enable: 'activar',
    disabled: 'desactivados',
    language: 'idioma',
    lang: 'idioma',
    lingua: 'idioma',
    linguagem: 'idioma',
    player: 'jugador',
    fruits: 'frutas',
    activity: 'actividad',
    world: 'mundo',
    sockets: 'bots',
    qr: 'code',
    unir: 'join',
    setmenubanner: 'setbanner',
    seticon: 'setpp',
    setpfp: 'setpp',
    setimage: 'setpp',
    setlink: 'setbotlink',
    tag: 'hidetag',
    gp: 'groupinfo',
    setgpbaner: 'setgpbanner',
    closet: 'close',
    delwarn: 'unwarn',
    topmessages: 'topcount',
    topmensajes: 'topcount',
    topmsgcount: 'topcount',
    bye: 'goodbye',
    bienvenidas: 'welcome',
    antilinks: 'antilink',
    antienlaces: 'antilink',
    onlyadmin: 'adminonly',
    setbye: 'setgoodbye',
    mp3: 'ytmp3',
    playaudio: 'ytmp3',
    ytaudio: 'ytmp3',
    play2: 'ytmp4',
    mp4: 'ytmp4',
    playvideo: 'ytmp4',
    ytvideo: 'ytmp4',
    reel: 'instagram',
    sp: 'spotify',
    mf: 'mediafire',
    gemini: 'ia',
    geminiia: 'ia',
    dalle: 'imaginar',
    pfp: 'getpic',
    upscale: 'hd',
    toimage: 'toimg'
}

function aplicarAliasComando(cmd) {
    if (!cmd) return cmd
    return ALIAS_COMANDO_EN[cmd] || cmd
}
function textoUI(lang, clave, extra = {}) {
    const L = (lang === 'pt') ? 'pt' : (lang === 'en') ? 'en' : 'es'
    const T = {
        es: {
            elige: '🌐 *¿Qué idioma preferís?*\n\nElegí un idioma para *tus* mensajes del bot.\nTambién podés escribir:\n• {p}idioma es\n• {p}idioma pt\n• {p}idioma en',
            elegido: '✅ Idioma guardado: *{nombre}*\nEl bot te va a responder en ese idioma en menús y mensajes principales.',
            grupo_ok: '✅ Idioma del grupo: *{nombre}*\nQuien no tenga idioma personal va a usar este.',
            grupo_solo_admin: '❌ Solo admins pueden cambiar el idioma del grupo.',
            invalido: '❌ Idioma no válido. Usá *es*, *pt* o *en*.\nEj: {p}idioma pt',
            estado: '🌐 *Idioma*\n\nTu idioma: *{yo}*\nIdioma del grupo: *{grupo}*\n\nCambio personal: {p}idioma es | {p}idioma pt | {p}idioma en\nCambio del grupo (admin): {p}idioma grupo es | {p}idioma grupo pt | {p}idioma grupo en',
            menu_caption: '» ˚₊*– ͟͞ 𝖂𝖔𝖑𝖋𝖗𝖎𝖈-🜲\n——————————————>\n╭━━⪩ *PROTOCOLO CLÁSICO* ⪨━━\n> ❏ • El RPG original, ordenado por rutas.\n╰━━─「◌」─━━━━━━━━',
            seleccionar_menu: 'Seleccionar menú',
            categorias: 'Categorías',
            cat_desconocida: '❌ Categoría desconocida. Usá *{p}menu*',
            botones_fail: '❌ No se pudieron enviar botones en este chat. Usá *{p}menu*',
            accesos: '🐺 *Accesos rápidos*',
            btn_menu: 'Menú',
            btn_perfil: 'Perfil',
            btn_balance: 'Balance',
            solo_admins: '❌ Solo admins.'
        },
        pt: {
            elige: '🌐 *Qual idioma você prefere?*\n\nEscolha um idioma para *suas* mensagens do bot.\nVocê também pode escrever:\n• {p}idioma es\n• {p}idioma pt\n• {p}idioma en',
            elegido: '✅ Idioma salvo: *{nombre}*\nO bot vai responder nesse idioma nos menus e nas mensagens principais.',
            grupo_ok: '✅ Idioma do grupo: *{nombre}*\nQuem não tiver idioma pessoal vai usar este.',
            grupo_solo_admin: '❌ Só admins podem mudar o idioma do grupo.',
            invalido: '❌ Idioma inválido. Use *es*, *pt* ou *en*.\nEx: {p}idioma pt',
            estado: '🌐 *Idioma*\n\nSeu idioma: *{yo}*\nIdioma do grupo: *{grupo}*\n\nTroca pessoal: {p}idioma es | {p}idioma pt | {p}idioma en\nTroca do grupo (admin): {p}idioma grupo es | {p}idioma grupo pt | {p}idioma grupo en',
            menu_caption: '» ˚₊*– ͟͞ 𝖂𝖔𝖑𝖋𝖗𝖎𝖈-🜲\n——————————————>\n╭━━⪩ *PROTOCOLO CLÁSSICO* ⪨━━\n> ❏ • O RPG original, organizado por rotas.\n╰━━─「◌」─━━━━━━━━',
            seleccionar_menu: 'Selecionar menu',
            categorias: 'Categorias',
            cat_desconocida: '❌ Categoria desconhecida. Use *{p}menu*',
            botones_fail: '❌ Não foi possível enviar botões neste chat. Use *{p}menu*',
            accesos: '🐺 *Atalhos rápidos*',
            btn_menu: 'Menu',
            btn_perfil: 'Perfil',
            btn_balance: 'Saldo',
            solo_admins: '❌ Apenas admins.'
        },
        en: {
            elige: '🌐 *Which language do you prefer?*\n\nChoose a language for *your* bot messages.\nYou can also type:\n• {p}idioma es\n• {p}idioma pt\n• {p}idioma en',
            elegido: '✅ Language saved: *{nombre}*\nThe bot will reply to you in that language in menus and main messages.',
            grupo_ok: '✅ Group language: *{nombre}*\nAnyone without a personal language will use this one.',
            grupo_solo_admin: '❌ Only admins can change the group language.',
            invalido: '❌ Invalid language. Use *es*, *pt* or *en*.\nEx: {p}idioma en',
            estado: '🌐 *Language*\n\nYour language: *{yo}*\nGroup language: *{grupo}*\n\nPersonal change: {p}idioma es | {p}idioma pt | {p}idioma en\nGroup change (admin): {p}idioma grupo es | {p}idioma grupo pt | {p}idioma grupo en',
            menu_caption: '» ˚₊*– ͟͞ 𝖂𝖔𝖑𝖋𝖗𝖎𝖈-🜲\n——————————————>\n╭━━⪩ *CLASSIC PROTOCOL* ⪨━━\n> ❏ • The original RPG, organized by route.\n╰━━─「◌」─━━━━━━━━',
            seleccionar_menu: 'Select menu',
            categorias: 'Categories',
            cat_desconocida: '❌ Unknown category. Use *{p}menu*',
            botones_fail: '❌ Buttons could not be sent in this chat. Use *{p}menu*',
            accesos: '🐺 *Quick access*',
            btn_menu: 'Menu',
            btn_perfil: 'Profile',
            btn_balance: 'Balance',
            solo_admins: '❌ Admins only.'
        }
    }
    let s = (T[L] && T[L][clave]) || (T.es[clave]) || clave
    s = s.replace(/\{p\}/g, extra.p || prefix || '.')
    s = s.replace(/\{nombre\}/g, extra.nombre || '')
    s = s.replace(/\{yo\}/g, extra.yo || '')
    s = s.replace(/\{grupo\}/g, extra.grupo || '')
    return s
}

// Categorías de comandos, para apagar varios de una con un solo nombre (ej: .desactivar casino)
const CATEGORIAS_COMANDOS = {
    casino: ['casino', 'apostar', 'ruleta', 'tragamonedas'],
    descargas: ['play', 'ytmp3', 'ytmp4', 'tiktok', 'tt', 'ig', 'instagram', 'fb', 'facebook', 'kwai', 'kawai', 'spotify', 'sp', 'mediafire', 'mf', 'reel', 'mp3', 'play2', 'mp4', 'spotify', 'sp', 'mediafire', 'mf', 'reel'],
    stickers: ['sticker', 's', 'take', 'toimg', 'smeta', 'sinfo', 'sreset', 'salbum', 'getpic', 'pfp', 'hd', 'upscale', 'tourl', 'get', 'removebg', 'toimage'],
    ia: ['ia', 'gemini', 'dalle', 'gptimage', 'suno', 'suno2', 'iachat'],
    torneo: ['torneo'],
    pvp: ['duel', 'attack', 'useskill', 'arte', 'ultimate'],
    // Todo el juego (economía, combate, frutas, mazmorras, gremios, mercado, frontier, etc.)
    // Con esto apagado en un grupo, el bot queda solo con moderación/utilidad/media/IA —
    // no hace falta apagar cada cosa suelta. Se completa más abajo con los comandos de
    // TITULOS en cuanto ese array queda definido (los títulos son parte del juego).
    rpg: [
        'frontera', 'perfil', 'estado', 'inicio', 'guia', 'habilidades', 'orientacion', 'pordonde',
        'mapa', 'regiones', 'ir', 'equipo', 'forjar', 'equipararma', 'artes', 'aprenderarte', 'equipararte',
        'pistas', 'escenarios', 'rastrear', 'guardianes', 'soberano', 'subzonas', 'elites', 'usarfrontera',
        'iniciarfrontera', 'unirsefrontera', 'habilidadfrontera', 'frutafrontera', 'decidirfrontera',
        'huirfrontera', 'atacarfrontera', 'huir', 'combate', 'loadout', 'arte2v2', 'defender2v2',
        'balance', 'daily', 'work', 'rob', 'pay', 'inventory', 'inventario',
        'stats', 'statsup', 'bounty', 'casino', 'train', 'entrenar', 'ranking', 'reclamarmision', 'misiondia',
        'apostar', 'heal', 'bountytop', 'cazar', 'ruleta', 'evento', 'crearperfil',
        'fruitgacha', 'fruitfree', 'fruits', 'misfrutas', 'equiparfruta', 'skillinfo',
        'estilos', 'comprarestilo', 'equiparestilo',
        'tienda', 'compraritem', 'usar', 'item',
        'duel', 'acceptduel', 'attack', 'atacar', 'useskill', 'habilidad', 'ultimate', 'arte', 'usararte',
        'defender', 'despertar', 'forfeit',
        'duel2v2', 'acceptduel2v2', 'atacar2v2', 'habilidad2v2', 'ultimate2v2', 'item2v2', 'forfeit2v2',
        'mazmorra', 'unirme', 'mazmatacar', 'mazmhabilidad',
        'vender', 'mercado', 'comprarmercado', 'cancelarventa', 'comprador', 'venderrapido', 'setimpuestomercado',
        'trade', 'accepttrade', 'canceltrade',
        'admin_overdrive_on', 'overdrive_on', 'admin_overdrive_off', 'overdrive_off',
        'admin_set_asset', 'setasset', 'admin_set_stats', 'setstats', 'admin_event_control', 'eventcontrol',
        'admin_frontier_status', 'admin_frontier_season', 'admin_frontier_reset',
        'titles', 'titleequip', 'titlelist', 'granttitle', 'logros', 'logro', 'npc', 'hablarnpc', 'reputacion',
        'misionesfrontier', 'aceptarmision', 'entregarmision', 'recetas', 'fabricar', 'temporada', 'mundofrontier',
        'clasificacionfrontier', 'resonancia', 'iniciaresonancia', 'unirresonancia', 'atacarresonancia',
        'arteresonancia', 'frutaresonancia', 'decidirresonancia', 'huirresonancia',
        'guild', 'mares', 'viajar', 'isla', 'explorar', 'atacarbossisla', 'volverislaprincipal', 'misiones', 'mision',
        'spawnboss', 'spawn_boss', 'attackboss', 'skillboss',
        'torneo', 'programarevento', 'eventosactivos'
    ]
}

const spamTracker = new Map() // jid+chat -> [timestamps]
function esSpam(chat, sender) {
    const key = chat + '|' + sender
    const now = Date.now()
    const arr = (spamTracker.get(key) || []).filter(t0 => now - t0 < 8000)
    arr.push(now)
    spamTracker.set(key, arr)
    return arr.length >= 6
}



function getMisionDia(user) {
    const dia = new Date().toISOString().slice(0, 10)
    if (!user.misionDia || user.misionDia.fecha !== dia) {
        user.misionDia = { fecha: dia, work: false, train: false, casino: false, reclamado: false }
    }
    return user.misionDia
}
function marcarMisionDia(user, tipo) {
    const m0 = getMisionDia(user)
    if (tipo === 'work') m0.work = true
    if (tipo === 'train') m0.train = true
    if (tipo === 'casino' || tipo === 'apostar') m0.casino = true
}
function textoMisionDia(m0, prefix) {
    const ok = v => v ? '✅' : '☐'
    return `🎯 *Daily quest*\n${ok(m0.work)} ${prefix}work\n${ok(m0.train)} ${prefix}train\n${ok(m0.casino)} ${prefix}casino o ${prefix}bet\n\nPremio: $250 + 40 EXP\n${prefix}claimquest`
}

function backupEconomiaAhora() {
    try {
        if (!fs.existsSync(ECONOMIA_FILE)) return
        const dir = path.join(process.cwd(), 'backups')
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const dest = path.join(dir, `economia_${stamp}.json`)
        fs.copyFileSync(ECONOMIA_FILE, dest)
        // conserva max 20 backups
        const files = fs.readdirSync(dir).filter(f => f.startsWith('economia_')).sort()
        while (files.length > 20) {
            const old = files.shift()
            try { fs.unlinkSync(path.join(dir, old)) } catch (_) {}
        }
        console.log('[WOLFRIC] Backup economia →', dest)
    } catch (e) {
        console.log('[WOLFRIC] Backup error:', e.message || e)
    }
}

function cargarBotConfig() {
    try {
        if (fs.existsSync(BOT_CONFIG_FILE)) {
            botConfig = Object.assign(botConfig, JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8')))
        }
    } catch (e) { console.log('Error cargando bot_config:', e.message) }
}
function guardarBotConfig() {
    try { fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(botConfig, null, 2)) } catch (e) { console.log('Error guardando bot_config:', e.message) }
}
cargarBotConfig()
if (PREFIJOS_PERMITIDOS.includes(botConfig.prefix)) prefix = botConfig.prefix

// ============================================================
// ========== INTEGRACIÓN CON IA (Google Gemini) ==============
// ============================================================
// Requiere GEMINI_API_KEY como variable de entorno (nunca hardcodeada).
// Conseguí una gratis en https://aistudio.google.com/apikey
// ⚠️ Clave hardcodeada a pedido — si compartís este código/zip con alguien
// o lo subís a un repo público, esta clave queda expuesta. Se puede pisar
// sin tocar el código arrancando con: GEMINI_API_KEY=otra_clave node index.js
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_MODEL = 'gemini-3.6-flash' // gemini-2.0-flash quedó dado de baja por Google; este es el reemplazo estable actual

// Tope diario + piso entre llamadas: para no comerse la cuota gratis (ni la
// tarjeta, si algún día pasás a un plan pago) por un grupo muy activo.
let iaLlamadasHoy = 0
let iaFechaContador = new Date().toISOString().slice(0, 10)
const IA_TOPE_DIARIO = 300
let ultimaLlamadaIA = 0
const IA_PISO_MS = 1200

// Historial corto por chat, solo en memoria (se resetea si el bot reinicia).
// Es lo que hace que el modo chat "recuerde" lo último que se habló.
const iaHistorial = new Map() // jid -> [{ role: 'user'|'model', text }]
const IA_HISTORIAL_MAX = 10

function iaAgregarHistorial(jid, role, text) {
    if (!iaHistorial.has(jid)) iaHistorial.set(jid, [])
    const h = iaHistorial.get(jid)
    h.push({ role, text })
    while (h.length > IA_HISTORIAL_MAX) h.shift()
}

async function _geminiRequest(contents, systemPrompt, maxTokens) {
    if (!GEMINI_API_KEY) throw new Error('El owner todavía no configuró GEMINI_API_KEY.')
    if (typeof fetch === 'undefined') throw new Error('Necesitás Node 18 o superior (usa fetch nativo). Actualizá Node en Termux con: pkg upgrade nodejs')
    const hoy = new Date().toISOString().slice(0, 10)
    if (iaFechaContador !== hoy) { iaFechaContador = hoy; iaLlamadasHoy = 0 }
    if (iaLlamadasHoy >= IA_TOPE_DIARIO) throw new Error('Se alcanzó el límite diario de consultas a la IA. Probá de nuevo mañana.')
    const espera = IA_PISO_MS - (Date.now() - ultimaLlamadaIA)
    if (espera > 0) await sleep(espera)
    ultimaLlamadaIA = Date.now()
    iaLlamadasHoy++

    // Los modelos gemini-3.x ya no aceptan temperature/top_p/top_k (los sacaron).
    // Y por defecto "piensan" antes de responder (puede gastar miles de tokens
    // invisibles) — eso era lo que causaba la demora y las respuestas cortadas a
    // la mitad, porque el pensamiento se comía parte del límite de maxOutputTokens.
    // thinkingLevel "low" lo deja rápido y directo, ideal para un chat de WhatsApp.
    const body = { contents, generationConfig: { maxOutputTokens: maxTokens || 800, thinkingConfig: { thinkingLevel: 'low' } } }
    if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!resp.ok) {
        const errTxt = await resp.text().catch(() => '')
        throw new Error(`Gemini devolvió ${resp.status}: ${errTxt.slice(0, 200)}`)
    }
    const data = await resp.json()
    const texto = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim()
    if (!texto) throw new Error('Gemini no devolvió texto (puede haber filtrado la respuesta por seguridad).')
    if (data?.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
        console.log('[WOLFRIC] Respuesta de Gemini cortada por límite de tokens (finishReason MAX_TOKENS)')
    }
    return texto
}

async function preguntarGemini(prompt, { systemPrompt = '', historial = [] } = {}) {
    const contents = [
        ...historial.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
        { role: 'user', parts: [{ text: prompt }] }
    ]
    return _geminiRequest(contents, systemPrompt, 800)
}

// Análisis de imágenes: manda la imagen (en base64) + una consigna de texto.
async function preguntarGeminiImagen(prompt, base64Data, mimeType, systemPrompt = '') {
    const contents = [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Data } }] }]
    return _geminiRequest(contents, systemPrompt, 700)
}

// Persona del bot para que las respuestas se sientan parte de Wolfric, no un asistente genérico.
function iaSystemPrompt(lang = 'es') {
    if (lang === 'pt') {
        return `Você é ${botConfig.botName} ${botConfig.botEmoji}, um bot de WhatsApp descontraído. Fale em português informal do Brasil, com mensagens CURTAS (2-4 linhas no máximo, isto é um chat de WhatsApp, não uma redação). Pode usar algum emoji, sem exagerar. Não use markdown de títulos. Se não souber algo, diga com confiança e boa onda.`
    }
    return `Sos ${botConfig.botName} ${botConfig.botEmoji}, un bot de WhatsApp con onda, hablás en español informal (como alguien de Latinoamérica), con mensajes CORTOS (2-4 líneas máximo, esto es un chat de WhatsApp, no un ensayo). Podés usar algún emoji, sin abusar. No uses markdown de encabezados. Si no sabés algo, decilo con confianza y de buena onda, sin ser pesado ni dar cátedra.`
}

// Texto de ambientación al aparecer un boss (opcional, no bloquea el aviso principal).
// Si no hay GEMINI_API_KEY o falla, simplemente no manda nada extra — el aviso normal
// del boss ya salió antes, así que un fallo acá no rompe nada.
async function narrarBossIA(sock, from, nombreBoss) {
    if (!GEMINI_API_KEY) return
    try {
        const texto = await preguntarGemini(
            `Escribí 1 o 2 líneas cortas y dramáticas (estilo videojuego/anime, en español) anunciando que apareció un enemigo/boss llamado "${nombreBoss}" en un chat de WhatsApp. Sin emojis de más, sin saludos, directo a la ambientación.`,
            { systemPrompt: 'Sos un narrador breve de un RPG por WhatsApp. Máximo 2 líneas, nada de relleno.' }
        )
        await sendReply(sock, from, { text: `_${texto}_` })
    } catch (e) {
        console.log('[WOLFRIC] No se pudo narrar el boss con IA:', e.message || e)
    }
}

// ---- Anti-peleas: detecta insultos/ataques (a otra persona o al bot) y avisa,
// SIN aplicar ningún strike/warn real ni tocar el sistema de kicks. Es solo un
// llamado de atención de buena onda, para cortar la pelea antes de que escale.
const PALABRAS_CONFLICTO = [
    'idiota', 'estupid', 'imbecil', 'imbécil', 'inutil', 'inútil', 'basura', 'mierda',
    'pendejo', 'maricon', 'marica', 'puto', 'puta', 'cállate', 'callate', 'odio',
    'asco', 'perra', 'zorra', 'gonorrea', 'huevon', 'weon', 'malparido', 'hijueputa',
    'hp', 'cabron', 'cabrón', 'estorbo', 'sobra', 'nadie te quiere', 'te odio',
    'sos un', 'eres un', 'que se calle', 'callense', 'cállense'
]
const antipeleasUltimaAlerta = new Map() // jid del grupo -> timestamp (cooldown para no repetir en cada mensaje de la misma pelea)
const ANTIPELEAS_COOLDOWN_MS = 45 * 1000

// ---- Log liviano de mensajes recientes por grupo, solo en memoria, para .resumen ----
const logMensajesGrupo = new Map() // gid -> [{ nombre, texto, ts }]
const LOG_MENSAJES_MAX = 60
function registrarMensajeGrupo(gid, nombre, texto) {
    if (!logMensajesGrupo.has(gid)) logMensajesGrupo.set(gid, [])
    const log = logMensajesGrupo.get(gid)
    log.push({ nombre, texto, ts: Date.now() })
    while (log.length > LOG_MENSAJES_MAX) log.shift()
}
const ultimoResumen = new Map() // gid -> timestamp (cooldown, ya que .resumen lo puede pedir cualquiera)

const antipeleasCerradoPorBot = new Map() // gid -> true mientras el bot lo tenga cerrado (para no reabrir algo que cerró un admin a mano)

async function revisarConflicto(sock, from, sender, body, m, citadoJid, gcfg) {
    try {
        const textoLower = body.toLowerCase()
        const posibleConflicto = PALABRAS_CONFLICTO.some(p => textoLower.includes(p))
        if (!posibleConflicto) return
        const ultima = antipeleasUltimaAlerta.get(from) || 0
        if (Date.now() - ultima < ANTIPELEAS_COOLDOWN_MS) return
        if (!GEMINI_API_KEY) return

        const veredicto = await preguntarGemini(
            `Mensaje de un grupo de WhatsApp: "${body}"\n\n¿Este mensaje insulta, humilla o ataca de mala manera a otra persona, o insulta al bot del grupo? Respondé ÚNICAMENTE "SI" o "NO", nada más.`,
            { systemPrompt: 'Respondés solo con la palabra SI o NO, sin explicación, sin puntuación extra.' }
        )
        if (!/^si/i.test(veredicto.trim())) return

        antipeleasUltimaAlerta.set(from, Date.now())
        const involucrados = [sender]
        if (citadoJid && !involucrados.includes(citadoJid)) involucrados.push(citadoJid)
        const tags = involucrados.map(j => '@' + j.split('@')[0]).join(' y ')

        const accion = gcfg?.antipeleasAccion || 'cerrar'
        const minutos = gcfg?.antipeleasMinutos || 3

        if (accion === 'cerrar' && !antipeleasCerradoPorBot.get(from)) {
            try {
                await sock.groupSettingUpdate(from, 'announcement') // solo admins pueden escribir
                antipeleasCerradoPorBot.set(from, true)
                await sendReply(sock, from, {
                    text: tr(obtenerIdioma(from), `🔒 Grupo cerrado temporalmente (${minutos} min) — se detectó una pelea entre ${tags}.\n\nEsto NO es un strike ni un baneo a nadie, solo un enfriamiento para toda la sala. Se vuelve a abrir solo.`, `🔒 Grupo fechado por um tempo (${minutos} min) — deu briga entre ${tags}.\n\nIsso NÃO é strike nem ban pra ninguém, só um resfriamento pra sala toda. Reabre sozinho.`, `🔒 Group temporarily locked (${minutos} min) — a fight was spotted between ${tags}.\n\nThis is NOT a strike or a ban on anyone, just a cooldown for the whole room. It reopens on its own.`),
                    mentions: involucrados
                }, { quoted: m })
                setTimeout(async () => {
                    try {
                        if (!antipeleasCerradoPorBot.get(from)) return // ya lo reabrieron/gestionaron a mano, no tocar
                        await sock.groupSettingUpdate(from, 'not_announcement')
                        antipeleasCerradoPorBot.delete(from)
                        await sendReply(sock, from, { text: tr(obtenerIdioma(from), '🔓 Grupo reabierto. Ojalá se haya enfriado todo — sigan de buena.', '🔓 Grupo reaberto. Espero que tenha esfriado — sigam de boa.', '🔓 Group reopened. Hope it cooled off — keep it chill.') })
                    } catch (e) {
                        console.log('[WOLFRIC] No se pudo reabrir el grupo tras anti-peleas:', e.message || e)
                    }
                }, minutos * 60 * 1000)
            } catch (e) {
                console.log('[WOLFRIC] No se pudo cerrar el grupo (¿el bot es admin?):', e.message || e)
                await sendReply(sock, from, {
                    text: tr(obtenerIdioma(from), `👀 Che, ${tags} — bajen un cambio, se está poniendo pesado. (Quise cerrar el grupo pero necesito ser admin para eso.)`, `👀 Ei, ${tags} — abaixem o tom, tá esquentando. (Quis fechar o grupo mas preciso ser admin pra isso.)`, `👀 Hey, ${tags} — tone it down, it's getting heated. (Tried to lock the group but I need to be admin for that.)`),
                    mentions: involucrados
                }, { quoted: m })
            }
        } else if (accion !== 'cerrar') {
            await sendReply(sock, from, {
                text: tr(obtenerIdioma(from), `👀 Che, ${tags} — bajen un cambio, se está poniendo pesado.\n\nEsto NO es un strike ni una advertencia formal, solo un aviso de buena onda. Si sigue subiendo de tono, ahí sí puede intervenir un admin de verdad.`, `👀 Ei, ${tags} — abaixem o tom, tá esquentando.\n\nIsso NÃO é strike nem advertência formal, só um aviso de boa. Se continuar subindo o tom, aí sim um admin de verdade pode entrar.`, `👀 Hey, ${tags} — tone it down, it's getting heated.\n\nThis is NOT a strike or a formal warning, just a friendly heads-up. If it keeps escalating, a real admin can step in.`),
                mentions: involucrados
            }, { quoted: m })
        }
    } catch (e) {
        console.log('[WOLFRIC] Anti-peleas no pudo revisar el mensaje:', e.message || e)
    }
}

// Modo chat: el bot responde como un miembro más, con historial corto por grupo.
async function manejarIaChat(sock, from, sender, body, m) {
    try {
        const respuesta = await preguntarGemini(body, { systemPrompt: iaSystemPrompt(obtenerIdioma(from, sender)), historial: iaHistorial.get(from) || [] })
        iaAgregarHistorial(from, 'user', body)
        iaAgregarHistorial(from, 'model', respuesta)
        await sendReply(sock, from, { text: respuesta }, { quoted: m })
    } catch (e) {
        // En modo chat, si falla (sin cuota, sin key, etc.) no contesta nada — no tiene sentido
        // llenar el grupo de errores por cada mensaje que mande la gente.
        console.log('[WOLFRIC] IA chat no respondió:', e.message || e)
    }
}


// ========== reportes, estadísticas de uso, avisos ===========
// ============================================================

// ---------- Estadísticas de uso (para el panel de balance) ----------
const USO_STATS_FILE = './uso_stats.json'
let usoStats = { items: {}, frutas: {}, dineroDestruido: 0 }
function cargarUsoStats() {
    try { if (fs.existsSync(USO_STATS_FILE)) usoStats = Object.assign(usoStats, JSON.parse(fs.readFileSync(USO_STATS_FILE, 'utf8'))) } catch (e) {}
}
function guardarUsoStats() {
    try { fs.writeFileSync(USO_STATS_FILE, JSON.stringify(usoStats, null, 2)) } catch (e) {}
}
cargarUsoStats()
function registrarUsoItem(nombre) { usoStats.items[nombre] = (usoStats.items[nombre] || 0) + 1; guardarUsoStats() }
function registrarUsoFruta(nombre) { usoStats.frutas[nombre] = (usoStats.frutas[nombre] || 0) + 1; guardarUsoStats() }
function registrarDineroDestruido(monto) { usoStats.dineroDestruido = (usoStats.dineroDestruido || 0) + Math.max(0, monto); guardarUsoStats() }

// ---------- Sistema de referidos ----------
// El código es corto y legible (no un jid completo) para que se pueda compartir.
function generarCodigoReferido(user) {
    if (!user.codigoReferido) {
        user.codigoReferido = crypto.randomBytes(3).toString('hex').toUpperCase()
    }
    return user.codigoReferido
}
function buscarPorCodigoReferido(codigo) {
    const c = String(codigo || '').trim().toUpperCase()
    if (!c) return null
    for (const [jid, u] of Object.entries(economia)) {
        if (u.codigoReferido === c) return jid
    }
    return null
}

// ---------- Reportes de usuarios ----------
const REPORTES_FILE = './reportes.json'
let reportes = []
function cargarReportes() {
    try { if (fs.existsSync(REPORTES_FILE)) reportes = JSON.parse(fs.readFileSync(REPORTES_FILE, 'utf8')) || [] } catch (e) { reportes = [] }
}
function guardarReportes() {
    try {
        if (reportes.length > 500) reportes = reportes.slice(reportes.length - 500)
        fs.writeFileSync(REPORTES_FILE, JSON.stringify(reportes, null, 2))
    } catch (e) {}
}
cargarReportes()
const ultimoReportePorUsuario = new Map() // jid -> timestamp (cooldown anti-spam)
const ultimaConsultaIA = new Map() // jid -> timestamp (cooldown anti-spam del comando .ia)

// ---------- Eventos programados (doble XP / doble drop en fechas fijas) ----------
const EVENTOS_PROGRAMADOS_FILE = './eventos_programados.json'
let eventosProgramados = [] // { nombre, desde (ISO), hasta (ISO), tipo: 'xp'|'drop', multiplicador }
function cargarEventosProgramados() {
    try { if (fs.existsSync(EVENTOS_PROGRAMADOS_FILE)) eventosProgramados = JSON.parse(fs.readFileSync(EVENTOS_PROGRAMADOS_FILE, 'utf8')) || [] } catch (e) { eventosProgramados = [] }
}
function guardarEventosProgramados() {
    try { fs.writeFileSync(EVENTOS_PROGRAMADOS_FILE, JSON.stringify(eventosProgramados, null, 2)) } catch (e) {}
}
cargarEventosProgramados()
function eventosActivosAhora() {
    const ahora = Date.now()
    return eventosProgramados.filter(e => {
        const desde = Date.parse(e.desde)
        const hasta = Date.parse(e.hasta)
        return !isNaN(desde) && !isNaN(hasta) && ahora >= desde && ahora <= hasta
    })
}
// Devuelve el multiplicador más alto activo para ese tipo (1 si no hay ninguno)
function multiplicadorActivo(tipo) {
    const activos = eventosActivosAhora().filter(e => e.tipo === tipo)
    if (!activos.length) return 1
    return Math.max(...activos.map(e => Number(e.multiplicador) || 1))
}

// ---------- Modo torneo (bracket simple de eliminación directa) ----------
const TORNEOS_FILE = './torneos.json'
let torneosPorGrupo = new Map() // chatId -> { premio, estado, inscritos:[], bracket:[[{a,b,ganador}]], rondaActual }
function cargarTorneos() {
    try {
        if (fs.existsSync(TORNEOS_FILE)) {
            const datos = JSON.parse(fs.readFileSync(TORNEOS_FILE, 'utf8')) || {}
            for (const [chatId, t] of Object.entries(datos)) torneosPorGrupo.set(chatId, t)
        }
    } catch (e) {}
}
function guardarTorneos() {
    try { fs.writeFileSync(TORNEOS_FILE, JSON.stringify(Object.fromEntries(torneosPorGrupo), null, 2)) } catch (e) {}
}
cargarTorneos()
function torneoBarajar(arr) {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]]
    }
    return a
}
// Genera los emparejamientos de una ronda a partir de la lista de jugadores que siguen en pie.
// Si son impares, el último queda libre (bye) y avanza directo.
function torneoGenerarRonda(jugadores) {
    const mezclados = torneoBarajar(jugadores)
    const ronda = []
    for (let i = 0; i < mezclados.length; i += 2) {
        if (mezclados[i + 1]) {
            ronda.push({ a: mezclados[i], b: mezclados[i + 1], ganador: null })
        } else {
            ronda.push({ a: mezclados[i], b: null, ganador: mezclados[i] }) // bye
        }
    }
    return ronda
}
function torneoTextoRonda(ronda, numero) {
    const lineas = ronda.map((match, i) => {
        if (!match.b) return `${i + 1}. @${match.a.split('@')[0]} pasa libre (bye)`
        const marcador = match.ganador ? ` → ganó @${match.ganador.split('@')[0]}` : ''
        return `${i + 1}. @${match.a.split('@')[0]} vs @${match.b.split('@')[0]}${marcador}`
    })
    return `🏆 *Ronda ${numero}*\n\n${lineas.join('\n')}`
}

// ---------- Avisos automáticos a un grupo configurado ----------
// Requiere .setgrupoavisos (owner) para configurar el grupo de destino, y que el
// socket ya esté conectado (global.wolfricSock se setea cuando abre la conexión).
async function enviarAvisoGrupo(texto, opts = {}) {
    try {
        const sockActual = global.wolfricSock
        if (!sockActual || !botConfig.grupoAvisos) return false
        await esperarTurnoEnvio()
        await sockActual.sendMessage(botConfig.grupoAvisos, { text: texto, ...opts })
        return true
    } catch (e) {
        console.log('[WOLFRIC] Error enviando aviso automático:', e.message || e)
        return false
    }
}

// Texto del ranking, reutilizado por el comando .ranking y por la publicación semanal automática.
function generarTextoRanking() {
    const lista = Object.entries(economia).map(([id, u]) => ({ id, coins: u.coins || 0, level: u.level || 1, nombre: (u.frontier && u.frontier.nombre) || id.split('@')[0] }))
    lista.sort((a, b) => b.coins - a.coins)
    const top = lista.slice(0, 10).map((u, i) => `${i + 1}. ${u.nombre} · Nv.${u.level} · $${u.coins}`).join('\n')
    return `📊 *Ranking semanal (monedas)*\n\n${top || 'Sin datos'}\n\n_Se ordena por saldo actual._`
}


// ========== LISTA DE PERSONAJES (GACHA) ==========
// ========== STICKERS (usando ffmpeg, sin dependencias nativas problemáticas) ==========
async function convertirAWebpSticker(buffer) {
    const id = crypto.randomBytes(6).toString('hex')
    const inputPath = path.join(os.tmpdir(), `in-${id}`)
    const outputPath = path.join(os.tmpdir(), `out-${id}.webp`)
    fs.writeFileSync(inputPath, buffer)
    try {
        await execFileAsync('ffmpeg', ['-y', '-i', inputPath,
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-c:v', 'libwebp', '-lossless', '0', '-q:v', '70', '-loop', '0', '-an', '-vsync', '0', outputPath])
        return fs.readFileSync(outputPath)
    } finally {
        try { fs.unlinkSync(inputPath) } catch (e) {}
        try { fs.unlinkSync(outputPath) } catch (e) {}
    }
}

// Agrega metadata de pack/autor al sticker (nombre del pack + publicador),
// escribiendo el chunk EXIF directamente en el contenedor RIFF del webp.
// Es el mismo formato que usa WhatsApp para mostrar "Pack · Autor" al
// mantener presionado un sticker. Sin dependencias nuevas.
function agregarMetadataSticker(webpBuffer, packname, author) {
    try {
        const json = {
            'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
            'sticker-pack-name': packname || 'Wolfric',
            'sticker-pack-publisher': author || 'Wolfric Protocol',
            emojis: ['🐺']
        }
        const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf-8')
        const exifHeader = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])
        const exif = Buffer.concat([exifHeader, jsonBuffer])
        exif.writeUIntLE(jsonBuffer.length, 14, 4)

        // Ubicar el chunk RIFF existente y anexar el chunk EXIF.
        if (webpBuffer.length < 12 || webpBuffer.toString('ascii', 0, 4) !== 'RIFF' || webpBuffer.toString('ascii', 8, 12) !== 'WEBP') {
            return webpBuffer // no es un webp válido, se devuelve tal cual
        }
        const chunkHeader = Buffer.from('EXIF')
        const chunkSize = Buffer.alloc(4)
        chunkSize.writeUInt32LE(exif.length, 0)
        const padding = exif.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0)
        const exifChunk = Buffer.concat([chunkHeader, chunkSize, exif, padding])

        const nuevo = Buffer.concat([webpBuffer, exifChunk])
        const nuevoTamañoRiff = nuevo.length - 8
        nuevo.writeUInt32LE(nuevoTamañoRiff, 4)
        return nuevo
    } catch (e) {
        console.log('[WOLFRIC] No se pudo agregar metadata al sticker:', e.message || e)
        return webpBuffer
    }
}

async function convertirWebpAImagen(buffer) {
    const id = crypto.randomBytes(6).toString('hex')
    const inputPath = path.join(os.tmpdir(), `in-${id}.webp`)
    const outputPath = path.join(os.tmpdir(), `out-${id}.png`)
    fs.writeFileSync(inputPath, buffer)
    try {
        await execFileAsync('ffmpeg', ['-y', '-i', inputPath, outputPath])
        return fs.readFileSync(outputPath)
    } finally {
        try { fs.unlinkSync(inputPath) } catch (e) {}
        try { fs.unlinkSync(outputPath) } catch (e) {}
    }
}

// ========== DESCARGAS (yt-dlp + ffmpeg) — YouTube, TikTok, Instagram, Facebook ==========
// Todas las llamadas van con execFileAsync (argumentos en array, sin shell),
// así que nada de lo que el usuario escriba en el chat puede inyectar
// comandos, sin importar comillas, `;`, backticks, etc.
async function descargarMediaYoutube(query, tipo = 'audio') {
    const id = crypto.randomBytes(6).toString('hex')
    const tmpDir = os.tmpdir()
    const outBase = path.join(tmpDir, `yt-${id}`)
    const isUrl = /^https?:\/\//i.test(query.trim())

    let url = query.trim()
    if (!isUrl) {
        const { stdout } = await execFileAsync('yt-dlp', [`ytsearch1:${query}`, '--get-id', '--no-playlist'])
        const videoId = (stdout || '').trim().split('\n')[0]
        if (!videoId) throw new Error('No encontré resultados')
        url = `https://www.youtube.com/watch?v=${videoId}`
    }

    if (tipo === 'audio') {
        const outFile = `${outBase}.mp3`
        await execFileAsync('yt-dlp', ['-x', '--audio-format', 'mp3', '--audio-quality', '128K', '-o', outFile, '--no-playlist', '--max-filesize', '15M', url], { timeout: 120000 })
        if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1000) throw new Error('No se pudo descargar el audio')
        const buffer = fs.readFileSync(outFile)
        try { fs.unlinkSync(outFile) } catch (_) {}
        return { buffer, tipo: 'audio', mimetype: 'audio/mpeg', fileName: 'audio.mp3' }
    } else {
        const outFile = `${outBase}.mp4`
        // Preferir H.264 + AAC ya listo (WhatsApp). Evita recodificar AV1 60fps en el celular.
        try {
            await execFileAsync('yt-dlp', [
                '-f', 'bv*[vcodec^=avc1][height<=480]+ba[acodec^=mp4a]/bv*[vcodec^=avc1][height<=720]+ba[acodec^=mp4a]/b[ext=mp4][vcodec^=avc1]/b[ext=mp4]/18/worst',
                '--merge-output-format', 'mp4', '-o', outFile, '--no-playlist', '--max-filesize', '16M',
                '--match-filter', 'duration < 200 && duration > 5', url
            ], { timeout: 180000 })
        } catch (e) {
            throw new Error('No se pudo bajar el video (link, peso o YouTube).')
        }
        if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1000) throw new Error('No se pudo descargar el video')

        let codec = ''
        try {
            const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', outFile])
            codec = String(stdout || '').trim().toLowerCase()
        } catch (_) {}

        const yaOk = codec === 'h264'
        if (!yaOk) {
            const recode = `${outBase}.wa.mp4`
            try {
                await execFileAsync('ffmpeg', ['-y', '-i', outFile, '-vf', "scale='min(640,iw)':-2", '-r', '24', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-shortest', recode], { timeout: 240000 })
                try { fs.unlinkSync(outFile) } catch (_) {}
                if (!fs.existsSync(recode) || fs.statSync(recode).size < 1000) throw new Error('convert')
                fs.renameSync(recode, outFile)
            } catch (e) {
                try { fs.unlinkSync(recode) } catch (_) {}
                throw new Error('El video es muy pesado para convertirlo en el celular. Probá uno más corto o .ytmp3')
            }
        }

        const buffer = fs.readFileSync(outFile)
        try { fs.unlinkSync(outFile) } catch (_) {}
        if (buffer.length > 16 * 1024 * 1024) throw new Error('El video pesa más de 16MB. Probá uno más corto.')
        return { buffer, tipo: 'video', mimetype: 'video/mp4', fileName: 'video.mp4' }
    }
}

// Descarga genérica de video para TikTok / Instagram / Facebook (yt-dlp soporta los tres).
// A diferencia de YouTube, acá siempre se espera un link directo, no búsqueda por texto.
async function descargarVideoRedSocial(url, plataforma) {
    const urlLimpia = url.trim()
    if (!/^https?:\/\//i.test(urlLimpia)) throw new Error(`Mandá un link válido de ${plataforma}.`)

    const dominiosValidos = {
        tiktok: /tiktok\.com/i,
        instagram: /instagram\.com/i,
        facebook: /(facebook\.com|fb\.watch)/i,
        kwai: /(kwai\.com|kw\.ai)/i
    }
    if (dominiosValidos[plataforma] && !dominiosValidos[plataforma].test(urlLimpia)) {
        throw new Error(`Ese link no parece de ${plataforma}.`)
    }

    const id = crypto.randomBytes(6).toString('hex')
    const outFile = path.join(os.tmpdir(), `${plataforma}-${id}.mp4`)
    try {
        await execFileAsync('yt-dlp', [
            '-f', 'b[ext=mp4]/best', '--merge-output-format', 'mp4',
            '-o', outFile, '--no-playlist', '--max-filesize', '16M', urlLimpia
        ], { timeout: 120000 })
    } catch (e) {
        throw new Error(`No pude descargar ese ${plataforma}. Puede ser privado, haber caído o pesar demasiado.`)
    }
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1000) throw new Error('No se pudo descargar el video')
    const buffer = fs.readFileSync(outFile)
    try { fs.unlinkSync(outFile) } catch (_) {}
    if (buffer.length > 16 * 1024 * 1024) throw new Error('El video pesa más de 16MB.')
    return { buffer, mimetype: 'video/mp4', fileName: `${plataforma}.mp4` }
}


async function descargarSpotifyComoAudio(query) {
    let q = String(query || '').trim()
    if (/open\.spotify\.com/i.test(q)) {
        try {
            const r = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(q.split('?')[0]), { signal: AbortSignal.timeout(8000) })
            const j = await r.json()
            if (j && j.title) q = String(j.title)
        } catch (_) {
            q = q.replace(/https?:\/\/\S+/g, ' ').replace(/open\.spotify\.com/gi, ' ').trim() || q
        }
    }
    return descargarMediaYoutube(q, 'audio')
}

async function descargarMediafire(url) {
    const urlLimpia = String(url || '').trim()
    if (!/^https?:\/\//i.test(urlLimpia) || !/mediafire\.com/i.test(urlLimpia)) throw new Error('Mandá un link de MediaFire.')
    const id = crypto.randomBytes(6).toString('hex')
    const outFile = path.join(os.tmpdir(), `mf-${id}`)
    await execFileAsync('yt-dlp', ['-o', outFile, '--no-playlist', '--max-filesize', '20M', urlLimpia], { timeout: 120000 })
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 100) throw new Error('No se pudo bajar (peso o link).')
    const buffer = fs.readFileSync(outFile)
    try { fs.unlinkSync(outFile) } catch (_) {}
    if (buffer.length > 20 * 1024 * 1024) throw new Error('El archivo pesa más de 20MB.')
    const head = buffer.slice(0, 4).toString('hex')
    if (head === '4d5a9000' || head.startsWith('4d5a')) throw new Error('Ese tipo de archivo no se envía.')
    return { buffer, mimetype: 'application/octet-stream', fileName: 'archivo.bin' }
}

function armarMensajeCitado(m) {
    const contextInfo = m.message?.extendedTextMessage?.contextInfo
    const quotedMessage = contextInfo?.quotedMessage
    if (!quotedMessage) return null
    return {
        key: {
            remoteJid: m.key.remoteJid,
            fromMe: false,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant
        },
        message: quotedMessage
    }
}

// ========== ECONOMÍA ==========
const ECONOMIA_FILE = './economia.json'
let economia = {}

function cargarEconomia() {
    try {
        if (fs.existsSync(ECONOMIA_FILE)) {
            economia = JSON.parse(fs.readFileSync(ECONOMIA_FILE, 'utf8'))
        }
    } catch (e) {
        // economia.json quedó corrupto (ej. corte de luz en Termux a mitad de escritura).
        // Antes esto reseteaba a TODOS los jugadores a cero en silencio. Ahora se intenta
        // restaurar del backup automático más reciente antes de rendirse.
        console.log('[WOLFRIC] economia.json corrupto:', e.message || e)
        economia = {}
        try {
            const dir = path.join(process.cwd(), 'backups')
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir).filter(f => f.startsWith('economia_')).sort()
                const ultimo = files[files.length - 1]
                if (ultimo) {
                    economia = JSON.parse(fs.readFileSync(path.join(dir, ultimo), 'utf8'))
                    console.log('[WOLFRIC] Economía restaurada desde backup:', ultimo)
                }
            }
        } catch (e2) {
            console.log('[WOLFRIC] No se pudo restaurar backup de economía:', e2.message || e2)
            economia = {}
        }
    }
}

function guardarEconomia() {
    try {
        const tmp = ECONOMIA_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(economia, null, 2))
        fs.renameSync(tmp, ECONOMIA_FILE)
    } catch (e) {
        console.log('Error guardando economía:', e)
    }
}

// Normaliza un jid a una clave estable "numero@dominio" (sin sufijo :dispositivo).
// Sin esto, el mismo usuario puede terminar con dos entradas de economía distintas
// (una para @s.whatsapp.net y otra con sufijo :XX), y las recompensas de duelo se
// guardan en una entrada "fantasma" que .stats nunca vuelve a leer.
function claveEconomia(jidCrudo) {
    if (!jidCrudo) return jidCrudo
    const [usuario, dominio] = jidCrudo.split('@')
    const numero = (usuario || '').split(':')[0]
    return `${numero}@${dominio || 's.whatsapp.net'}`
}

function getUsuario(jidCrudo) {
    const jid = claveEconomia(jidCrudo)
    if (!economia[jid]) {
        economia[jid] = {
            coins: 100, lastDaily: 0, lastWork: 0, lastRob: 0, inventory: [],
            hp: 100, maxHp: 100, energy: 100, maxEnergy: 100,
            level: 1, exp: 0, statPoints: 0,
            stats: { str: 10, def: 10, agi: 10, int: 10 },
            fruit: null, gachaPity: 0, lastFruitFree: 0,
            wins: 0, tradesCompleted: 0, fruitGachaSpent: 0, lifetimeCoinsEarned: 0, totalGifted: 0,
            titles: [], equippedTitle: null, guild: null,
            gems: 0, fruitAwakened: false,
            estilosComprados: [], estiloEquipado: null,
            contadorHabilidades: {}, frutasObtenidas: [], obtuvoSecreta: false,
            comandosUsados: 0, primeraInteraccion: Date.now(),
            ganoDueloRapido: false, ganoDueloSinDaño: false, fueAdminConNivel50: false, hizoTraicionGremio: false,
            bounty: 100, monstruosCazados: 0,
            guardiasRobo: 0, rachaActual: 0, rachaMejor: 0,
            rachaDiaria: 0, rachaDiariaMejor: 0, hitosRachaReclamados: [],
            mazmorrasCompletadas: 0, victorias2v2: 0, ganoRuletaMitica: false, girosRuletaGratis: 0,
            partidas2v2Jugadas: 0, eventoAmigoProgreso: 0, eventoAmigoReclamado: false,
            registrado: false, derrotas: 0,
            marActual: null, islaActual: null, lastExplorar: 0, lastVueltaTierra: Date.now(),
            debuffExpedicionStat: null, debuffExpedicionExpira: 0,
            buffExploracionRestante: 0, buffFortunaRestante: 0, buffFortunaPct: 0,
            krakensVencidos: 0, vecesVolvioTierra: 0, sobrevivioCritico: false, itemsCurativosUsados: 0,
            misionesDiarias: null, misionesDiariasAsignadas: 0, misionesSemanales: null, misionesSemanalesAsignadas: 0,
            haViajado: false, explorarUsos: 0, logrosDesbloqueados: [],
            frontier: {
                alias: null, rango: 'E', regionActual: 'arca-inicial',
                regionesDescubiertas: ['arca-inicial'], pistas: [],
                escenariosUnicos: [], guardianesDerrotados: [],
                materiales: {}, armasPoseidas: ['punos_novato'], armaEquipada: 'punos_novato',
                artesDesbloqueadas: ['corte_basico'], artesEquipadas: ['corte_basico'],
                reputacion: {}, encuentrosDescubiertos: [], recompensasUnicas: [], decisionesUnicas: [],
                tutorial: { estado: 'pendiente', ruta: null, pasos: [], recompensaReclamada: false, creadoEn: null }
            }
        }
    }
    // Migración: si un usuario viejo no tiene estos campos, se les agregamos
    const u = economia[jid]
    if (u.gems === undefined) u.gems = 0
    if (u.fruitAwakened === undefined) u.fruitAwakened = false
    if (!u.estilosComprados) u.estilosComprados = []
    if (u.estiloEquipado === undefined) u.estiloEquipado = null
    if (!u.contadorHabilidades) u.contadorHabilidades = {}
    if (!u.frutasObtenidas) u.frutasObtenidas = []
    if (u.obtuvoSecreta === undefined) u.obtuvoSecreta = false
    if (u.comandosUsados === undefined) u.comandosUsados = 0
    if (u.primeraInteraccion === undefined) u.primeraInteraccion = Date.now()
    if (u.ganoDueloRapido === undefined) u.ganoDueloRapido = false
    if (u.ganoDueloSinDaño === undefined) u.ganoDueloSinDaño = false
    if (u.fueAdminConNivel50 === undefined) u.fueAdminConNivel50 = false
    if (u.hizoTraicionGremio === undefined) u.hizoTraicionGremio = false
    if (u.lastRob === undefined) u.lastRob = 0
    if (u.hp === undefined) u.hp = 100
    if (u.maxHp === undefined) u.maxHp = 100
    if (u.energy === undefined) u.energy = 100
    if (u.maxEnergy === undefined) u.maxEnergy = 100
    if (u.level === undefined) u.level = 1
    if (u.exp === undefined) u.exp = 0
    if (u.statPoints === undefined) u.statPoints = 0
    if (!u.stats) u.stats = { str: 10, def: 10, agi: 10, int: 10 }
    if (u.fruit === undefined) u.fruit = null
    if (u.gachaPity === undefined) u.gachaPity = 0
    if (u.lastFruitFree === undefined) u.lastFruitFree = 0
    if (u.wins === undefined) u.wins = 0
    if (u.tradesCompleted === undefined) u.tradesCompleted = 0
    if (u.fruitGachaSpent === undefined) u.fruitGachaSpent = 0
    if (u.lifetimeCoinsEarned === undefined) u.lifetimeCoinsEarned = 0
    if (u.totalGifted === undefined) u.totalGifted = 0
    if (!u.titles) u.titles = []
    if (u.equippedTitle === undefined) u.equippedTitle = null
    if (u.guild === undefined) u.guild = null
    // Migración al sistema de EQUIPAMIENTO DE FRUTAS (varias frutas poseídas, se elige cuál llevar equipada)
    if (!u.frutasPoseidas) {
        u.frutasPoseidas = []
        if (u.fruit) u.frutasPoseidas.push({ nombre: u.fruit.nombre, categoria: u.fruit.categoria, despertada: !!u.fruitAwakened })
        u.fruitEquipada = u.fruit ? u.fruit.nombre : null
    }
    if (u.fruitEquipada === undefined) u.fruitEquipada = null
    if (u.bounty === undefined) u.bounty = 100 // recompensa base: sube al matar/ganar/conseguir cosas de valor
    if (u.monstruosCazados === undefined) u.monstruosCazados = 0
    if (u.guardiasRobo === undefined) u.guardiasRobo = 0
    if (u.rachaActual === undefined) u.rachaActual = 0
    if (u.rachaMejor === undefined) u.rachaMejor = 0
    if (u.rachaDiaria === undefined) u.rachaDiaria = 0
    if (u.rachaDiariaMejor === undefined) u.rachaDiariaMejor = 0
    if (!u.hitosRachaReclamados) u.hitosRachaReclamados = []
    if (u.mazmorrasCompletadas === undefined) u.mazmorrasCompletadas = 0
    if (u.victorias2v2 === undefined) u.victorias2v2 = 0
    if (u.ganoRuletaMitica === undefined) u.ganoRuletaMitica = false
    if (u.girosRuletaGratis === undefined) u.girosRuletaGratis = 0
    if (u.registrado === undefined) u.registrado = false
    if (u.derrotas === undefined) u.derrotas = 0
    if (u.marActual === undefined) u.marActual = null
    if (u.islaActual === undefined) u.islaActual = null
    if (u.lastExplorar === undefined) u.lastExplorar = 0
    if (u.lastVueltaTierra === undefined) u.lastVueltaTierra = Date.now()
    if (u.debuffExpedicionStat === undefined) u.debuffExpedicionStat = null
    if (u.debuffExpedicionExpira === undefined) u.debuffExpedicionExpira = 0
    if (u.buffExploracionRestante === undefined) u.buffExploracionRestante = 0
    if (u.buffFortunaRestante === undefined) u.buffFortunaRestante = 0
    if (u.buffFortunaPct === undefined) u.buffFortunaPct = 0
    if (u.krakensVencidos === undefined) u.krakensVencidos = 0
    if (u.vecesVolvioTierra === undefined) u.vecesVolvioTierra = 0
    if (u.sobrevivioCritico === undefined) u.sobrevivioCritico = false
    if (u.itemsCurativosUsados === undefined) u.itemsCurativosUsados = 0
    if (u.misionesDiariasAsignadas === undefined) u.misionesDiariasAsignadas = 0
    if (u.misionesSemanalesAsignadas === undefined) u.misionesSemanalesAsignadas = 0
    if (u.haViajado === undefined) u.haViajado = false
    if (u.explorarUsos === undefined) u.explorarUsos = 0
    if (!u.logrosDesbloqueados) u.logrosDesbloqueados = []
    if (!u.frontier) u.frontier = {}
    if (u.frontier.alias === undefined) u.frontier.alias = null
    if (u.frontier.rango === undefined) u.frontier.rango = 'E'
    if (u.frontier.regionActual === undefined) u.frontier.regionActual = 'arca-inicial'
    if (!Array.isArray(u.frontier.regionesDescubiertas) || !u.frontier.regionesDescubiertas.length) u.frontier.regionesDescubiertas = ['arca-inicial']
    if (!Array.isArray(u.frontier.pistas)) u.frontier.pistas = []
    if (!Array.isArray(u.frontier.escenariosUnicos)) u.frontier.escenariosUnicos = []
    if (!Array.isArray(u.frontier.guardianesDerrotados)) u.frontier.guardianesDerrotados = []
    if (!u.frontier.materiales) u.frontier.materiales = {}
    if (!Array.isArray(u.frontier.armasPoseidas) || !u.frontier.armasPoseidas.length) u.frontier.armasPoseidas = ['punos_novato']
    if (!u.frontier.armaEquipada) u.frontier.armaEquipada = 'punos_novato'
    if (!Array.isArray(u.frontier.artesDesbloqueadas) || !u.frontier.artesDesbloqueadas.length) u.frontier.artesDesbloqueadas = ['corte_basico']
    if (!Array.isArray(u.frontier.artesEquipadas) || !u.frontier.artesEquipadas.length) u.frontier.artesEquipadas = ['corte_basico']
    if (!u.frontier.reputacion) u.frontier.reputacion = {}
    if (!Array.isArray(u.frontier.encuentrosDescubiertos)) u.frontier.encuentrosDescubiertos = []
    if (!Array.isArray(u.frontier.recompensasUnicas)) u.frontier.recompensasUnicas = []
    if (!Array.isArray(u.frontier.decisionesUnicas)) u.frontier.decisionesUnicas = []
    if (!u.frontier.tutorial || typeof u.frontier.tutorial !== 'object') u.frontier.tutorial = { estado: 'pendiente', ruta: null, pasos: [], recompensaReclamada: false, creadoEn: null }
    if (u.partidas2v2Jugadas === undefined) u.partidas2v2Jugadas = 0
    if (u.eventoAmigoProgreso === undefined) u.eventoAmigoProgreso = 0
    if (u.eventoAmigoReclamado === undefined) u.eventoAmigoReclamado = false
    if (u.idioma !== 'es' && u.idioma !== 'pt') u.idioma = null
    return u
}

// ---- Helpers del sistema de equipamiento de frutas ----
function frutaPoseida(user, nombre) {
    return user.frutasPoseidas.find(f => f.nombre.toLowerCase() === (nombre || '').toLowerCase())
}
function frutaEquipadaObj(user) {
    if (!user.fruitEquipada) return null
    return frutaPoseida(user, user.fruitEquipada)
}
// Agrega una fruta a la colección del jugador (si no la tenía) y la auto-equipa si no tenía ninguna equipada
function otorgarFruta(user, nombre, categoria) {
    let f = frutaPoseida(user, nombre)
    if (!f) {
        f = { nombre, categoria, despertada: false }
        user.frutasPoseidas.push(f)
    }
    if (!user.fruitEquipada) user.fruitEquipada = f.nombre
    return f
}

const TIENDA = [
    { id: 1, nombre: '🎩 Sombrero VIP', precio: 200 },
    { id: 2, nombre: '🏅 Insignia especial', precio: 350 },
    { id: 3, nombre: '👑 Título de Leyenda', precio: 500 },
    { id: 4, nombre: '🎴 Ticket de Gacha extra', precio: 150 }
]

// ========== ÍTEMS CONSUMIBLES (GDD V4.0 §3.2) ==========
// tipo -> qué hace .usar con el ítem:
//   curar: cura HP fuera o dentro de combate
//   energia: restaura ⚡
//   buff_critico: el próximo .attack tiene 100% de probabilidad de ser crítico
//   buff_escudo: bloquea el 50% del daño del próximo golpe recibido
//   ticket_gacha: tirada de gacha de frutas gratis
//   reset_stats: reasigna los puntos de STR/DEF/AGI/INT ya gastados
//   boss_tracker: sube temporalmente la probabilidad de spawn de Boss
const ITEMS_CONSUMIBLES = [
    { id: 1, nombre: 'Poción Neón Pequeña', precio: 150, tipo: 'curar', valor: 25, desc: 'Cura 25 HP al instante.' },
    { id: 2, nombre: 'Poción Neón Grande', precio: 400, tipo: 'curar', valor: 60, desc: 'Cura 60 HP al instante.' },
    { id: 3, nombre: 'Batería de Iones', precio: 250, tipo: 'energia', valor: 40, desc: 'Restaura 40⚡ de energía.' },
    { id: 4, nombre: 'Inyector de Adrenalina', precio: 500, tipo: 'buff_critico', desc: 'Tu próximo .attack es crítico garantizado.' },
    { id: 5, nombre: 'Escudo de Datos', precio: 450, tipo: 'buff_escudo', valor: 0.5, desc: 'Bloquea el 50% del próximo golpe que recibas.' },
    { id: 6, nombre: 'Ticket de Gacha', precio: 400, tipo: 'ticket_gacha', desc: 'Tirada barata. Peores chances. Duplicado solo reembolsa $150-$200 (no da ganancia).' },
    { id: 7, nombre: 'Píldora de Amnesia', precio: 1500, tipo: 'reset_stats', desc: 'Resetea tus puntos de STR/DEF/AGI/INT para repartirlos de nuevo.' },
    { id: 8, nombre: 'Rastreador de Jefes', precioGemas: 25000, tipo: 'boss_tracker', valor: 15, duracionMs: 60 * 60 * 1000, desc: '+15% de probabilidad de que aparezca un Boss durante 1 hora.' },
    { id: 9, nombre: 'Guardia de Seguridad', precio: 800, tipo: 'guardia', valor: 5, desc: 'Te protege de los próximos 5 intentos de robo.' },
    { id: 10, nombre: 'Poción de Suerte', precio: 600, tipo: 'buff_crit_temp', valor: 0.15, turnos: 2, desc: '+15% de probabilidad de crítico por 2 turnos en combate.' },
    { id: 11, nombre: 'Brújula Certera', precio: 700, tipo: 'buff_exploracion', valor: 3, desc: 'Tus próximas 3 exploraciones evitan los eventos negativos.' },
    { id: 12, nombre: 'Kit de Primeros Auxilios', precio: 900, tipo: 'curar_total', desc: 'Te cura toda la HP al instante (dentro o fuera de combate).' },
    { id: 13, nombre: 'Antídoto Universal', precio: 550, tipo: 'antidoto', desc: 'Limpia todos los estados negativos activos al instante.' },
    { id: 14, nombre: 'Elixir de Fortuna', precio: 1000, tipo: 'buff_fortuna', valor: 0.25, usos: 5, desc: '+25% de monedas en tus próximas 5 exploraciones o cacerías.' }
]

// ========== SISTEMA DE FRUTAS (GACHA WOLFRIC PROTOCOL) ==========
const COSTO_GACHA_FRUTA = 1000
const FRUTAS = {
    comun: { nombres: ['Humo', 'Bomba', 'Goma', 'Arena', 'Cristal', 'Metal', 'Viento', 'Amigo', 'Papel', 'Madera', 'Imán', 'Vapor'], min: 1, max: 500, dupCoins: 500 },
    rara: { nombres: ['Hielo', 'Magma', 'Veneno', 'Luz', 'Rayo', 'Sombra', 'Coral', 'Hueso', 'Tinta', 'Cuarzo', 'Óxido', 'Deuda', 'Espejismo', 'Apuesta', 'Trueque'], min: 501, max: 800, dupCoins: 500 },
    epica: { nombres: ['Gravedad', 'Terremoto', 'Neón', 'Plasma', 'Sonido', 'Espejo', 'Nova', 'Marea', 'Eco', 'Cadena', 'Balanza', 'Grieta', 'Bucle'], min: 801, max: 950, dupRuletaGratis: true },
    mitica: { nombres: ['Oscuridad', 'Mammoth', 'Kitsune', 'Bigfoot', 'Control', 'Dolor', 'Sangre', 'Cometa', 'Abismo', 'Fantasma', 'Simbiosis', 'Sacrificio'], min: 951, max: 999, tradeable: true, dupCoins: 1500 },
    divina: { nombres: ['Tiempo', 'Caos', 'Infinito', 'Fénix', 'Copia Copia'], min: 1000, max: 1000, global: true, dupCoins: 1500 }
}

// ========== HABILIDADES DE FRUTAS (GDD V4.0 §2) ==========
// Cada fruta tiene una Habilidad 1 (desbloqueada desde el inicio, .useskill / .habilidad)
// y una Habilidad Ultimate (bloqueada hasta que el jugador "despierta" la fruta con .despertar, .ultimate)
// tipo de efecto -> cómo lo interpreta resolverEfecto() en el motor de combate:
//   dmg_mult: multiplicador sobre el daño base de la habilidad
//   debuff_agi / debuff_def: reduce el stat del objetivo (pct 0-1) un número de turnos
//   set_def_zero / set_agi_zero: pone el stat a 0 un número de turnos
//   dot: daño en el tiempo (pct del maxHp o flat) durante N turnos (veneno/quemadura)
//   aturde: el objetivo pierde su próximo turno
//   lifesteal_pct: el atacante cura un % del daño hecho
//   roba_energia_pct: roba % de la energía actual del objetivo
//   cura_flat: cura HP al usuario
//   limpia_estados: quita dots/debuffs propios
//   ignora_def_pct: ignora un % de la defensa del rival SOLO en este golpe
//   nunca_falla: el golpe no puede ser esquivado
//   crit_asegurado: el golpe siempre es crítico
//   ko_chance: probabilidad (0-1) de derrota instantánea
//   extra_turno: el atacante vuelve a jugar, el rival pierde su turno
//   buff_agi_evasion: sube la esquiva propia un tramo fijo (pct) N turnos
//   x2_fisico: duplica el daño de .attack propio N turnos
//   inmune_aturdir: inmune a aturdimiento/congelación N turnos
//   revive_pasiva: si cae a 0 HP, revive una vez con 50% HP/EN (se consume al activarse)
//   reflejo: si el rival ataca físicamente en su próximo turno, recibe el daño reflejado
//   anula_ultimo_ataque: se cura el último daño recibido
const HABILIDADES_FRUTA = {
    'Humo':      { habilidad1: { nombre: 'Cegador', costo: 15, poder: 10, efectos: [{ tipo: 'debuff_agi', pct: 0.30, turnos: 2 }] },
                   ultimate:   { nombre: 'Tornado de Humo', costoDespertar: 500, costo: 30, poder: 5, efectos: [{ tipo: 'dot', pctMaxHp: 0.06, turnos: 3, nombreEstado: 'Asfixia' }] } },
    'Bomba':     { habilidad1: { nombre: 'Mina', costo: 20, poder: 12, efectos: [{ tipo: 'reflejo', turnos: 1 }] },
                   ultimate:   { nombre: 'Auto-Destrucción', costoDespertar: 500, costo: 50, poder: 80, efectos: [{ tipo: 'auto_ko' }] } },
    'Goma':      { habilidad1: { nombre: 'Rebote Elástico', costo: 15, poder: 14, efectos: [{ tipo: 'debuff_def', pct: 0.15, turnos: 1, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Golpe de Mil Manos', costoDespertar: 500, costo: 30, poder: 30, efectos: [{ tipo: 'dmg_mult', mult: 1.4 }] } },
    'Arena':     { habilidad1: { nombre: 'Tormenta de Arena', costo: 15, poder: 10, efectos: [{ tipo: 'debuff_agi', pct: 0.20, turnos: 2 }] },
                   ultimate:   { nombre: 'Desierto Eterno', costoDespertar: 500, costo: 30, poder: 5, efectos: [{ tipo: 'dot', pctMaxHp: 0.05, turnos: 3, nombreEstado: 'Deshidratación' }] } },
    'Hielo':     { habilidad1: { nombre: 'Pinchos', costo: 25, poder: 22, efectos: [{ tipo: 'debuff_def', pct: 0.20, turnos: 1 }] },
                   ultimate:   { nombre: 'Cero Absoluto', costoDespertar: 1000, costo: 45, poder: 28, efectos: [{ tipo: 'aturde', turnos: 1, nombreEstado: 'Congelado' }] } },
    'Magma':     { habilidad1: { nombre: 'Puño de Lava', costo: 25, poder: 26, efectos: [{ tipo: 'ignora_def_pct', pct: 0.30 }] },
                   ultimate:   { nombre: 'Lluvia de Meteoros', costoDespertar: 1000, costo: 50, poder: 40, efectos: [{ tipo: 'ignora_def_pct', pct: 0.50 }] } },
    'Luz':       { habilidad1: { nombre: 'Rayo Neón', costo: 20, poder: 20, efectos: [{ tipo: 'nunca_falla' }] },
                   ultimate:   { nombre: 'Destello', costoDespertar: 1000, costo: 40, poder: 24, efectos: [{ tipo: 'roba_energia_pct', pct: 0.50 }] } },
    'Veneno':    { habilidad1: { nombre: 'Nube Tóxica', costo: 20, poder: 8, efectos: [{ tipo: 'dot', pctMaxHp: 0.05, turnos: 3, nombreEstado: 'Envenenado' }] } ,
                   ultimate:   { nombre: 'Plaga', costoDespertar: 1000, costo: 40, poder: 10, efectos: [{ tipo: 'set_def_zero', turnos: 2 }, { tipo: 'dot', pctMaxHp: 0.08, turnos: 2, nombreEstado: 'Plaga' }] } },
    'Gravedad':  { habilidad1: { nombre: 'Aplastamiento', costo: 30, poder: 0, efectos: [{ tipo: 'dmg_pct_def_max_rival', pct: 0.20 }] },
                   ultimate:   { nombre: 'Meteoro', costoDespertar: 3000, costo: 50, poder: 30, efectos: [{ tipo: 'crit_asegurado' }, { tipo: 'aturde', turnos: 1 }] } },
    'Terremoto': { habilidad1: { nombre: 'Temblor', costo: 30, poder: 24, efectos: [{ tipo: 'aturde_chance', prob: 0.30, turnos: 1 }] },
                   ultimate:   { nombre: 'Falla Tectónica', costoDespertar: 3000, costo: 55, poder: 42, efectos: [{ tipo: 'set_agi_zero', turnos: 2 }] } },
    'Neón':      { habilidad1: { nombre: 'Pulso Neón', costo: 20, poder: 20, efectos: [{ tipo: 'nunca_falla' }] },
                   ultimate:   { nombre: 'Sobrecarga', costoDespertar: 1000, costo: 45, poder: 34, efectos: [{ tipo: 'aturde', turnos: 1 }] } },
    'Oscuridad': { habilidad1: { nombre: 'Agujero Negro', costo: 35, poder: 20, efectos: [{ tipo: 'lifesteal_pct', pct: 1.0 }] },
                   ultimate:   { nombre: 'Protocolo Abisal', costoDespertar: 3000, costo: 50, poder: 36, efectos: [{ tipo: 'ko_chance', prob: 0.15 }, { tipo: 'roba_energia_pct', pct: 0.20 }] } },
    'Mammoth':   { habilidad1: { nombre: 'Estampida', costo: 30, poder: 28, efectos: [{ tipo: 'ignora_def_pct', pct: 1.0 }, { tipo: 'aturde', turnos: 1 }] },
                   ultimate:   { nombre: 'Furia Primitiva', costoDespertar: 3000, costo: 50, poder: 20, efectos: [{ tipo: 'x2_fisico', turnos: 3 }, { tipo: 'inmune_aturdir', turnos: 3, autoObjetivo: true }] } },
    'Kitsune':   { habilidad1: { nombre: 'Fuego Azul', costo: 35, poder: 14, efectos: [{ tipo: 'dot', pctMaxHp: 0.05, turnos: 3, nombreEstado: 'Quemadura' }] },
                   ultimate:   { nombre: 'Transformación', costoDespertar: 3000, costo: 50, poder: 0, efectos: [{ tipo: 'buff_agi_evasion', pct: 0.75, turnos: 3, autoObjetivo: true }] } },
    'Fénix':     { habilidad1: { nombre: 'Llamas Curativas', costo: 25, poder: 0, efectos: [{ tipo: 'cura_flat', valor: 30, autoObjetivo: true }, { tipo: 'limpia_estados', autoObjetivo: true }] },
                   ultimate:   { nombre: 'Resurrección', costoDespertar: 3000, costo: 60, poder: 0, efectos: [{ tipo: 'revive_pasiva', autoObjetivo: true }] } },
    'Tiempo':    { habilidad1: { nombre: 'Dilatación', costo: 40, poder: 5, efectos: [{ tipo: 'extra_turno' }] },
                   ultimate:   { nombre: 'Paradoja Temporal', costoDespertar: 3000, costo: 70, poder: 0, efectos: [{ tipo: 'anula_ultimo_ataque', autoObjetivo: true }] } },

    // ========== +15 FRUTAS NUEVAS (actualización de mazmorras/bounty) ==========
    // -- Comunes --
    'Cristal':   { habilidad1: { nombre: 'Esquirlas', costo: 15, poder: 14, efectos: [{ tipo: 'debuff_def', pct: 0.15, turnos: 2 }] },
                   ultimate:   { nombre: 'Prisma Fragmentado', costoDespertar: 500, costo: 30, poder: 20, efectos: [{ tipo: 'dmg_mult', mult: 1.3 }, { tipo: 'ignora_def_pct', pct: 0.25 }] } },
    'Metal':     { habilidad1: { nombre: 'Blindaje Rápido', costo: 15, poder: 8, efectos: [{ tipo: 'buff_def_self', pct: 0.20, turnos: 2, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Coraza de Titanio', costoDespertar: 500, costo: 30, poder: 0, efectos: [{ tipo: 'buff_def_self', pct: 0.50, turnos: 3, autoObjetivo: true }, { tipo: 'cura_flat', valor: 15, autoObjetivo: true }] } },
    'Viento':    { habilidad1: { nombre: 'Ráfaga', costo: 15, poder: 14, efectos: [{ tipo: 'debuff_agi', pct: 0.25, turnos: 2 }] },
                   ultimate:   { nombre: 'Ciclón', costoDespertar: 500, costo: 30, poder: 20, efectos: [{ tipo: 'extra_turno' }] } },

    // -- Raras --
    'Rayo':      { habilidad1: { nombre: 'Descarga', costo: 20, poder: 18, efectos: [{ tipo: 'aturde_chance', prob: 0.20, turnos: 1 }] },
                   ultimate:   { nombre: 'Tormenta Eléctrica', costoDespertar: 1000, costo: 45, poder: 32, efectos: [{ tipo: 'aturde', turnos: 1 }] } },
    'Sombra':    { habilidad1: { nombre: 'Ocultarse', costo: 20, poder: 12, efectos: [{ tipo: 'buff_agi_evasion', pct: 0.30, turnos: 2, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Asesinato desde las Sombras', costoDespertar: 1000, costo: 40, poder: 26, efectos: [{ tipo: 'crit_asegurado' }, { tipo: 'ignora_def_pct', pct: 0.40 }] } },
    'Coral':     { habilidad1: { nombre: 'Abrazo Coralino', costo: 20, poder: 16, efectos: [{ tipo: 'dot', pctMaxHp: 0.04, turnos: 2, nombreEstado: 'Toxina Coralina' }] },
                   ultimate:   { nombre: 'Arrecife Vital', costoDespertar: 1000, costo: 40, poder: 0, efectos: [{ tipo: 'cura_flat', valor: 40, autoObjetivo: true }, { tipo: 'limpia_estados', autoObjetivo: true }] } },

    // -- Épicas --
    'Plasma':    { habilidad1: { nombre: 'Chorro de Plasma', costo: 25, poder: 24, efectos: [{ tipo: 'ignora_def_pct', pct: 0.20 }] },
                   ultimate:   { nombre: 'Núcleo de Plasma', costoDespertar: 1000, costo: 48, poder: 34, efectos: [{ tipo: 'dot', pctMaxHp: 0.06, turnos: 3, nombreEstado: 'Quemadura de Plasma' }] } },
    'Sonido':    { habilidad1: { nombre: 'Onda Sónica', costo: 25, poder: 16, efectos: [{ tipo: 'debuff_dmg_flat', valor: 8, turnos: 2 }] },
                   ultimate:   { nombre: 'Grito Devastador', costoDespertar: 3000, costo: 45, poder: 26, efectos: [{ tipo: 'aturde', turnos: 1 }] } },
    'Espejo':    { habilidad1: { nombre: 'Reflejo', costo: 25, poder: 10, efectos: [{ tipo: 'reflejo_dano_prob', prob: 0.30, pct: 0.25, turnos: 2, soloFisico: false, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Espejo Roto', costoDespertar: 3000, costo: 45, poder: 0, efectos: [{ tipo: 'anula_ultimo_ataque', autoObjetivo: true }, { tipo: 'reflejo_dano_prob', prob: 0.50, pct: 0.40, turnos: 2, soloFisico: false, autoObjetivo: true }] } },

    // -- Míticas --
    'Bigfoot':   { habilidad1: { nombre: 'Transformación Sasquatch', costo: 30, poder: 10, efectos: [{ tipo: 'transformar', prob: 0.50, curar: 10, dmgBonusPct: 0.15, defBonusPct: 0.05, nombreEstado: 'Sasquatch', autoObjetivo: true }] },
                   ultimate:   { nombre: 'Rey Bigfoot', costoDespertar: 3000, costo: 50, poder: 10, efectos: [{ tipo: 'transformar', prob: 1, curar: 20, dmgBonusPct: 0.20, defBonusPct: 0.10, nombreEstado: 'Rey Bigfoot', autoObjetivo: true }] } },
    'Control':   { habilidad1: { nombre: 'Manipulación', costo: 25, poder: 12, efectos: [{ tipo: 'control_aleatorio' }] },
                   ultimate:   { nombre: 'Control Absoluto', costoDespertar: 3000, costo: 45, poder: 10, efectos: [] /* se arma dinámicamente según el modo elegido */ } },
    'Dolor':     { habilidad1: { nombre: 'Coraza de Dolor', costo: 25, poder: 10, efectos: [{ tipo: 'buff_def_self', pct: 0.40, turnos: 3, autoObjetivo: true }, { tipo: 'reflejo_dano_prob', prob: 0.20, pct: 0.20, turnos: 3, soloFisico: false, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Umbral del Dolor', costoDespertar: 3000, costo: 50, poder: 10, efectos: [{ tipo: 'buff_def_self', pct: 1.0, turnos: 2, autoObjetivo: true }, { tipo: 'reflejo_dano_prob', prob: 0.30, pct: 0.30, turnos: 2, soloFisico: true, autoObjetivo: true }] } },
    'Sangre':    { habilidad1: { nombre: 'Sed de Sangre', costo: 30, poder: 18, efectos: [{ tipo: 'lifesteal_pct', pct: 0.6, prob: 0.55 }] },
                   ultimate:   { nombre: 'Festín Carmesí', costoDespertar: 3000, costo: 50, poder: 32, efectos: [{ tipo: 'lifesteal_pct', pct: 0.9, prob: 0.65 }] } },

    // -- Secretas --
    'Caos':      { habilidad1: { nombre: 'Entropía', costo: 35, poder: 14, efectos: [{ tipo: 'caos_aleatorio' }] },
                   ultimate:   { nombre: 'Big Bang', costoDespertar: 3000, costo: 65, poder: 34, efectos: [{ tipo: 'caos_aleatorio' }] } },
    'Infinito':  { habilidad1: { nombre: 'Fragmento Infinito', costo: 35, poder: 18, efectos: [{ tipo: 'roba_energia_pct', pct: 0.30 }] },
                   ultimate:   { nombre: 'Paradoja Infinita', costoDespertar: 3000, costo: 65, poder: 30, efectos: [{ tipo: 'extra_turno' }, { tipo: 'crit_asegurado' }, { tipo: 'ignora_def_pct', pct: 0.50 }] } },

    // -- Fruta del evento Día del Amigo, ahora integrada como fruta común normal --
    'Amigo':     { habilidad1: { nombre: 'Llamado de Amistad', costo: 20, poder: 10, efectos: [{ tipo: 'invocar_amigo', prob: 0.60, hpBot: 40, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Refuerzos Leales', costoDespertar: 1000, costo: 35, poder: 15, efectos: [{ tipo: 'invocar_amigo', prob: 0.85, hpBot: 60, autoObjetivo: true }] } },

    // ========== +15 FRUTAS NUEVAS (actualización beta) — jugabilidad variada, sin frutas "inútiles" ni sobrecargadas ==========
    // -- Comunes --
    'Papel':     { habilidad1: { nombre: 'Corte de Papel', costo: 15, poder: 14, efectos: [{ tipo: 'debuff_def', pct: 0.10, turnos: 2 }] },
                   ultimate:   { nombre: 'Origami de Guerra', costoDespertar: 500, costo: 30, poder: 20, efectos: [{ tipo: 'dmg_mult', mult: 1.25 }, { tipo: 'buff_agi_evasion', pct: 0.20, turnos: 2, autoObjetivo: true }] } },
    'Madera':    { habilidad1: { nombre: 'Raíces', costo: 15, poder: 8, efectos: [{ tipo: 'buff_def_self', pct: 0.25, turnos: 2, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Bosque Denso', costoDespertar: 500, costo: 30, poder: 0, efectos: [{ tipo: 'buff_def_self', pct: 0.45, turnos: 3, autoObjetivo: true }, { tipo: 'reflejo_dano_prob', prob: 0.15, pct: 0.20, turnos: 3, soloFisico: false, autoObjetivo: true }] } },
    'Imán':      { habilidad1: { nombre: 'Atracción', costo: 15, poder: 14, efectos: [{ tipo: 'roba_energia_pct', pct: 0.25 }] },
                   ultimate:   { nombre: 'Campo Magnético', costoDespertar: 500, costo: 30, poder: 18, efectos: [{ tipo: 'debuff_agi', pct: 0.30, turnos: 2 }, { tipo: 'roba_energia_pct', pct: 0.35 }] } },
    'Vapor':     { habilidad1: { nombre: 'Nube de Vapor', costo: 15, poder: 12, efectos: [{ tipo: 'buff_agi_evasion', pct: 0.15, turnos: 1, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Explosión de Vapor', costoDespertar: 500, costo: 30, poder: 20, efectos: [{ tipo: 'aturde_chance', prob: 0.40, turnos: 1 }] } },

    // -- Raras --
    'Hueso':     { habilidad1: { nombre: 'Golpe Óseo', costo: 20, poder: 20, efectos: [{ tipo: 'ignora_def_pct', pct: 0.15 }] },
                   ultimate:   { nombre: 'Osamenta Eterna', costoDespertar: 1000, costo: 42, poder: 32, efectos: [{ tipo: 'ignora_def_pct', pct: 0.35 }] } },
    'Tinta':     { habilidad1: { nombre: 'Mancha Cegadora', costo: 20, poder: 10, efectos: [{ tipo: 'debuff_agi', pct: 0.30, turnos: 2 }, { tipo: 'debuff_dmg_flat', valor: 6, turnos: 2 }] },
                   ultimate:   { nombre: 'Velo de Tinta', costoDespertar: 1000, costo: 40, poder: 14, efectos: [{ tipo: 'debuff_all_stats', pct: 0.15, turnos: 3 }] } },
    'Cuarzo':    { habilidad1: { nombre: 'Resonancia', costo: 20, poder: 10, efectos: [{ tipo: 'cura_flat', valor: 20, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Sincronía de Cuarzo', costoDespertar: 1000, costo: 40, poder: 0, efectos: [{ tipo: 'cura_flat', valor: 45, autoObjetivo: true }, { tipo: 'limpia_estados', autoObjetivo: true }] } },
    'Óxido':     { habilidad1: { nombre: 'Corrosión', costo: 20, poder: 10, efectos: [{ tipo: 'dot', pctMaxHp: 0.05, turnos: 3, nombreEstado: 'Óxido' }] },
                   ultimate:   { nombre: 'Desintegración', costoDespertar: 1000, costo: 42, poder: 8, efectos: [{ tipo: 'set_def_zero', turnos: 2 }, { tipo: 'dot', pctMaxHp: 0.07, turnos: 3, nombreEstado: 'Corrosión Total' }] } },

    // -- Épicas --
    'Nova':      { habilidad1: { nombre: 'Pulso Estelar', costo: 25, poder: 24, efectos: [{ tipo: 'aturde_chance', prob: 0.25, turnos: 1 }] },
                   ultimate:   { nombre: 'Supernova', costoDespertar: 1000, costo: 48, poder: 36, efectos: [{ tipo: 'debuff_all_stats', pct: 0.20, turnos: 2 }] } },
    'Marea':     { habilidad1: { nombre: 'Oleaje', costo: 25, poder: 18, efectos: [{ tipo: 'debuff_agi', pct: 0.20, turnos: 2 }, { tipo: 'cura_flat', valor: 10, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Tsunami', costoDespertar: 3000, costo: 46, poder: 32, efectos: [{ tipo: 'aturde', turnos: 1 }] } },
    'Eco':       { habilidad1: { nombre: 'Eco de Golpe', costo: 25, poder: 18, efectos: [{ tipo: 'dmg_mult', mult: 1.2 }, { tipo: 'lifesteal_pct', pct: 0.3, prob: 0.5 }] },
                   ultimate:   { nombre: 'Bucle de Eco', costoDespertar: 3000, costo: 46, poder: 24, efectos: [{ tipo: 'extra_turno' }, { tipo: 'dmg_mult', mult: 1.3 }] } },
    'Cadena':    { habilidad1: { nombre: 'Encadenar', costo: 25, poder: 12, efectos: [{ tipo: 'debuff_agi', pct: 0.25, turnos: 2 }, { tipo: 'debuff_def', pct: 0.15, turnos: 2 }] },
                   ultimate:   { nombre: 'Prisión de Cadenas', costoDespertar: 3000, costo: 46, poder: 10, efectos: [{ tipo: 'set_agi_zero', turnos: 2 }, { tipo: 'set_def_zero', turnos: 1 }] } },

    // -- Míticas --
    'Cometa':    { habilidad1: { nombre: 'Impacto de Cometa', costo: 30, poder: 24, efectos: [{ tipo: 'ko_chance', prob: 0.05 }] },
                   ultimate:   { nombre: 'Lluvia de Cometas', costoDespertar: 3000, costo: 50, poder: 34, efectos: [{ tipo: 'ko_chance', prob: 0.12 }, { tipo: 'aturde', turnos: 1 }] } },
    'Abismo':    { habilidad1: { nombre: 'Grieta Abismal', costo: 30, poder: 18, efectos: [{ tipo: 'debuff_dmg_flat', valor: 12, turnos: 2 }, { tipo: 'roba_energia_pct', pct: 0.20 }] },
                   ultimate:   { nombre: 'Corazón del Abismo', costoDespertar: 3000, costo: 50, poder: 10, efectos: [{ tipo: 'set_def_zero', turnos: 2 }, { tipo: 'debuff_all_stats', pct: 0.25, turnos: 2 }] } },
    'Fantasma':  { habilidad1: { nombre: 'Paso Fantasmal', costo: 30, poder: 18, efectos: [{ tipo: 'nunca_falla' }, { tipo: 'buff_agi_evasion', pct: 0.25, turnos: 2, autoObjetivo: true }] },
                   ultimate:   { nombre: 'Posesión', costoDespertar: 3000, costo: 48, poder: 14, efectos: [{ tipo: 'marcar_redirigir' }, { tipo: 'aturde', turnos: 1 }] } },

    // ========== +10 FRUTAS REVOLUCIONARIAS (actualización de mecánicas nuevas) ==========
    'Deuda':        { habilidad1: { nombre: 'Golpe a Crédito', costo: 20, poder: 22, efectos: [{ tipo: 'daño_diferido', mult: 0.6, turnos: 2 }] },
                      ultimate:   { nombre: 'Bancarrota Forzada', costoDespertar: 1000, costo: 42, poder: 34, efectos: [{ tipo: 'daño_diferido', mult: 1.0, turnos: 2 }] } },
    'Espejismo':    { habilidad1: { nombre: 'Doble Fantasma', costo: 20, poder: 12, efectos: [{ tipo: 'decoy_evasion', prob: 0.35, turnos: 2, autoObjetivo: true }] },
                      ultimate:   { nombre: 'Multiplicidad', costoDespertar: 1000, costo: 42, poder: 18, efectos: [{ tipo: 'decoy_evasion', prob: 0.55, turnos: 3, autoObjetivo: true }] } },
    'Apuesta':      { habilidad1: { nombre: 'Cara o Cruz', costo: 20, poder: 20, efectos: [{ tipo: 'doble_o_nada' }] },
                      ultimate:   { nombre: 'Todo al Rojo', costoDespertar: 1000, costo: 40, poder: 26, efectos: [{ tipo: 'doble_o_nada' }, { tipo: 'crit_asegurado' }] } },
    'Trueque':      { habilidad1: { nombre: 'Intercambio Rápido', costo: 20, poder: 14, efectos: [{ tipo: 'intercambiar_stat_aleatorio' }] },
                      ultimate:   { nombre: 'Trueque Total', costoDespertar: 1000, costo: 40, poder: 20, efectos: [{ tipo: 'intercambiar_stat_aleatorio' }, { tipo: 'intercambiar_stat_aleatorio' }] } },
    'Balanza':      { habilidad1: { nombre: 'Punto de Equilibrio', costo: 25, poder: 10, efectos: [{ tipo: 'equilibrar_hp' }] },
                      ultimate:   { nombre: 'Justicia Absoluta', costoDespertar: 1000, costo: 45, poder: 16, efectos: [{ tipo: 'equilibrar_hp' }, { tipo: 'cura_flat', valor: 20, autoObjetivo: true }] } },
    'Grieta':       { habilidad1: { nombre: 'Fractura', costo: 25, poder: 16, efectos: [{ tipo: 'disipar_buff_rival' }] },
                      ultimate:   { nombre: 'Fractura Dimensional', costoDespertar: 3000, costo: 45, poder: 30, efectos: [{ tipo: 'disipar_buff_rival' }, { tipo: 'ignora_def_pct', pct: 0.35 }] } },
    'Bucle':        { habilidad1: { nombre: 'Eco Instantáneo', costo: 25, poder: 16, efectos: [{ tipo: 'repetir_ultimo_daño_propio' }] },
                      ultimate:   { nombre: 'Bucle Infinito', costoDespertar: 3000, costo: 48, poder: 24, efectos: [{ tipo: 'repetir_ultimo_daño_propio' }, { tipo: 'extra_turno' }] } },
    'Simbiosis':    { habilidad1: { nombre: 'Vínculo Parasitario', costo: 30, poder: 10, efectos: [{ tipo: 'parasito', pctMaxHp: 0.06, turnos: 3 }] },
                      ultimate:   { nombre: 'Simbiosis Total', costoDespertar: 3000, costo: 50, poder: 14, efectos: [{ tipo: 'parasito', pctMaxHp: 0.10, turnos: 4 }] } },
    'Sacrificio':   { habilidad1: { nombre: 'Pacto de Sangre', costo: 20, poder: 10, efectos: [{ tipo: 'sacrificar_hp_por_daño', pct: 0.12 }] },
                      ultimate:   { nombre: 'Pacto Definitivo', costoDespertar: 3000, costo: 45, poder: 14, efectos: [{ tipo: 'sacrificar_hp_por_daño', pct: 0.25 }] } },
    'Copia Copia':  { habilidad1: { nombre: 'Reflejo Táctico', costo: 30, poder: 12, efectos: [{ tipo: 'copiar_ultima_habilidad' }] },
                      ultimate:   { nombre: 'Espejo Perfecto', costoDespertar: 3000, costo: 55, poder: 12, efectos: [{ tipo: 'copiar_ultima_habilidad' }, { tipo: 'crit_asegurado' }] } },

    // Frutas exclusivas de owners/devs — NO entran en el gacha
    'Fuego Alfa': { habilidad1: { nombre: 'Colmillo Ígneo', costo: 20, poder: 27, efectos: [
                        { tipo: 'dot', pctMaxHp: 0.05, turnos: 2, nombreEstado: 'Quemadura Alfa', prob: 0.35 },
                        { tipo: 'dano_extra_prob', prob: 0.35, min: 5, max: 10, nombreEstado: 'Colmillo ardiente' }
                    ] },
                    ultimate:   { nombre: 'Eclipse del Alfa', costoDespertar: 1000, costo: 45, poder: 57, efectos: [
                        { tipo: 'dot', pctMaxHp: 0.08, turnos: 3, nombreEstado: 'Eclipse Ígneo', prob: 0.65 },
                        { tipo: 'dano_extra_prob', prob: 0.30, min: 10, max: 20, nombreEstado: 'Marca Alfa' }
                    ] } },
    'THE L':     { habilidad1: { nombre: 'Programación Obstruida', costo: 25, poder: 5, efectos: [
                       { tipo: 'invocar_ejercito_bots', prob: 1, cantidad: 4, hpCadaUno: 50, contraataqueDano: 3, autoObjetivo: true }
                   ] },
                   ultimate:   { nombre: 'Dios de la Programación', costoDespertar: 1000, costo: 45, poder: 1, efectos: [{ tipo: 'intercambio_total' }] } },
    'Vacio':     { habilidad1: { nombre: 'Absorción', costo: 25, poder: 16, efectos: [{ tipo: 'roba_energia_pct', pct: 0.20 }] },
                   ultimate:   { nombre: 'Vacío sin Límites', costoDespertar: 1000, costo: 45, poder: 10, efectos: [] } }
}

// Traduce un efecto de habilidad a una frase corta en español (para no escribir cada descripción a mano)
function describirEfecto(e, lang = 'es') {
    const L = (es, pt, en) => tr(lang, es, pt, en)
    switch (e.tipo) {
        case 'debuff_agi': return L(`Baja la AGI ${e.autoObjetivo ? 'propia' : 'del rival'} ${Math.round(e.pct * 100)}% (${e.turnos} turno${e.turnos > 1 ? 's' : ''})`, `Diminui a AGI ${e.autoObjetivo ? 'própria' : 'do rival'} ${Math.round(e.pct * 100)}% (${e.turnos} turno${e.turnos > 1 ? 's' : ''})`, `Lowers ${e.autoObjetivo ? 'your' : "the rival's"} AGI by ${Math.round(e.pct * 100)}% (${e.turnos} turn${e.turnos > 1 ? 's' : ''})`)
        case 'debuff_def': return L(`Baja la DEF ${e.autoObjetivo ? 'propia' : 'del rival'} ${Math.round(e.pct * 100)}% (${e.turnos} turno${e.turnos > 1 ? 's' : ''})`, `Diminui a DEF ${e.autoObjetivo ? 'própria' : 'do rival'} ${Math.round(e.pct * 100)}% (${e.turnos} turno${e.turnos > 1 ? 's' : ''})`, `Lowers ${e.autoObjetivo ? 'your' : "the rival's"} DEF by ${Math.round(e.pct * 100)}% (${e.turnos} turn${e.turnos > 1 ? 's' : ''})`)
        case 'dot': return e.prob !== undefined ? `${Math.round(e.prob * 100)}% de probabilidad de aplicar ${e.nombreEstado || 'daño continuo'}: ${Math.round(e.pctMaxHp * 100)}% del HP máx. por turno (${e.turnos} turnos)` : `${e.nombreEstado || 'Daño continuo'}: ${Math.round(e.pctMaxHp * 100)}% del HP máx. por turno (${e.turnos} turnos)`
        case 'reflejo': return L(`Refleja el daño si te atacan físicamente el próximo turno`, `Reflete o dano se te atacarem no físico no próximo turno`, `Reflects damage if you get hit physically next turn`)
        case 'auto_ko': return L(`Te deja a 1 HP, pero hace daño masivo al rival`, `Te deixa com 1 HP, mas causa dano enorme no rival`, `Leaves you at 1 HP, but deals massive damage to the rival`)
        case 'dmg_mult': return L(`Multiplica tu daño ×${e.mult}`, `Multiplica seu dano ×${e.mult}`, `Multiplies your damage ×${e.mult}`)
        case 'ignora_def_pct': return L(`Ignora ${Math.round(e.pct * 100)}% de la DEF del rival`, `Ignora ${Math.round(e.pct * 100)}% da DEF do rival`, `Ignores ${Math.round(e.pct * 100)}% of the rival's DEF`)
        case 'nunca_falla': return L(`Nunca falla`, `Nunca erra`, `Never misses`)
        case 'roba_energia_pct': return L(`Roba ${Math.round(e.pct * 100)}% de la energía del rival`, `Rouba ${Math.round(e.pct * 100)}% da energia do rival`, `Steals ${Math.round(e.pct * 100)}% of the rival's energy`)
        case 'set_def_zero': return L(`Reduce la DEF del rival a 0 (${e.turnos} turnos)`, `Reduz a DEF do rival a 0 (${e.turnos} turnos)`, `Sets the rival's DEF to 0 (${e.turnos} turns)`)
        case 'set_agi_zero': return L(`Reduce la AGI del rival a 0 (${e.turnos} turnos)`, `Reduz a AGI do rival a 0 (${e.turnos} turnos)`, `Sets the rival's AGI to 0 (${e.turnos} turns)`)
        case 'dmg_pct_def_max_rival': return L(`Daño = ${Math.round(e.pct * 100)}% de la DEF máxima del rival`, `Dano = ${Math.round(e.pct * 100)}% da DEF máxima do rival`, `Damage = ${Math.round(e.pct * 100)}% of the rival's max DEF`)
        case 'crit_asegurado': return L(`Golpe crítico garantizado`, `Acerto crítico garantido`, `Guaranteed critical hit`)
        case 'aturde': return `Aturde al rival (${e.turnos} turno${e.turnos > 1 ? 's' : ''})`
        case 'aturde_chance': return `${Math.round(e.prob * 100)}% de aturdir al rival (${e.turnos} turno)`
        case 'cura_flat': return L(`Cura ${e.valor} HP`, `Cura ${e.valor} HP`, `Heals ${e.valor} HP`)
        case 'limpia_estados': return L(`Elimina todos tus estados negativos`, `Remove todos os seus estados negativos`, `Clears all your negative statuses`)
        case 'lifesteal_pct': return e.prob !== undefined ? `${Math.round(e.prob * 100)}% de probabilidad de robar ${Math.round(e.pct * 100)}% del daño hecho como HP propia` : `Roba ${Math.round(e.pct * 100)}% del daño hecho como HP propia`
        case 'extra_turno': return L(`Ganas un turno extra inmediato`, `Ganha um turno extra na hora`, `You get an extra turn right now`)
        case 'anula_ultimo_ataque': return L(`Anula el último ataque/ultimate que recibiste`, `Anula o último ataque/ultimate que você tomou`, `Cancels the last attack/ultimate you took`)
        case 'revive_pasiva': return L(`Si caes K.O., revives una vez con 50% de HP y energía`, `Se cair K.O., revive uma vez com 50% de HP e energia`, `If you get K.O., you revive once at 50% HP and energy`)
        case 'inmune_aturdir': return L(`Inmune a aturdimiento/congelación`, `Imune a atordoamento/congelamento`, `Immune to stun/freeze`)
        case 'ko_chance': return `${Math.round((e.prob || 0) * 100)}% de probabilidad de K.O. instantáneo`
        case 'buff_agi_evasion': return `Sube tu esquiva por ${e.turnos || 1} turno(s)`
        case 'x2_fisico': return `Duplica el daño de tus ataques físicos por ${e.turnos || 1} turno(s)`
        case 'transformar': return `${Math.round((e.prob ?? 1) * 100)}% de probabilidad de transformarte: +${e.curar || 0} HP, +${Math.round(e.dmgBonusPct * 100)}% daño, +${Math.round(e.defBonusPct * 100)}% DEF por el resto del duelo`
        case 'buff_def_self': return `+${Math.round(e.pct * 100)}% de DEF propia (${e.turnos} turnos)`
        case 'reflejo_dano_prob': return `${Math.round(e.prob * 100)}% de probabilidad de redirigir ${Math.round(e.pct * 100)}% del daño${e.soloFisico ? ' físico' : ''} recibido (${e.turnos} turnos)`
        case 'debuff_all_stats': return `Baja TODOS los stats del rival ${Math.round(e.pct * 100)}% (${e.turnos} turnos)`
        case 'debuff_dmg_flat': return `El daño del rival baja -${e.valor} (${e.turnos} turnos)`
        case 'marcar_redirigir': return `La próxima habilidad de fruta del rival se vuelve contra sí mismo`
        case 'control_aleatorio': return `Efecto aleatorio: -10 de daño al rival, redirige su habilidad, o -5% a todos sus stats`
        case 'caos_aleatorio': return `Efecto totalmente impredecible: puede beneficiarte enormemente o salir mal`
        case 'invocar_amigo': return `${Math.round(e.prob * 100)}% de probabilidad de invocar un Bot-Amigo con ${e.hpBot} HP que tanquea el daño por vos`
        case 'daño_diferido': return `El golpe suma daño extra, pero te lo cobra a vos mismo/a en ${e.turnos || 2} turnos`
        case 'parasito': return `Adhiere un parásito al rival: le drena ${Math.round(e.pctMaxHp * 100)}% de su HP máx. en SUS propios turnos, por ${e.turnos} turnos, y te la pasa a vos`
        case 'decoy_evasion': return `${Math.round(e.prob * 100)}% de esquiva fija (no depende de AGI) por ${e.turnos} turnos`
        case 'equilibrar_hp': return L(`Acerca la HP de ambos combatientes al punto medio`, `Aproxima o HP dos dois pro ponto médio`, `Pulls both fighters' HP toward the midpoint`)
        case 'disipar_buff_rival': return L(`Elimina todos los efectos positivos activos del rival`, `Remove todos os efeitos positivos ativos do rival`, `Removes all of the rival's active buffs`)
        case 'intercambiar_stat_aleatorio': return L(`Intercambia una estadística al azar con el rival por el resto del duelo`, `Troca uma stat aleatória com o rival pelo resto do duelo`, `Swaps a random stat with the rival for the rest of the duel`)
        case 'copiar_ultima_habilidad': return L(`Repite la última habilidad que usó el rival, pero en su contra`, `Repete a última habilidade do rival, contra ele`, `Repeats the rival's last skill, against them`)
        case 'doble_o_nada': return L(`50% de triplicar el daño, 50% de anularlo y recibirlo vos mismo/a`, `50% de triplicar o dano, 50% de anular e tomar você mesmo`, `50% chance to triple the damage, 50% to cancel it and take it yourself`)
        case 'sacrificar_hp_por_daño': return `Sacrificás ${Math.round((e.pct || 0.15) * 100)}% de tu HP actual para sumarla como daño extra`
        case 'vaciar_energia_total': return `${Math.round(e.prob * 100)}% de probabilidad de dejar al rival sin nada de energía`
        case 'vaciar_agi_str': return `${Math.round(e.prob * 100)}% de probabilidad de dejar la AGI y STR del rival en 0 por ${e.turnos} turnos`
        case 'dano_extra_prob': return `${Math.round(e.prob * 100)}% de probabilidad de ${e.min}-${e.max} de daño extra`
        case 'invocar_ejercito_bots': return `Crea ${e.cantidad} bots de ${e.hpCadaUno} HP que tanquean daño y contraatacan por ${e.contraataqueDano} cada uno`
        case 'ko_racha_useskill': return `${Math.round(e.prob * 100)}% de K.O. instantáneo en tus próximos ${e.usos} usos de .useskill`
        case 'stat_cero_permanente': return `Deja una estadística al azar del rival en 0 por el resto del duelo`
        case 'intercambiar_vida': return L(`Intercambia tu HP actual con la del rival`, `Troca seu HP atual com o do rival`, `Swaps your current HP with the rival's`)
        case 'redirigir_bonus': return `La próxima habilidad del rival se vuelve contra sí mismo con +${Math.round(e.pct * 100)}% de daño`
        case 'intercambio_total': return `Acción obligatoria: te da TODOS los efectos buenos del juego al máximo, y le da TODOS los efectos malos al rival al máximo, sin importar lo que tenían antes`
        default: return e.tipo
    }
}

function describirHabilidad(hab, lang = 'es') {
    if (!hab || !hab.efectos || !hab.efectos.length) return tr(lang, 'Daño directo.', 'Dano direto.', 'Direct damage.')
    return hab.efectos.map(ef => describirEfecto(ef, lang)).join('. ') + '.'
}

// Nivel/victorias mínimas para "despertar" una fruta y desbloquear su Habilidad Ultimate (.despertar)
const DESPERTAR_NIVEL_MIN = 3


// ========== ESTILOS DE COMBATE CUERPO A CUERPO (GDD V4.0 §4.1) ==========
const ESTILOS_COMBATE = [
    { id: 'boxeo', nombre: 'Boxeo', precio: 500, nivelMin: 1, critBase: 0.05, desc: 'Daño constante con 5% de crítico extra.' },
    { id: 'taekwondo', nombre: 'Taekwondo', precio: 800, nivelMin: 5, agiBonusPct: 0.20, desc: '+20% de AGI defensiva (más fácil esquivar).' },
    { id: 'muay_thai', nombre: 'Muay Thai', precio: 1000, nivelMin: 8, sangradoPct: 0.015, sangradoTurnos: 3, desc: 'Cada golpe deja sangrando al rival: 1.5% de su HP máx. por 3 turnos.' },
    { id: 'karate_acuatico', nombre: 'Karate Acuático', precio: 1200, nivelMin: 10, dmgVsDefAltaPct: 0.15, desc: '+15% de daño contra rivales con DEF alta (30+).' },
    { id: 'electro', nombre: 'Electro', precio: 1800, nivelMin: 15, paralisisProb: 0.10, desc: '10% de probabilidad de paralizar al rival en cada golpe.' },
    { id: 'capoeira', nombre: 'Capoeira', precio: 2200, nivelMin: 18, agiBonusPct: 0.10, robaEnergiaPct: 0.08, desc: 'Esquiva mejorada (+10% AGI) y roba 8% de la energía del rival en cada golpe.' },
    { id: 'dark_step', nombre: 'Dark Step', precio: 3000, nivelMin: 30, quemaduraPct: 0.02, quemaduraTurnos: 2, desc: 'Quema al rival: 2% de su HP máx. por 2 turnos.' },
    { id: 'kenpo_sombrio', nombre: 'Kenpo Sombrío', precio: 4000, nivelMin: 40, contraataquePct: 0.25, contraataqueProb: 0.20, desc: '20% de probabilidad de contraatacar por 25% del daño recibido.' },
    { id: 'dragon_breath', nombre: 'Dragon Breath', precio: 6000, nivelMin: 50, dotFuego: true, desc: 'Ataques de fuego con daño continuo severo.' },
    { id: 'titan_fist', nombre: 'Titan Fist', precio: 9000, nivelMin: 60, dmgVsDefAltaPct: 0.25, curaPorGolpe: 3, desc: '+25% de daño contra DEF alta y cura 3 HP por golpe acertado.' },
    { id: 'cyborg_brawler', nombre: 'Cyborg Brawler', precio: 15000, nivelMin: 75, defPasivaPct: 0.20, noEsquivable: true, desc: '+20% de DEF pasiva; tus ataques no pueden esquivarse.' },
    { id: 'void_walker', nombre: 'Void Walker', precio: 22000, nivelMin: 90, noEsquivable: true, paralisisProb: 0.15, desc: 'Tus ataques no pueden esquivarse y tienen 15% de probabilidad de paralizar.' },
    { id: 'godhuman', nombre: 'Godhuman', precio: 40000, nivelMin: 100, requiereTodos: true, ignoraDefPct: 0.30, curaPorGolpe: 5, desc: 'Ignora 30% de la DEF rival y cura 5 HP por golpe acertado. Requiere tener todos los estilos anteriores.' }
]

function tirarGachaFruta(pity, opts = {}) {
    const ticket = !!opts.ticket
    let roll = Math.floor(Math.random() * 1000) + 1
    // Pity: después de 50 tiradas sin mítica/divina, aumenta la chance de mítica
    // El ticket barato NO usa pity: si no, se farmea pity a $400.
    if (!ticket && pity >= 50) {
        const bonus = (pity - 49) * 1.5 // % extra acumulado
        if (Math.random() * 100 < bonus) roll = 951 + Math.floor(Math.random() * 49) // fuerza rango mítico
    }
    let categoria
    if (ticket) {
        // Ticket: mismas frutas, peor tabla. Común 70% / rara 22% / épica 7% / mítica 0.9% / divina 0.1%
        if (roll <= 700) categoria = 'comun'
        else if (roll <= 920) categoria = 'rara'
        else if (roll <= 990) categoria = 'epica'
        else if (roll <= 999) categoria = 'mitica'
        else categoria = 'divina'
    } else if (roll <= 500) categoria = 'comun'
    else if (roll <= 800) categoria = 'rara'
    else if (roll <= 950) categoria = 'epica'
    else if (roll <= 999) categoria = 'mitica'
    else categoria = 'divina'

    const datos = FRUTAS[categoria]
    const nombre = datos.nombres[Math.floor(Math.random() * datos.nombres.length)]
    return { categoria, nombre, datos }
}

cargarEconomia()

// Frutas exclusivas: se otorgan solas a esos LID al arrancar (no salen en el gacha)
const IDS_FRUTAS_EXCLUSIVAS = {
    '16970086887468': 'Fuego Alfa',
    '41343522992148': 'THE L',
    '83769193189377': 'Vacio'
}
function otorgarFrutasExclusivasOwners() {
    let cambios = false
    for (const [id, nombreFruta] of Object.entries(IDS_FRUTAS_EXCLUSIVAS)) {
        const user = getUsuario(`${id}@lid`)
        if (!frutaPoseida(user, nombreFruta)) {
            otorgarFruta(user, nombreFruta, 'owner')
            user.fruitEquipada = nombreFruta
            cambios = true
        }
    }
    if (cambios) guardarEconomia()
}
otorgarFrutasExclusivasOwners()

// Marca de versión (NO borra progreso)
const BETA_RESET_MARCA = './beta_reset_hecho.json'
if (!fs.existsSync(BETA_RESET_MARCA)) {
    try { fs.writeFileSync(BETA_RESET_MARCA, JSON.stringify({ fecha: new Date().toISOString(), nota: 'sin-reset' })) } catch (e) {}
}

// ========== WOLFRIC PROTOCOL: COMBATE PvP ==========
const duelosPendientes = new Map() // chatId -> { retador, retado, timestamp }
const duelosActivos = new Map()    // chatId -> { p1, p2, hp1, hp2, en1, en2, turno, timestamp, efectos: {p1,p2}, log: [] }

// ========== WOLFRIC PROTOCOL: DUELOS 2 VS 2 ==========
// Motor más ligero que el 1v1 (sin frutas/estilos completos) pensado para partidas rápidas en equipo.
const duelos2v2Pendientes = new Map() // chatId -> { equipoA:[j1,j2], equipoB:[j1,j2], timestamp }
const duelos2v2Activos = new Map()    // chatId -> { equipoA, equipoB, hp:{jid:hp}, en:{jid:en}, orden:[jid...], turnoIdx, timestamp }

// ========== MOTOR DE COMBATE: BARRAS Y ESTADOS (GDD V4.1 §2) ==========
const ENERGIA_REGEN_POR_TURNO = 8

function renderBarra(valor, max, len = 10) {
    const llenos = Math.round((Math.max(0, valor) / Math.max(1, max)) * len)
    return '█'.repeat(Math.max(0, Math.min(len, llenos))) + '░'.repeat(Math.max(0, len - llenos))
}

// Estado de combate por jugador dentro de un duelo (debuffs, dots, aturdimiento, etc.)
// REBALANCE: si dos jugadores con mucha diferencia de nivel se enfrentan, sus stats de combate
// se escalan para el duelo (SOLO para ese duelo, no toca los datos reales) de forma que quede parejo,
// sin borrar cómo cada uno repartió sus puntos — solo se reduce la escala del que tiene más nivel.
const DIFERENCIA_NIVEL_PARA_NORMALIZAR = 5
// Aplica el debuff temporal de expedición (herida leve de un evento de mar/isla) a un set de stats de combate
function aplicarDebuffExpedicion(statsBase, user) {
    if (user.debuffExpedicionExpira && user.debuffExpedicionExpira > Date.now() && user.debuffExpedicionStat) {
        const s = { ...statsBase }
        s[user.debuffExpedicionStat] = Math.max(1, Math.floor(s[user.debuffExpedicionStat] * 0.8))
        return s
    }
    return statsBase
}

function normalizarStatsParaDuelo(u1, u2) {
    const diferencia = Math.abs(u1.level - u2.level)
    if (diferencia < DIFERENCIA_NIVEL_PARA_NORMALIZAR) return null // parejo, no hace falta tocar nada

    const nivelRef = Math.min(u1.level, u2.level)
    const puntosEsperados = Math.max(0, (nivelRef - 1) * 3) // aprox. lo que tendría alguien de ese nivel

    function escalar(u) {
        const exceso = { str: u.stats.str - 10, def: u.stats.def - 10, agi: u.stats.agi - 10, int: u.stats.int - 10 }
        const total = exceso.str + exceso.def + exceso.agi + exceso.int
        if (total <= puntosEsperados || total <= 0) return { ...u.stats } // ya está por debajo o igual, no se toca
        const factor = puntosEsperados / total
        return {
            str: 10 + Math.round(exceso.str * factor),
            def: 10 + Math.round(exceso.def * factor),
            agi: 10 + Math.round(exceso.agi * factor),
            int: 10 + Math.round(exceso.int * factor)
        }
    }
    return { p1: escalar(u1), p2: escalar(u2) }
}

function nuevoEstadoCombate() {
    return {
        debuffAgiPct: 0, debuffAgiTurnos: 0,
        debuffDefPct: 0, debuffDefTurnos: 0,
        debuffStrPct: 0, debuffStrTurnos: 0,
        debuffIntPct: 0, debuffIntTurnos: 0,
        debuffDmgFlat: 0, debuffDmgFlatTurnos: 0,
        defZeroTurnos: 0, agiZeroTurnos: 0,
        aturdidoTurnos: 0, inmuneAturdirTurnos: 0,
        x2FisicoTurnos: 0,
        evasionBuffPct: 0, evasionBuffTurnos: 0,
        reflejoTurnos: 0,
        dots: [], // [{ pctMaxHp, turnos, nombreEstado }]
        reviveDisponible: false,
        botAmigo: null, // { hp } — fruta "Amigo" (evento): un bot aliado que tanquea daño hasta que lo destruyen
        ultimoDaño: 0,
        proximoCriticoAsegurado: false, // Inyector de Adrenalina
        proximoEscudoPct: 0,            // Escudo de Datos
        transformacion: null,           // Bigfoot: { dmgBonusPct, defBonusPct, nombre } — persiste hasta que termine el duelo
        buffDefPct: 0, buffDefTurnos: 0,        // Dolor: +DEF temporal
        reflejoDanoProb: null,          // Dolor: { prob, pct, turnos, soloFisico }
        habilidadRedirigida: false,     // Control: la próxima habilidad del rival se vuelve contra sí mismo
        redirigirBonusDmgPct: 0,        // Vacío: bono de daño extra al redirigir
        botsEjercito: null,             // [{hp}, ...] — ejército de bots que tanquean y contraatacan
        botsEjercitoContraataque: 0,
        vacioKoProb: 0, vacioKoUsosRestantes: 0, // Vacío: K.O. instantáneo en los próximos N usos de habilidad1
        statCeroPermanente: null,        // Vacío: 'str'|'def'|'agi'|'int' a 0 por el resto del duelo
        // ---- Frutas revolucionarias nuevas ----
        ultimaHabilidadUsada: null,      // { nombre, efectos, esFisico } — para Copia Copia
        dañoDiferido: [],                // [{ valor, turnos }] — Deuda: daño propio que llega más adelante
        parasito: null,                  // Simbiosis: { pctMaxHp, turnos } — le drena vida al rival en SU propio turno
        decoyEvasionProb: 0, decoyEvasionTurnos: 0, // Espejismo: esquiva plana, no depende de AGI
        ultimoDañoPropio: 0,             // Bucle: último daño que hiciste vos (para repetirlo)
        statIntercambiada: null,         // Trueque: { stat, valorPropio, valorRival } — swap persistente del duelo
        critBonusPct: 0, critBonusTurnos: 0 // Poción de Suerte
    }
}

function otroSlot(slot) { return slot === 'p1' ? 'p2' : 'p1' }
function hpDe(duelo, slot) { return slot === 'p1' ? duelo.hp1 : duelo.hp2 }
function setHp(duelo, slot, val) { if (slot === 'p1') duelo.hp1 = val; else duelo.hp2 = val }
function enDe(duelo, slot) { return slot === 'p1' ? duelo.en1 : duelo.en2 }
function setEn(duelo, slot, val) { if (slot === 'p1') duelo.en1 = val; else duelo.en2 = val }

function efectivoDef(base, estado) {
    if (estado.defZeroTurnos > 0) return 0
    if (estado.debuffDefTurnos > 0) return Math.max(0, Math.floor(base * (1 - estado.debuffDefPct)))
    return base
}
function efectivoAgi(base, estado) {
    if (estado.agiZeroTurnos > 0) return 0
    if (estado.debuffAgiTurnos > 0) return Math.max(0, Math.floor(base * (1 - estado.debuffAgiPct)))
    return base
}
// AGI tope 40% de esquiva (GDD V4.0 §4.2), salvo buffs especiales (ej. Kitsune ultimate) que lo elevan más
function chanceEsquiva(agiEfectivo, estado) {
    let base = Math.min(0.40, agiEfectivo / 250)
    if (estado.evasionBuffTurnos > 0) base = Math.max(base, estado.evasionBuffPct)
    return base
}
function chanceCritico(agiAtacante) {
    return Math.min(0.35, 0.05 + agiAtacante / 500)
}

// Se ejecuta al INICIO del turno de quien va a actuar: regenera energía, tickea dots/aturdimiento/debuffs.
// Devuelve { saltaTurno, textos } — si saltaTurno es true, el jugador pierde su turno (aturdido/congelado).
function procesarInicioTurno(duelo, slot, userMax) {
    const L = (es, pt, en) => tr(duelo.lang || 'es', es, pt, en)
    const estado = duelo.efectos[slot]
    const textos = []

    // Regeneración de energía en combate (GDD: la energía se gestiona en tiempo real durante el duelo)
    setEn(duelo, slot, Math.min(userMax.maxEnergy, enDe(duelo, slot) + ENERGIA_REGEN_POR_TURNO))

    // Daño en el tiempo (veneno/quemadura/asfixia)
    if (estado.dots.length) {
        let totalDot = 0
        const nombres = new Set()
        estado.dots.forEach(d => { totalDot += Math.max(1, Math.floor(userMax.maxHp * d.pctMaxHp)); nombres.add(d.nombreEstado) })
        if (totalDot > 0) {
            setHp(duelo, slot, Math.max(0, hpDe(duelo, slot) - totalDot))
            textos.push(L(`☠️ *${[...nombres].join(', ')}* inflige *${totalDot}* de daño.`, `☠️ *${[...nombres].join(', ')}* causa *${totalDot}* de dano.`, `☠️ *${[...nombres].join(', ')}* deals *${totalDot}* damage.`))
        }
        estado.dots.forEach(d => d.turnos--)
        estado.dots = estado.dots.filter(d => d.turnos > 0)
    }

    if (estado.debuffAgiTurnos > 0 && --estado.debuffAgiTurnos === 0) estado.debuffAgiPct = 0
    if (estado.debuffDefTurnos > 0 && --estado.debuffDefTurnos === 0) estado.debuffDefPct = 0
    if (estado.debuffStrTurnos > 0 && --estado.debuffStrTurnos === 0) estado.debuffStrPct = 0
    if (estado.debuffIntTurnos > 0 && --estado.debuffIntTurnos === 0) estado.debuffIntPct = 0
    if (estado.debuffDmgFlatTurnos > 0 && --estado.debuffDmgFlatTurnos === 0) estado.debuffDmgFlat = 0
    if (estado.buffDefTurnos > 0 && --estado.buffDefTurnos === 0) estado.buffDefPct = 0
    if (estado.defZeroTurnos > 0) estado.defZeroTurnos--
    if (estado.agiZeroTurnos > 0) estado.agiZeroTurnos--
    if (estado.inmuneAturdirTurnos > 0) estado.inmuneAturdirTurnos--
    if (estado.x2FisicoTurnos > 0) estado.x2FisicoTurnos--
    if (estado.evasionBuffTurnos > 0 && --estado.evasionBuffTurnos === 0) estado.evasionBuffPct = 0
    if (estado.reflejoTurnos > 0) estado.reflejoTurnos--
    if (estado.reflejoDanoProb && estado.reflejoDanoProb.turnos > 0 && --estado.reflejoDanoProb.turnos === 0) estado.reflejoDanoProb = null
    if (estado.decoyEvasionTurnos > 0 && --estado.decoyEvasionTurnos === 0) estado.decoyEvasionProb = 0
    if (estado.critBonusTurnos > 0 && --estado.critBonusTurnos === 0) estado.critBonusPct = 0

    // Deuda: el daño pendiente llega cuando se cumple el plazo
    if (estado.dañoDiferido.length) {
        estado.dañoDiferido.forEach(d => d.turnos--)
        const vencidas = estado.dañoDiferido.filter(d => d.turnos <= 0)
        if (vencidas.length) {
            const totalDeuda = vencidas.reduce((a, d) => a + d.valor, 0)
            setHp(duelo, slot, Math.max(0, hpDe(duelo, slot) - totalDeuda))
            textos.push(L(`⏳ *Deuda* vencida: te cobra *${totalDeuda}* HP.`, `⏳ *Dívida* venceu: cobra *${totalDeuda}* HP.`, `⏳ *Debt* is due: it takes *${totalDeuda}* HP.`))
        }
        estado.dañoDiferido = estado.dañoDiferido.filter(d => d.turnos > 0)
    }

    // Simbiosis: el parásito drena vida en el propio turno del que lo tiene puesto
    if (estado.parasito && estado.parasito.turnos > 0) {
        const otroSlotId = otroSlot(slot)
        const drenado = Math.max(1, Math.floor(userMax.maxHp * estado.parasito.pctMaxHp))
        setHp(duelo, slot, Math.max(0, hpDe(duelo, slot) - drenado))
        setHp(duelo, otroSlotId, hpDe(duelo, otroSlotId) + drenado)
        textos.push(L(`🪱 El parásito drena *${drenado}* HP y se la pasa a quien lo puso.`, `🪱 O parasita drena *${drenado}* HP e passa pra quem colocou.`, `🪱 The parasite drains *${drenado}* HP and gives it to whoever planted it.`))
        estado.parasito.turnos--
        if (estado.parasito.turnos <= 0) estado.parasito = null
    }

    let saltaTurno = false
    if (estado.aturdidoTurnos > 0) {
        estado.aturdidoTurnos--
        saltaTurno = true
        textos.push(L(`❄️ Sigue aturdido/congelado y pierde su turno.`, `❄️ Continua atordoado/congelado e perde o turno.`, `❄️ Still stunned/frozen and skips the turn.`))
    }
    return { saltaTurno, textos }
}

// Renderiza el bloque de HP/EN de AMBOS combatientes — se adjunta a cada mensaje de combate (GDD V4.1 §2.3.4)
function estadoCombateTexto(duelo, u1, u2) {
    return `${frontierPanel('𝗗𝗨𝗘𝗟𝗢 𝗔𝗖𝗧𝗜𝗩𝗢', [
        `@${duelo.p1.split('@')[0]} VS @${duelo.p2.split('@')[0]}`,
        `❤️ @${duelo.p1.split('@')[0]} [${renderBarra(duelo.hp1, u1.maxHp)}] ${Math.max(0, duelo.hp1)}/${u1.maxHp} · ⚡${Math.max(0, duelo.en1)}/${u1.maxEnergy}`,
        `❤️ @${duelo.p2.split('@')[0]} [${renderBarra(duelo.hp2, u2.maxHp)}] ${Math.max(0, duelo.hp2)}/${u2.maxHp} · ⚡${Math.max(0, duelo.en2)}/${u2.maxEnergy}`
    ], '⚔️')}`
}

// Sincroniza en tiempo real un duelo activo cuando un admin modifica HP/energía/maxHp/maxEnergy de un jugador (GDD V4.2 §3.2)
function sincronizarDueloConStats(jid, campo, valor) {
    const jidN = jid.split('@')[0].split(':')[0]
    for (const [chatId, duelo] of duelosActivos.entries()) {
        const p1N = duelo.p1.split('@')[0].split(':')[0]
        const p2N = duelo.p2.split('@')[0].split(':')[0]
        if (jidN === p1N) {
            if (campo === 'hp') duelo.hp1 = valor
            if (campo === 'energia') duelo.en1 = valor
        } else if (jidN === p2N) {
            if (campo === 'hp') duelo.hp2 = valor
            if (campo === 'energia') duelo.en2 = valor
        }
    }
}

// Resuelve una habilidad (o golpe físico) de atacante -> defensor, aplicando esquiva/crítico/daño variable
// y TODOS los efectos secundarios (debuffs, dots, aturdimiento, robo, curación, etc.) — GDD V4.0 §2 + V4.1 §2.3
// Fruta "Amigo" (evento Día del Amigo): si el defensor tiene un Bot-Amigo activo, absorbe el daño primero
function aplicarDañoConAmigo(estadoDefensor, dañoOriginal, lang = 'es') {
    if (estadoDefensor.botAmigo && estadoDefensor.botAmigo.hp > 0) {
        const absorbido = Math.min(estadoDefensor.botAmigo.hp, dañoOriginal)
        estadoDefensor.botAmigo.hp -= absorbido
        const restante = dañoOriginal - absorbido
        let mensaje = tr(lang, `🤖 Tu Bot-Amigo absorbe *${absorbido}* de daño (le quedan ${Math.max(0, estadoDefensor.botAmigo.hp)} HP).`, `🤖 Seu Bot-Amigo absorve *${absorbido}* de dano (restam ${Math.max(0, estadoDefensor.botAmigo.hp)} HP).`, `🤖 Your Friend-Bot absorbs *${absorbido}* damage (${Math.max(0, estadoDefensor.botAmigo.hp)} HP left).`)
        if (estadoDefensor.botAmigo.hp <= 0) { estadoDefensor.botAmigo = null; mensaje += tr(lang, ' ¡El Bot-Amigo fue destruido!', ' O Bot-Amigo foi destruído!', ' The Friend-Bot was destroyed!') }
        return { dañoFinal: restante, mensaje }
    }
    return { dañoFinal: dañoOriginal, mensaje: null }
}

// El ejército de bots absorbe daño (repartido entre los que sigan vivos) y contraataca por cada bot vivo
function aplicarDañoConEjercito(estadoDefensor, dañoOriginal, lang = 'es') {
    if (estadoDefensor.botsEjercito && estadoDefensor.botsEjercito.some(b => b.hp > 0)) {
        let restante = dañoOriginal
        for (const bot of estadoDefensor.botsEjercito) {
            if (restante <= 0) break
            if (bot.hp <= 0) continue
            const absorbido = Math.min(bot.hp, restante)
            bot.hp -= absorbido
            restante -= absorbido
        }
        const vivos = estadoDefensor.botsEjercito.filter(b => b.hp > 0).length
        const contraataque = vivos * (estadoDefensor.botsEjercitoContraataque || 0)
        let mensaje = tr(lang, `💻 El ejército de bots absorbe *${dañoOriginal - restante}* de daño (${vivos} bots en pie) y contraataca por *${contraataque}*.`, `💻 O exército de bots absorve *${dañoOriginal - restante}* de dano (${vivos} bots de pé) e contra-ataca por *${contraataque}*.`, `💻 The bot army absorbs *${dañoOriginal - restante}* damage (${vivos} bots standing) and counters for *${contraataque}*.`)
        if (vivos === 0) { estadoDefensor.botsEjercito = null; mensaje += tr(lang, ' ¡El ejército fue destruido!', ' O exército foi destruído!', ' The army was destroyed!') }
        return { dañoFinal: restante, mensaje, contraataque }
    }
    return { dañoFinal: dañoOriginal, mensaje: null, contraataque: 0 }
}

function resolverHabilidad(duelo, slotAtacante, atacanteJid, defensorJid, atacante, defensor, habilidad, esFisico) {
    const L = (es, pt, en) => tr(duelo.lang || 'es', es, pt, en)
    const slotDefensor = otroSlot(slotAtacante)
    const estadoAtacante = duelo.efectos[slotAtacante]
    const estadoDefensor = duelo.efectos[slotDefensor]
    const efectos = habilidad.efectos || []
    const mensajes = []

    const estiloAtacante = esFisico ? ESTILOS_COMBATE.find(e => e.id === atacante.estiloEquipado) : null
    const estiloDefensor = ESTILOS_COMBATE.find(e => e.id === defensor.estiloEquipado)

    // Cyborg Brawler: los ataques de quien lo lleva equipado no pueden ser esquivados
    const nuncaFalla = efectos.some(e => e.tipo === 'nunca_falla') || (estiloAtacante?.noEsquivable === true)
    // Taekwondo: +20% de AGI efectiva del defensor para esquivar
    let agiDefEfectiva = efectivoAgi(defensor.stats.agi, estadoDefensor)
    if (estiloDefensor?.agiBonusPct) agiDefEfectiva = Math.floor(agiDefEfectiva * (1 + estiloDefensor.agiBonusPct))
    if (estadoDefensor.statCeroPermanente === 'agi') agiDefEfectiva = 0 // Vacío
    // Espejismo: esquiva plana adicional que no depende de AGI (se evalúa aparte)
    const esquivoPorDecoy = estadoDefensor.decoyEvasionTurnos > 0 && Math.random() < estadoDefensor.decoyEvasionProb
    const esquivo = esquivoPorDecoy || (!nuncaFalla && Math.random() < chanceEsquiva(agiDefEfectiva, estadoDefensor))

    if (esquivo) {
        mensajes.push(L(`💨 @${defensorJid.split('@')[0]} esquivó el ataque!`, `💨 @${defensorJid.split('@')[0]} desviou do ataque!`, `💨 @${defensorJid.split('@')[0]} dodged the attack!`))
        return { daño: 0, esquivo: true, mensajes, koInstant: false, extraTurno: false, atacanteMuereAuto: false, esCritico: false }
    }

    let ignoraDefPct = 0
    efectos.forEach(e => { if (e.tipo === 'ignora_def_pct') ignoraDefPct = Math.max(ignoraDefPct, e.pct) })
    if (estiloAtacante?.ignoraDefPct) ignoraDefPct = Math.max(ignoraDefPct, estiloAtacante.ignoraDefPct) // Godhuman
    // Cyborg Brawler: +20% de DEF pasiva para quien lo lleva equipado (como defensor)
    let defBase = defensor.stats.def
    if (estiloDefensor?.defPasivaPct) defBase = Math.floor(defBase * (1 + estiloDefensor.defPasivaPct))
    // Dolor: +40%/+100% de DEF temporal mientras esté activo el buff
    if (estadoDefensor.buffDefTurnos > 0) defBase = Math.floor(defBase * (1 + estadoDefensor.buffDefPct))
    // Bigfoot: la transformación también sube la DEF mientras dure el duelo
    if (estadoDefensor.transformacion?.defBonusPct) defBase = Math.floor(defBase * (1 + estadoDefensor.transformacion.defBonusPct))
    if (estadoDefensor.statCeroPermanente === 'def') defBase = 0 // Vacío
    if (estadoDefensor.statIntercambiada?.stat === 'def') defBase = estadoDefensor.statIntercambiada.valorPropio // Trueque
    const defEfectiva = Math.floor(efectivoDef(defBase, estadoDefensor) * (1 - ignoraDefPct))

    let daño
    const dmgPctDef = efectos.find(e => e.tipo === 'dmg_pct_def_max_rival')
    let strEfectiva = estadoAtacante.debuffStrTurnos > 0 ? Math.floor(atacante.stats.str * (1 - estadoAtacante.debuffStrPct)) : atacante.stats.str
    let intEfectiva = estadoAtacante.debuffIntTurnos > 0 ? Math.floor(atacante.stats.int * (1 - estadoAtacante.debuffIntPct)) : atacante.stats.int
    if (estadoAtacante.statCeroPermanente === 'str') strEfectiva = 0 // Vacío
    if (estadoAtacante.statCeroPermanente === 'int') intEfectiva = 0 // Vacío
    if (estadoAtacante.statIntercambiada?.stat === 'str') strEfectiva = estadoAtacante.statIntercambiada.valorPropio // Trueque
    if (estadoAtacante.statIntercambiada?.stat === 'int') intEfectiva = estadoAtacante.statIntercambiada.valorPropio // Trueque
    // REBALANCE: la DEF ahora pesa 2.2x en la resta para que se note de verdad (antes era casi invisible)
    const defRestada = Math.floor(defEfectiva * 2.2)
    if (esFisico) {
        daño = strEfectiva + (5 + Math.floor(Math.random() * 16)) + (habilidad.weaponAtk || 0) - defRestada // bono base variable 5-20 + arma Frontier
        // Karate Acuático: +15% de daño contra rivales con defensa alta
        if (estiloAtacante?.dmgVsDefAltaPct && defensor.stats.def >= 30) daño = Math.floor(daño * (1 + estiloAtacante.dmgVsDefAltaPct))
    } else if (dmgPctDef) {
        daño = Math.floor(defensor.stats.def * dmgPctDef.pct) + Math.floor(intEfectiva / 2)
    } else {
        daño = Math.floor(intEfectiva * 1.5 + (habilidad.poder || 0) + Math.floor((habilidad.weaponAtk || 0) * 0.35)) - defRestada
    }

    // Variedad: ±15% de aleatoriedad para que ningún golpe sea idéntico
    daño = Math.floor(daño * (0.85 + Math.random() * 0.30))
    efectos.forEach(e => { if (e.tipo === 'dmg_mult') daño = Math.floor(daño * e.mult) })
    if (esFisico && estadoAtacante.x2FisicoTurnos > 0) daño = Math.floor(daño * 2)
    // Bigfoot: la transformación también sube el daño propio mientras dure el duelo
    if (estadoAtacante.transformacion?.dmgBonusPct) daño = Math.floor(daño * (1 + estadoAtacante.transformacion.dmgBonusPct))

    const critAsegurado = efectos.some(e => e.tipo === 'crit_asegurado') || estadoAtacante.proximoCriticoAsegurado
    if (estadoAtacante.proximoCriticoAsegurado) estadoAtacante.proximoCriticoAsegurado = false
    // Boxeo: +5% de probabilidad de crítico en golpes físicos
    const bonusCritEstilo = estiloAtacante?.critBase || 0
    // Poción de Suerte: bono temporal de probabilidad de crítico
    const bonusCritPocion = (estadoAtacante.critBonusTurnos > 0) ? estadoAtacante.critBonusPct : 0
    const esCritico = critAsegurado || Math.random() < (chanceCritico(efectivoAgi(atacante.stats.agi, estadoAtacante)) + bonusCritEstilo + bonusCritPocion)
    if (esCritico) daño = Math.floor(daño * 1.6)
    // Control: daño plano reducido en el rival mientras esté activo
    if (estadoAtacante.debuffDmgFlatTurnos > 0) daño = Math.max(1, daño - estadoAtacante.debuffDmgFlat)

    // Apuesta (Fruta): doble o nada — 50% triplica el daño, 50% lo anula y te devuelve el golpe a vos
    let apuestaPerdida = false
    if (efectos.some(e => e.tipo === 'doble_o_nada')) {
        if (Math.random() < 0.5) {
            daño = Math.floor(daño * 3)
            mensajes.push(L(`🎲 *Apuesta*: ¡ganaste! Daño triplicado.`, `🎲 *Aposta*: ganhou! Dano triplicado.`, `🎲 *Gamble*: you won! Damage tripled.`))
        } else {
            const recoil = Math.max(1, daño)
            setHp(duelo, slotAtacante, Math.max(0, hpDe(duelo, slotAtacante) - recoil))
            apuestaPerdida = true
            mensajes.push(L(`🎲 *Apuesta*: perdiste... el golpe se anula y recibís *${recoil}* de daño vos mismo/a.`, `🎲 *Aposta*: perdeu... o golpe anula e você toma *${recoil}* de dano.`, `🎲 *Gamble*: you lost... the hit cancels and you take *${recoil}* damage.`))
            daño = 0
        }
    }

    // Sacrificio (Fruta): convertís una parte de tu propia HP en daño extra
    const efectoSacrificio = efectos.find(e => e.tipo === 'sacrificar_hp_por_daño')
    if (efectoSacrificio && !apuestaPerdida) {
        const hpASacrificar = Math.max(1, Math.floor(hpDe(duelo, slotAtacante) * efectoSacrificio.pct))
        setHp(duelo, slotAtacante, Math.max(1, hpDe(duelo, slotAtacante) - hpASacrificar))
        daño += hpASacrificar
        mensajes.push(L(`🩸 *Sacrificio*: cedés *${hpASacrificar}* HP propia para sumarla directo al golpe.`, `🩸 *Sacrifício*: cede *${hpASacrificar}* HP própria e soma no golpe.`, `🩸 *Sacrifice*: you give *${hpASacrificar}* of your HP and add it to the hit.`))
    }

    daño = Math.max(apuestaPerdida ? 0 : 1, daño)

    // Escudo de Datos: bloquea un % del daño de este golpe (se consume al usarse)
    if (estadoDefensor.proximoEscudoPct) {
        const bloqueado = Math.floor(daño * estadoDefensor.proximoEscudoPct)
        daño = Math.max(1, daño - bloqueado)
        mensajes.push(L(`🛡️ *Escudo de Datos* de @${defensorJid.split('@')[0]} bloquea *${bloqueado}* de daño.`, `🛡️ *Escudo de Dados* de @${defensorJid.split('@')[0]} bloqueia *${bloqueado}* de dano.`, `🛡️ *Data Shield* on @${defensorJid.split('@')[0]} blocks *${bloqueado}* damage.`))
        estadoDefensor.proximoEscudoPct = 0
    }

    const { dañoFinal, mensaje: mensajeAmigo } = aplicarDañoConAmigo(estadoDefensor, daño, duelo.lang || 'es')
    const { dañoFinal: dañoFinal2, mensaje: mensajeEjercito, contraataque } = aplicarDañoConEjercito(estadoDefensor, dañoFinal, duelo.lang || 'es')
    setHp(duelo, slotDefensor, Math.max(0, hpDe(duelo, slotDefensor) - dañoFinal2))
    if (contraataque > 0) setHp(duelo, slotAtacante, Math.max(0, hpDe(duelo, slotAtacante) - contraataque))
    mensajes.push(`${esCritico ? L('💥 ¡CRÍTICO! ','💥 CRÍTICO! ','💥 CRIT! ') : ''}💢 ${L('Daño','Dano','Damage')}: *${daño}*`)
    if (mensajeAmigo) mensajes.push(mensajeAmigo)
    if (mensajeEjercito) mensajes.push(mensajeEjercito)

    // Bucle (Fruta): repite tu último golpe propio, como un eco instantáneo
    if (efectos.some(e => e.tipo === 'repetir_ultimo_daño_propio') && estadoAtacante.ultimoDañoPropio > 0) {
        const eco = estadoAtacante.ultimoDañoPropio
        setHp(duelo, slotDefensor, Math.max(0, hpDe(duelo, slotDefensor) - eco))
        mensajes.push(L(`🔁 *Bucle*: el eco de tu último golpe repite *${eco}* de daño.`, `🔁 *Loop*: o eco do último golpe repete *${eco}* de dano.`, `🔁 *Loop*: the echo of your last hit repeats *${eco}* damage.`))
    }
    estadoAtacante.ultimoDañoPropio = daño
    estadoAtacante.ultimaHabilidadUsada = { nombre: habilidad.nombre, efectos: habilidad.efectos || [], esFisico }

    if (estadoDefensor.reflejoDanoProb && (!estadoDefensor.reflejoDanoProb.soloFisico || esFisico) && Math.random() < estadoDefensor.reflejoDanoProb.prob) {
        const reflejado = Math.max(1, Math.floor(daño * estadoDefensor.reflejoDanoProb.pct))
        setHp(duelo, slotAtacante, Math.max(0, hpDe(duelo, slotAtacante) - reflejado))
        mensajes.push(L(`🩹 *Dolor*: @${defensorJid.split('@')[0]} redirige *${reflejado}* de daño hacia @${atacanteJid.split('@')[0]}.`, `🩹 *Dor*: @${defensorJid.split('@')[0]} redireciona *${reflejado}* de dano para @${atacanteJid.split('@')[0]}.`, `🩹 *Pain*: @${defensorJid.split('@')[0]} redirects *${reflejado}* damage to @${atacanteJid.split('@')[0]}.`))
    }

    // ---- Efectos pasivos de Estilos de Combate en golpes físicos (GDD V4.0 §4.1) ----
    if (estiloAtacante) {
        if (estiloAtacante.paralisisProb && Math.random() < estiloAtacante.paralisisProb) {
            if (estadoDefensor.inmuneAturdirTurnos > 0) mensajes.push(L(`🛡️ @${defensorJid.split('@')[0]} es inmune a la parálisis.`, `🛡️ @${defensorJid.split('@')[0]} é imune à paralisia.`, `🛡️ @${defensorJid.split('@')[0]} is immune to paralysis.`))
            else { estadoDefensor.aturdidoTurnos = Math.max(estadoDefensor.aturdidoTurnos, 1); mensajes.push(`⚡ *${estiloAtacante.nombre}*: @${defensorJid.split('@')[0]} queda paralizado y pierde su próximo turno.`) }
        }
        if (estiloAtacante.quemaduraPct) {
            estadoDefensor.dots.push({ pctMaxHp: estiloAtacante.quemaduraPct, turnos: estiloAtacante.quemaduraTurnos, nombreEstado: `Quemadura (${estiloAtacante.nombre})` })
            mensajes.push(`🔥 *${estiloAtacante.nombre}*: @${defensorJid.split('@')[0]} queda quemado ${estiloAtacante.quemaduraTurnos} turnos.`)
        }
        if (estiloAtacante.dotFuego) {
            estadoDefensor.dots.push({ pctMaxHp: 0.04, turnos: 3, nombreEstado: `Fuego (${estiloAtacante.nombre})` })
            mensajes.push(`🐉 *${estiloAtacante.nombre}*: @${defensorJid.split('@')[0]} arde en llamas continuas por 3 turnos.`)
        }
        if (estiloAtacante.curaPorGolpe) {
            setHp(duelo, slotAtacante, Math.min(atacante.maxHp, hpDe(duelo, slotAtacante) + estiloAtacante.curaPorGolpe))
            mensajes.push(`💚 *${estiloAtacante.nombre}*: @${atacanteJid.split('@')[0]} cura *${estiloAtacante.curaPorGolpe}* HP por el golpe acertado.`)
        }
        if (estiloAtacante.sangradoPct) {
            estadoDefensor.dots.push({ pctMaxHp: estiloAtacante.sangradoPct, turnos: estiloAtacante.sangradoTurnos, nombreEstado: `Sangrado (${estiloAtacante.nombre})` })
            mensajes.push(`🩸 *${estiloAtacante.nombre}*: @${defensorJid.split('@')[0]} queda sangrando ${estiloAtacante.sangradoTurnos} turnos.`)
        }
        if (estiloAtacante.robaEnergiaPct) {
            const enDef = enDe(duelo, slotDefensor)
            const robado = Math.floor(enDef * estiloAtacante.robaEnergiaPct)
            if (robado > 0) {
                setEn(duelo, slotDefensor, Math.max(0, enDef - robado))
                setEn(duelo, slotAtacante, Math.min(atacante.maxEnergy, enDe(duelo, slotAtacante) + robado))
                mensajes.push(`🔋 *${estiloAtacante.nombre}*: @${atacanteJid.split('@')[0]} roba *${robado}⚡* del golpe.`)
            }
        }
    }
    // Contraataque: si el DEFENSOR tiene este estilo, tiene chance de devolver parte del golpe recibido
    if (estiloDefensor?.contraataquePct && Math.random() < estiloDefensor.contraataqueProb) {
        const devuelto = Math.max(1, Math.floor(daño * estiloDefensor.contraataquePct))
        setHp(duelo, slotAtacante, Math.max(0, hpDe(duelo, slotAtacante) - devuelto))
        mensajes.push(L(`🥊 *${estiloDefensor.nombre}*: @${defensorJid.split('@')[0]} contraataca por *${devuelto}* de daño.`, `🥊 *${estiloDefensor.nombre}*: @${defensorJid.split('@')[0]} contra-ataca por *${devuelto}* de dano.`, `🥊 *${estiloDefensor.nombre}*: @${defensorJid.split('@')[0]} counters for *${devuelto}* damage.`))
    }

    let extraTurno = false, atacanteMuereAuto = false, koInstant = false
    for (const e of efectos) {
        const objetivoSlot = e.autoObjetivo ? slotAtacante : slotDefensor
        const objetivoJid = objetivoSlot === slotAtacante ? atacanteJid : defensorJid
        const estadoObjetivo = duelo.efectos[objetivoSlot]
        const maxHpObjetivo = objetivoSlot === slotAtacante ? atacante.maxHp : defensor.maxHp
        const maxEnObjetivo = objetivoSlot === slotAtacante ? atacante.maxEnergy : defensor.maxEnergy

        switch (e.tipo) {
            case 'debuff_agi':
                estadoObjetivo.debuffAgiPct = e.pct; estadoObjetivo.debuffAgiTurnos = e.turnos
                mensajes.push(`🐌 AGI de @${objetivoJid.split('@')[0]} -${Math.round(e.pct * 100)}% por ${e.turnos} turnos.`)
                break
            case 'debuff_def':
                estadoObjetivo.debuffDefPct = e.pct; estadoObjetivo.debuffDefTurnos = e.turnos
                mensajes.push(`🛡️ DEF de @${objetivoJid.split('@')[0]} -${Math.round(e.pct * 100)}% por ${e.turnos} turnos.`)
                break
            case 'set_def_zero':
                estadoObjetivo.defZeroTurnos = e.turnos
                mensajes.push(`🛡️ DEF de @${objetivoJid.split('@')[0]} a 0 por ${e.turnos} turnos.`)
                break
            case 'set_agi_zero':
                estadoObjetivo.agiZeroTurnos = e.turnos
                mensajes.push(`🐌 AGI de @${objetivoJid.split('@')[0]} a 0 por ${e.turnos} turnos.`)
                break
            case 'dot':
                if (e.prob !== undefined && Math.random() >= e.prob) { mensajes.push(`💨 La quemadura no prendió esta vez.`); break }
                estadoObjetivo.dots.push({ pctMaxHp: e.pctMaxHp, turnos: e.turnos, nombreEstado: e.nombreEstado })
                mensajes.push(`☠️ @${objetivoJid.split('@')[0]} queda con *${e.nombreEstado}* (${e.turnos} turnos).`)
                break
            case 'aturde':
                if (estadoObjetivo.inmuneAturdirTurnos > 0) mensajes.push(`🛡️ @${objetivoJid.split('@')[0]} es inmune a aturdimiento.`)
                else { estadoObjetivo.aturdidoTurnos = Math.max(estadoObjetivo.aturdidoTurnos, e.turnos); mensajes.push(`❄️ @${objetivoJid.split('@')[0]} aturdido/congelado ${e.turnos} turno(s).`) }
                break
            case 'aturde_chance':
                if (Math.random() < e.prob) {
                    if (estadoObjetivo.inmuneAturdirTurnos > 0) mensajes.push(`🛡️ @${objetivoJid.split('@')[0]} es inmune a aturdimiento.`)
                    else { estadoObjetivo.aturdidoTurnos = Math.max(estadoObjetivo.aturdidoTurnos, e.turnos); mensajes.push(`❄️ @${objetivoJid.split('@')[0]} aturdido ${e.turnos} turno(s).`) }
                }
                break
            case 'lifesteal_pct': {
                if (e.prob !== undefined && Math.random() >= e.prob) { mensajes.push(`🩸 El robo de vida no se activó esta vez.`); break }
                const robado = Math.floor(daño * e.pct)
                setHp(duelo, slotAtacante, Math.min(atacante.maxHp, hpDe(duelo, slotAtacante) + robado))
                mensajes.push(`🩸 @${atacanteJid.split('@')[0]} roba *${robado}* HP.`)
                break
            }
            case 'roba_energia_pct': {
                const enDef = enDe(duelo, slotDefensor)
                const robado = Math.floor(enDef * e.pct)
                setEn(duelo, slotDefensor, Math.max(0, enDef - robado))
                setEn(duelo, slotAtacante, Math.min(atacante.maxEnergy, enDe(duelo, slotAtacante) + robado))
                mensajes.push(`🔋 @${atacanteJid.split('@')[0]} roba *${robado}⚡* de energía.`)
                break
            }
            case 'cura_flat':
                setHp(duelo, objetivoSlot, Math.min(maxHpObjetivo, hpDe(duelo, objetivoSlot) + e.valor))
                mensajes.push(`💚 @${objetivoJid.split('@')[0]} cura *${e.valor}* HP.`)
                break
            case 'limpia_estados':
                estadoObjetivo.dots = []; estadoObjetivo.debuffAgiTurnos = 0; estadoObjetivo.debuffAgiPct = 0
                estadoObjetivo.debuffDefTurnos = 0; estadoObjetivo.debuffDefPct = 0
                mensajes.push(`✨ @${objetivoJid.split('@')[0]} limpia todos los estados negativos.`)
                break
            case 'ko_chance':
                if (Math.random() < e.prob) { koInstant = true; mensajes.push(`💀 ¡GOLPE FATAL! K.O. instantáneo.`) }
                break
            case 'extra_turno':
                extraTurno = true
                mensajes.push(`⏳ @${atacanteJid.split('@')[0]} gana un turno extra; @${defensorJid.split('@')[0]} pierde el suyo.`)
                break
            case 'buff_agi_evasion':
                estadoObjetivo.evasionBuffPct = e.pct; estadoObjetivo.evasionBuffTurnos = e.turnos
                mensajes.push(`🌀 @${objetivoJid.split('@')[0]} sube su esquiva al ${Math.round(e.pct * 100)}% por ${e.turnos} turnos.`)
                break
            case 'x2_fisico':
                estadoObjetivo.x2FisicoTurnos = e.turnos
                mensajes.push(`👊 Daño físico de @${objetivoJid.split('@')[0]} x2 por ${e.turnos} turnos.`)
                break
            case 'inmune_aturdir':
                estadoObjetivo.inmuneAturdirTurnos = e.turnos
                mensajes.push(`🛡️ @${objetivoJid.split('@')[0]} inmune a aturdimiento por ${e.turnos} turnos.`)
                break
            case 'revive_pasiva':
                estadoObjetivo.reviveDisponible = true
                mensajes.push(`🔥 Resurrección pasiva activada para @${objetivoJid.split('@')[0]} (revive 1 vez si cae a 0 HP).`)
                break
            case 'reflejo':
                estadoObjetivo.reflejoTurnos = e.turnos
                mensajes.push(`💣 Trampa colocada: si @${defensorJid.split('@')[0]} usa *.attack* en su próximo turno, la mina explota.`)
                break
            case 'anula_ultimo_ataque': {
                const recuperar = duelo.efectos[objetivoSlot].ultimoDaño || 0
                if (recuperar > 0) { setHp(duelo, objetivoSlot, Math.min(maxHpObjetivo, hpDe(duelo, objetivoSlot) + recuperar)); mensajes.push(`⏱️ Se anula el último ataque recibido: +${recuperar} HP.`) }
                break
            }
            case 'auto_ko':
                atacanteMuereAuto = true
                break
            // ==== Efectos de las frutas revolucionarias ====
            case 'daño_diferido': {
                // Deuda: el daño extra de este golpe llega recién dentro de N turnos, como propio (recoil)
                const extra = Math.max(3, Math.floor((habilidad.poder || 15) * (e.mult || 0.8)))
                estadoAtacante.dañoDiferido.push({ valor: extra, turnos: e.turnos || 2 })
                mensajes.push(`⏳ *Deuda*: quedás debiendo *${extra}* HP propia, te la cobra en ${e.turnos || 2} turnos.`)
                break
            }
            case 'parasito':
                estadoObjetivo.parasito = { pctMaxHp: e.pctMaxHp, turnos: e.turnos }
                mensajes.push(`🪱 *Simbiosis*: un parásito se adhiere a @${objetivoJid.split('@')[0]}, le drenará vida en sus propios turnos por ${e.turnos} turnos.`)
                break
            case 'decoy_evasion':
                estadoObjetivo.decoyEvasionProb = e.prob
                estadoObjetivo.decoyEvasionTurnos = e.turnos
                mensajes.push(`👥 *Espejismo*: @${objetivoJid.split('@')[0]} tiene ${Math.round(e.prob * 100)}% de esquiva fija por ${e.turnos} turnos (no depende de AGI).`)
                break
            case 'equilibrar_hp': {
                const hpA = hpDe(duelo, slotAtacante), hpD = hpDe(duelo, slotDefensor)
                const promedio = Math.floor((hpA + hpD) / 2)
                const nuevoA = Math.floor(hpA + (promedio - hpA) * 0.5)
                const nuevoD = Math.floor(hpD + (promedio - hpD) * 0.5)
                setHp(duelo, slotAtacante, Math.max(1, nuevoA))
                setHp(duelo, slotDefensor, Math.max(1, nuevoD))
                mensajes.push(`⚖️ *Balanza*: las HP de ambos se acercan al punto medio.`)
                break
            }
            case 'disipar_buff_rival':
                estadoDefensor.buffDefPct = 0; estadoDefensor.buffDefTurnos = 0
                estadoDefensor.evasionBuffPct = 0; estadoDefensor.evasionBuffTurnos = 0
                estadoDefensor.transformacion = null
                estadoDefensor.proximoCriticoAsegurado = false
                estadoDefensor.proximoEscudoPct = 0
                mensajes.push(`💎 *Grieta*: se disipan todos los efectos positivos de @${defensorJid.split('@')[0]}.`)
                break
            case 'intercambiar_stat_aleatorio': {
                const stats = ['str', 'def', 'agi', 'int']
                const stat = stats[Math.floor(Math.random() * stats.length)]
                estadoAtacante.statIntercambiada = { stat, valorPropio: defensor.stats[stat], valorRival: atacante.stats[stat] }
                estadoDefensor.statIntercambiada = { stat, valorPropio: atacante.stats[stat], valorRival: defensor.stats[stat] }
                mensajes.push(`🔄 *Trueque*: @${atacanteJid.split('@')[0]} y @${defensorJid.split('@')[0]} intercambian su ${stat.toUpperCase()} por el resto del duelo.`)
                break
            }
            case 'copiar_ultima_habilidad': {
                const ultima = estadoDefensor.ultimaHabilidadUsada
                if (!ultima) { mensajes.push(`📋 *Copia Copia*: el rival todavía no usó ninguna habilidad para copiar.`); break }
                mensajes.push(`📋 *Copia Copia*: repite *${ultima.nombre}* del rival, ¡pero contra él!`)
                const subresultado = resolverHabilidad(duelo, slotAtacante, atacanteJid, defensorJid, atacante, defensor, { nombre: ultima.nombre, poder: 15, efectos: ultima.efectos.filter(ef => ef.tipo !== 'copiar_ultima_habilidad') }, ultima.esFisico)
                mensajes.push(...subresultado.mensajes)
                break
            }
            // ---- Amigo (evento Día del Amigo): probabilidad de invocar un Bot-Amigo que tanquea daño ----
            case 'invocar_amigo': {
                if (Math.random() < e.prob) {
                    estadoObjetivo.botAmigo = { hp: e.hpBot }
                    mensajes.push(`🤖 ¡Un Bot-Amigo aparece a proteger a @${objetivoJid.split('@')[0]}! (${e.hpBot} HP)`)
                } else {
                    mensajes.push(`🤖 El Bot-Amigo no llegó a tiempo esta vez.`)
                }
                break
            }
            // ==== Efectos exclusivos de las frutas de Owner/Dev ====
            case 'vaciar_energia_total':
                if (Math.random() < e.prob) {
                    setEn(duelo, objetivoSlot === slotAtacante ? slotAtacante : slotDefensor, 0)
                    mensajes.push(`🌑 *Vacío*: la energía de @${objetivoJid.split('@')[0]} queda completamente drenada.`)
                }
                break
            case 'vaciar_agi_str':
                if (Math.random() < e.prob) {
                    estadoObjetivo.debuffAgiPct = 1; estadoObjetivo.debuffAgiTurnos = e.turnos
                    estadoObjetivo.debuffStrPct = 1; estadoObjetivo.debuffStrTurnos = e.turnos
                    mensajes.push(`🌑 *Vacío*: AGI y STR de @${objetivoJid.split('@')[0]} caen a 0 por ${e.turnos} turnos.`)
                }
                break
            case 'dano_extra_prob':
                if (Math.random() < e.prob) {
                    const extra = e.min + Math.floor(Math.random() * (e.max - e.min + 1))
                    setHp(duelo, slotDefensor, Math.max(0, hpDe(duelo, slotDefensor) - extra))
                    mensajes.push(`🔥 ¡${e.nombreEstado || 'Golpe extra'}! +${extra} de daño adicional.`)
                }
                break
            case 'invocar_ejercito_bots':
                if (Math.random() < (e.prob ?? 1)) {
                    estadoObjetivo.botsEjercito = Array.from({ length: e.cantidad }, () => ({ hp: e.hpCadaUno }))
                    estadoObjetivo.botsEjercitoContraataque = e.contraataqueDano
                    mensajes.push(`💻 *Ejército de Bots*: ${e.cantidad} bots de ${e.hpCadaUno} HP protegen a @${objetivoJid.split('@')[0]} y contraatacan por ${e.contraataqueDano} cada uno.`)
                }
                break
            case 'ko_racha_useskill':
                estadoObjetivo.vacioKoProb = e.prob
                estadoObjetivo.vacioKoUsosRestantes = e.usos
                mensajes.push(`⬛ @${objetivoJid.split('@')[0]} tiene ${Math.round(e.prob * 100)}% de K.O. instantáneo en sus próximos ${e.usos} usos de habilidad.`)
                break
            case 'stat_cero_permanente': {
                const stats = ['str', 'def', 'agi', 'int']
                const stat = stats[Math.floor(Math.random() * stats.length)]
                estadoObjetivo.statCeroPermanente = stat
                mensajes.push(`⬛ *Vacío*: el ${stat.toUpperCase()} de @${objetivoJid.split('@')[0]} queda en 0 por el resto del duelo.`)
                break
            }
            case 'intercambiar_vida': {
                const hpAtacante = hpDe(duelo, slotAtacante), hpDefensorAntes = hpDe(duelo, slotDefensor)
                setHp(duelo, slotAtacante, Math.min(atacante.maxHp, hpDefensorAntes))
                setHp(duelo, slotDefensor, Math.min(defensor.maxHp, hpAtacante))
                mensajes.push(`⬛ *Vacío*: ¡intercambio de vidas! Ahora @${atacanteJid.split('@')[0]} tiene ${Math.min(atacante.maxHp, hpDefensorAntes)} HP y @${defensorJid.split('@')[0]} tiene ${Math.min(defensor.maxHp, hpAtacante)} HP.`)
                break
            }
            case 'redirigir_bonus':
                estadoObjetivo.habilidadRedirigida = true
                estadoObjetivo.redirigirBonusDmgPct = e.pct
                mensajes.push(`⬛ *Vacío*: la próxima habilidad de @${objetivoJid.split('@')[0]} se vuelve contra sí mismo/a con +${Math.round(e.pct * 100)}% de daño.`)
                break
            case 'intercambio_total': {
                // "Dios de la Programación": acción obligatoria e incondicional.
                // El rival recibe TODOS los efectos malos del juego al máximo, sin importar lo que tenía puesto.
                estadoDefensor.debuffAgiPct = 1; estadoDefensor.debuffAgiTurnos = 3
                estadoDefensor.debuffDefPct = 1; estadoDefensor.debuffDefTurnos = 3
                estadoDefensor.debuffStrPct = 1; estadoDefensor.debuffStrTurnos = 3
                estadoDefensor.debuffIntPct = 1; estadoDefensor.debuffIntTurnos = 3
                estadoDefensor.defZeroTurnos = 3
                estadoDefensor.agiZeroTurnos = 3
                estadoDefensor.aturdidoTurnos = Math.max(estadoDefensor.aturdidoTurnos, 1)
                estadoDefensor.debuffDmgFlat = 20; estadoDefensor.debuffDmgFlatTurnos = 3
                estadoDefensor.dots.push({ pctMaxHp: 0.08, turnos: 3, nombreEstado: 'Corrupción Total' })

                // El usuario recibe TODOS los efectos buenos del juego al máximo, sin importar lo que tenía puesto.
                estadoAtacante.buffDefPct = 1; estadoAtacante.buffDefTurnos = 3
                estadoAtacante.evasionBuffPct = 0.75; estadoAtacante.evasionBuffTurnos = 3
                estadoAtacante.transformacion = { dmgBonusPct: 0.30, defBonusPct: 0.30, nombre: 'Programación Perfecta' }
                estadoAtacante.reviveDisponible = true
                estadoAtacante.proximoCriticoAsegurado = true
                estadoAtacante.proximoEscudoPct = 0.5
                estadoAtacante.inmuneAturdirTurnos = 3
                estadoAtacante.x2FisicoTurnos = 3

                mensajes.push(`💻 *Dios de la Programación*: @${defensorJid.split('@')[0]} recibe TODOS los efectos malos del juego, y @${atacanteJid.split('@')[0]} recibe TODOS los efectos buenos. Sin excepciones.`)
                break
            }
            // ---- Bigfoot: transformación persistente (dura hasta que termine el duelo) ----
            case 'transformar': {
                const proc = e.prob === undefined || Math.random() < e.prob
                if (proc) {
                    if (e.curar) setHp(duelo, objetivoSlot, Math.min(maxHpObjetivo, hpDe(duelo, objetivoSlot) + e.curar))
                    // La ultimate (tier superior) siempre reemplaza a una transformación más débil
                    if (!estadoObjetivo.transformacion || (e.dmgBonusPct >= (estadoObjetivo.transformacion.dmgBonusPct || 0))) {
                        estadoObjetivo.transformacion = { dmgBonusPct: e.dmgBonusPct, defBonusPct: e.defBonusPct, nombre: e.nombreEstado }
                    }
                    mensajes.push(`🦍 *${e.nombreEstado}*: @${objetivoJid.split('@')[0]} se transforma — +${e.curar || 0} HP, +${Math.round(e.dmgBonusPct * 100)}% daño, +${Math.round(e.defBonusPct * 100)}% DEF por el resto del duelo.`)
                } else {
                    mensajes.push(`🦶 La transformación no se activó esta vez.`)
                }
                break
            }
            // ---- Dolor: +DEF temporal ----
            case 'buff_def_self':
                estadoObjetivo.buffDefPct = e.pct
                estadoObjetivo.buffDefTurnos = e.turnos
                mensajes.push(`🩹 @${objetivoJid.split('@')[0]} gana +${Math.round(e.pct * 100)}% de DEF por ${e.turnos} turnos.`)
                break
            // ---- Dolor: probabilidad de redirigir daño recibido ----
            case 'reflejo_dano_prob':
                estadoObjetivo.reflejoDanoProb = { prob: e.prob, pct: e.pct, turnos: e.turnos, soloFisico: !!e.soloFisico }
                mensajes.push(`🩸 @${objetivoJid.split('@')[0]} tiene ${Math.round(e.prob * 100)}% de probabilidad de redirigir ${Math.round(e.pct * 100)}% del daño${e.soloFisico ? ' físico' : ''} recibido por ${e.turnos} turnos.`)
                break
            // ---- Control: baja los 4 stats del rival un % por N turnos ----
            case 'debuff_all_stats':
                estadoObjetivo.debuffAgiPct = e.pct; estadoObjetivo.debuffAgiTurnos = e.turnos
                estadoObjetivo.debuffDefPct = e.pct; estadoObjetivo.debuffDefTurnos = e.turnos
                estadoObjetivo.debuffStrPct = e.pct; estadoObjetivo.debuffStrTurnos = e.turnos
                estadoObjetivo.debuffIntPct = e.pct; estadoObjetivo.debuffIntTurnos = e.turnos
                mensajes.push(`🧠 *Control*: todos los stats de @${objetivoJid.split('@')[0]} bajan ${Math.round(e.pct * 100)}% por ${e.turnos} turnos.`)
                break
            // ---- Control: reduce una cantidad plana del daño que hace el rival ----
            case 'debuff_dmg_flat':
                estadoObjetivo.debuffDmgFlat = e.valor
                estadoObjetivo.debuffDmgFlatTurnos = e.turnos
                mensajes.push(`🧠 *Control*: el daño de @${objetivoJid.split('@')[0]} baja *-${e.valor}* por ${e.turnos} turnos.`)
                break
            // ---- Control: la próxima habilidad de fruta del rival se activa contra sí mismo ----
            case 'marcar_redirigir':
                estadoObjetivo.habilidadRedirigida = true
                mensajes.push(`🧠 *Control*: la próxima habilidad de fruta de @${objetivoJid.split('@')[0]} se volverá contra sí mismo/a.`)
                break
            // ---- Control (Habilidad 1): elige aleatoriamente uno de tres efectos menores sobre el rival ----
            case 'control_aleatorio': {
                const roll = Math.random()
                if (roll < 0.34) {
                    estadoDefensor.debuffDmgFlat = 10; estadoDefensor.debuffDmgFlatTurnos = 2
                    mensajes.push(`🧠 *Control*: el daño de @${defensorJid.split('@')[0]} baja *-10* por 2 turnos.`)
                } else if (roll < 0.67) {
                    estadoDefensor.habilidadRedirigida = true
                    mensajes.push(`🧠 *Control*: la próxima habilidad de fruta de @${defensorJid.split('@')[0]} se volverá contra sí mismo/a.`)
                } else {
                    estadoDefensor.debuffAgiPct = 0.05; estadoDefensor.debuffAgiTurnos = 2
                    estadoDefensor.debuffDefPct = 0.05; estadoDefensor.debuffDefTurnos = 2
                    estadoDefensor.debuffStrPct = 0.05; estadoDefensor.debuffStrTurnos = 2
                    estadoDefensor.debuffIntPct = 0.05; estadoDefensor.debuffIntTurnos = 2
                    mensajes.push(`🧠 *Control*: todos los stats de @${defensorJid.split('@')[0]} bajan 5% por 2 turnos.`)
                }
                break
            }
            // ---- Caos: siempre pasa algo grande, para bien o para mal — impredecible por diseño ----
            case 'caos_aleatorio': {
                const roll = Math.random()
                if (roll < 0.40) {
                    const extra = daño
                    setHp(duelo, slotDefensor, Math.max(0, hpDe(duelo, slotDefensor) - extra))
                    mensajes.push(`🌀 *Caos*: ¡el multiverso se alinea! Daño duplicado (+${extra} extra).`)
                } else if (roll < 0.70) {
                    estadoDefensor.aturdidoTurnos = Math.max(estadoDefensor.aturdidoTurnos, 1)
                    mensajes.push(`🌀 *Caos*: una fractura temporal aturde a @${defensorJid.split('@')[0]}.`)
                } else {
                    estadoAtacante.debuffStrPct = 0.15; estadoAtacante.debuffStrTurnos = 2
                    estadoAtacante.debuffIntPct = 0.15; estadoAtacante.debuffIntTurnos = 2
                    mensajes.push(`🌀 *Caos*: el efecto se revierte — tus propios stats bajan 15% por 2 turnos.`)
                }
                break
            }
        }
    }

    duelo.efectos[slotDefensor].ultimoDaño = daño
    if (koInstant) setHp(duelo, slotDefensor, 0)

    return { daño, esquivo: false, mensajes, koInstant, extraTurno, atacanteMuereAuto, esCritico }
}

// ========== WOLFRIC PROTOCOL: MOTOR 2 VS 2 (jid-based, TODAS las frutas funcionan igual que en 1vs1) ==========
function procesarInicioTurno2v2(dg, jid, userMax) {
    const L = (es, pt, en) => tr(dg.lang || 'es', es, pt, en)
    const estado = dg.estados[jid]
    const textos = []
    dg.en[jid] = Math.min(userMax.maxEnergy, (dg.en[jid] || 0) + ENERGIA_REGEN_POR_TURNO)

    if (estado.dots.length) {
        let totalDot = 0
        const nombres = new Set()
        estado.dots.forEach(d => { totalDot += Math.max(1, Math.floor(userMax.maxHp * d.pctMaxHp)); nombres.add(d.nombreEstado) })
        if (totalDot > 0) {
            dg.hp[jid] = Math.max(0, dg.hp[jid] - totalDot)
            textos.push(`☠️ *${[...nombres].join(', ')}* inflige *${totalDot}* de daño a @${jid.split('@')[0]}.`)
        }
        estado.dots.forEach(d => d.turnos--)
        estado.dots = estado.dots.filter(d => d.turnos > 0)
    }
    if (estado.debuffAgiTurnos > 0 && --estado.debuffAgiTurnos === 0) estado.debuffAgiPct = 0
    if (estado.debuffDefTurnos > 0 && --estado.debuffDefTurnos === 0) estado.debuffDefPct = 0
    if (estado.debuffStrTurnos > 0 && --estado.debuffStrTurnos === 0) estado.debuffStrPct = 0
    if (estado.debuffIntTurnos > 0 && --estado.debuffIntTurnos === 0) estado.debuffIntPct = 0
    if (estado.debuffDmgFlatTurnos > 0 && --estado.debuffDmgFlatTurnos === 0) estado.debuffDmgFlat = 0
    if (estado.buffDefTurnos > 0 && --estado.buffDefTurnos === 0) estado.buffDefPct = 0
    if (estado.defZeroTurnos > 0) estado.defZeroTurnos--
    if (estado.agiZeroTurnos > 0) estado.agiZeroTurnos--
    if (estado.inmuneAturdirTurnos > 0) estado.inmuneAturdirTurnos--
    if (estado.x2FisicoTurnos > 0) estado.x2FisicoTurnos--
    if (estado.evasionBuffTurnos > 0 && --estado.evasionBuffTurnos === 0) estado.evasionBuffPct = 0
    if (estado.reflejoTurnos > 0) estado.reflejoTurnos--
    if (estado.reflejoDanoProb && estado.reflejoDanoProb.turnos > 0 && --estado.reflejoDanoProb.turnos === 0) estado.reflejoDanoProb = null

    let saltaTurno = false
    if (estado.aturdidoTurnos > 0) {
        estado.aturdidoTurnos--
        saltaTurno = true
        textos.push(`❄️ @${jid.split('@')[0]} sigue aturdido/congelado y pierde su turno.`)
    }
    return { saltaTurno, textos }
}

function resolverHabilidad2v2(dg, atacanteJid, defensorJid, atacante, defensor, habilidad, esFisico) {
    const L = (es, pt, en) => tr(dg.lang || 'es', es, pt, en)
    const estadoAtacante = dg.estados[atacanteJid]
    const estadoDefensor = dg.estados[defensorJid]
    const efectos = habilidad.efectos || []
    const mensajes = []

    const nuncaFalla = efectos.some(e => e.tipo === 'nunca_falla')
    const agiDefEfectiva = efectivoAgi(defensor.stats.agi, estadoDefensor)
    const esquivo = !nuncaFalla && Math.random() < chanceEsquiva(agiDefEfectiva, estadoDefensor)
    if (esquivo) {
        mensajes.push(L(`💨 @${defensorJid.split('@')[0]} esquivó el ataque!`, `💨 @${defensorJid.split('@')[0]} desviou do ataque!`, `💨 @${defensorJid.split('@')[0]} dodged the attack!`))
        return { daño: 0, esquivo: true, mensajes, koInstant: false, atacanteMuereAuto: false, esCritico: false }
    }

    let ignoraDefPct = 0
    efectos.forEach(e => { if (e.tipo === 'ignora_def_pct') ignoraDefPct = Math.max(ignoraDefPct, e.pct) })
    let defBase = defensor.stats.def
    if (estadoDefensor.buffDefTurnos > 0) defBase = Math.floor(defBase * (1 + estadoDefensor.buffDefPct))
    if (estadoDefensor.transformacion?.defBonusPct) defBase = Math.floor(defBase * (1 + estadoDefensor.transformacion.defBonusPct))
    const defEfectiva = Math.floor(efectivoDef(defBase, estadoDefensor) * (1 - ignoraDefPct))

    let daño
    const dmgPctDef = efectos.find(e => e.tipo === 'dmg_pct_def_max_rival')
    const strEfectiva = estadoAtacante.debuffStrTurnos > 0 ? Math.floor(atacante.stats.str * (1 - estadoAtacante.debuffStrPct)) : atacante.stats.str
    const intEfectiva = estadoAtacante.debuffIntTurnos > 0 ? Math.floor(atacante.stats.int * (1 - estadoAtacante.debuffIntPct)) : atacante.stats.int
    const defRestada = Math.floor(defEfectiva * 2.2) // REBALANCE: la DEF pesa 2.2x
    if (esFisico) daño = strEfectiva + (5 + Math.floor(Math.random() * 16)) + (habilidad.weaponAtk || 0) - defRestada
    else if (dmgPctDef) daño = Math.floor(defensor.stats.def * dmgPctDef.pct) + Math.floor(intEfectiva / 2)
    else daño = Math.floor(intEfectiva * 1.5 + (habilidad.poder || 0) + Math.floor((habilidad.weaponAtk || 0) * 0.35)) - defRestada

    daño = Math.floor(daño * (0.85 + Math.random() * 0.30))
    efectos.forEach(e => { if (e.tipo === 'dmg_mult') daño = Math.floor(daño * e.mult) })
    if (esFisico && estadoAtacante.x2FisicoTurnos > 0) daño = Math.floor(daño * 2)
    if (estadoAtacante.transformacion?.dmgBonusPct) daño = Math.floor(daño * (1 + estadoAtacante.transformacion.dmgBonusPct))

    const critAsegurado = efectos.some(e => e.tipo === 'crit_asegurado') || estadoAtacante.proximoCriticoAsegurado
    if (estadoAtacante.proximoCriticoAsegurado) estadoAtacante.proximoCriticoAsegurado = false
    const esCritico = critAsegurado || Math.random() < chanceCritico(efectivoAgi(atacante.stats.agi, estadoAtacante))
    if (esCritico) daño = Math.floor(daño * 1.6)
    if (estadoAtacante.debuffDmgFlatTurnos > 0) daño = Math.max(1, daño - estadoAtacante.debuffDmgFlat)
    daño = Math.max(1, daño)

    if (estadoDefensor.proximoEscudoPct) {
        const bloqueado = Math.floor(daño * estadoDefensor.proximoEscudoPct)
        daño = Math.max(1, daño - bloqueado)
        mensajes.push(`🛡️ *Escudo de Datos* bloquea *${bloqueado}* de daño.`)
        estadoDefensor.proximoEscudoPct = 0
    }

    const { dañoFinal, mensaje: mensajeAmigo } = aplicarDañoConAmigo(estadoDefensor, daño, duelo.lang || 'es')
    dg.hp[defensorJid] = Math.max(0, dg.hp[defensorJid] - dañoFinal)
    mensajes.push(`${esCritico ? L('💥 ¡CRÍTICO! ','💥 CRÍTICO! ','💥 CRIT! ') : ''}💢 ${L('Daño','Dano','Damage')}: *${daño}*`)
    if (mensajeAmigo) mensajes.push(mensajeAmigo)

    if (estadoDefensor.reflejoDanoProb && (!estadoDefensor.reflejoDanoProb.soloFisico || esFisico) && Math.random() < estadoDefensor.reflejoDanoProb.prob) {
        const reflejado = Math.max(1, Math.floor(daño * estadoDefensor.reflejoDanoProb.pct))
        dg.hp[atacanteJid] = Math.max(0, dg.hp[atacanteJid] - reflejado)
        mensajes.push(`🩹 *Dolor*: @${defensorJid.split('@')[0]} redirige *${reflejado}* hacia @${atacanteJid.split('@')[0]}.`)
    }

    let atacanteMuereAuto = false, koInstant = false
    for (const e of efectos) {
        const objetivoJid = e.autoObjetivo ? atacanteJid : defensorJid
        const estadoObjetivo = dg.estados[objetivoJid]
        const objetivoUser = e.autoObjetivo ? atacante : defensor

        switch (e.tipo) {
            case 'debuff_agi': estadoObjetivo.debuffAgiPct = e.pct; estadoObjetivo.debuffAgiTurnos = e.turnos; mensajes.push(`🐌 AGI de @${objetivoJid.split('@')[0]} -${Math.round(e.pct * 100)}% (${e.turnos}t).`); break
            case 'debuff_def': estadoObjetivo.debuffDefPct = e.pct; estadoObjetivo.debuffDefTurnos = e.turnos; mensajes.push(`🛡️ DEF de @${objetivoJid.split('@')[0]} -${Math.round(e.pct * 100)}% (${e.turnos}t).`); break
            case 'set_def_zero': estadoObjetivo.defZeroTurnos = e.turnos; mensajes.push(`🛡️ DEF de @${objetivoJid.split('@')[0]} a 0 (${e.turnos}t).`); break
            case 'set_agi_zero': estadoObjetivo.agiZeroTurnos = e.turnos; mensajes.push(`🐌 AGI de @${objetivoJid.split('@')[0]} a 0 (${e.turnos}t).`); break
            case 'dot': if (e.prob !== undefined && Math.random() >= e.prob) { mensajes.push(`💨 No prendió esta vez.`); break }; estadoObjetivo.dots.push({ pctMaxHp: e.pctMaxHp, turnos: e.turnos, nombreEstado: e.nombreEstado }); mensajes.push(`☠️ @${objetivoJid.split('@')[0]} con *${e.nombreEstado}* (${e.turnos}t).`); break
            case 'aturde':
                if (estadoObjetivo.inmuneAturdirTurnos > 0) mensajes.push(`🛡️ @${objetivoJid.split('@')[0]} es inmune.`)
                else { estadoObjetivo.aturdidoTurnos = Math.max(estadoObjetivo.aturdidoTurnos, e.turnos); mensajes.push(`❄️ @${objetivoJid.split('@')[0]} aturdido ${e.turnos}t.`) }
                break
            case 'aturde_chance':
                if (Math.random() < e.prob) {
                    if (estadoObjetivo.inmuneAturdirTurnos > 0) mensajes.push(`🛡️ @${objetivoJid.split('@')[0]} es inmune.`)
                    else { estadoObjetivo.aturdidoTurnos = Math.max(estadoObjetivo.aturdidoTurnos, e.turnos); mensajes.push(`❄️ @${objetivoJid.split('@')[0]} aturdido.`) }
                }
                break
            case 'lifesteal_pct': { if (e.prob !== undefined && Math.random() >= e.prob) { mensajes.push(`🩸 El robo de vida no se activó esta vez.`); break }; const robado = Math.floor(daño * e.pct); dg.hp[atacanteJid] = Math.min(atacante.maxHp, dg.hp[atacanteJid] + robado); mensajes.push(`🩸 @${atacanteJid.split('@')[0]} roba *${robado}* HP.`); break }
            case 'roba_energia_pct': { const enDef = dg.en[defensorJid] || 0; const robado = Math.floor(enDef * e.pct); dg.en[defensorJid] = Math.max(0, enDef - robado); dg.en[atacanteJid] = Math.min(atacante.maxEnergy, (dg.en[atacanteJid] || 0) + robado); mensajes.push(`🔋 @${atacanteJid.split('@')[0]} roba *${robado}⚡*.`); break }
            case 'cura_flat': dg.hp[objetivoJid] = Math.min(objetivoUser.maxHp, dg.hp[objetivoJid] + e.valor); mensajes.push(`💚 @${objetivoJid.split('@')[0]} cura *${e.valor}* HP.`); break
            case 'limpia_estados': estadoObjetivo.dots = []; estadoObjetivo.debuffAgiTurnos = 0; estadoObjetivo.debuffAgiPct = 0; estadoObjetivo.debuffDefTurnos = 0; estadoObjetivo.debuffDefPct = 0; mensajes.push(`✨ @${objetivoJid.split('@')[0]} limpia estados negativos.`); break
            case 'ko_chance': if (Math.random() < e.prob) { koInstant = true; mensajes.push(`💀 ¡GOLPE FATAL!`) } break
            case 'extra_turno': mensajes.push(`⏳ @${atacanteJid.split('@')[0]} actuó con velocidad extra.`); break
            case 'buff_agi_evasion': estadoObjetivo.evasionBuffPct = e.pct; estadoObjetivo.evasionBuffTurnos = e.turnos; mensajes.push(`🌀 @${objetivoJid.split('@')[0]} sube su esquiva (${e.turnos}t).`); break
            case 'x2_fisico': estadoObjetivo.x2FisicoTurnos = e.turnos; mensajes.push(`👊 Daño físico x2 de @${objetivoJid.split('@')[0]} (${e.turnos}t).`); break
            case 'inmune_aturdir': estadoObjetivo.inmuneAturdirTurnos = e.turnos; mensajes.push(`🛡️ @${objetivoJid.split('@')[0]} inmune a aturdimiento (${e.turnos}t).`); break
            case 'revive_pasiva': estadoObjetivo.reviveDisponible = true; mensajes.push(`🔥 Resurrección activada para @${objetivoJid.split('@')[0]}.`); break
            case 'reflejo': estadoObjetivo.reflejoTurnos = e.turnos; mensajes.push(`💣 Trampa colocada en @${defensorJid.split('@')[0]}.`); break
            case 'anula_ultimo_ataque': { const rec = estadoObjetivo.ultimoDaño || 0; if (rec > 0) { dg.hp[objetivoJid] = Math.min(objetivoUser.maxHp, dg.hp[objetivoJid] + rec); mensajes.push(`⏱️ +${rec} HP recuperado.`) } break }
            case 'auto_ko': atacanteMuereAuto = true; break
            case 'invocar_amigo':
                if (Math.random() < e.prob) { estadoObjetivo.botAmigo = { hp: e.hpBot }; mensajes.push(`🤖 ¡Un Bot-Amigo protege a @${objetivoJid.split('@')[0]}! (${e.hpBot} HP)`) }
                else mensajes.push(`🤖 El Bot-Amigo no llegó a tiempo esta vez.`)
                break
            case 'transformar': {
                const proc = e.prob === undefined || Math.random() < e.prob
                if (proc) {
                    if (e.curar) dg.hp[objetivoJid] = Math.min(objetivoUser.maxHp, dg.hp[objetivoJid] + e.curar)
                    if (!estadoObjetivo.transformacion || e.dmgBonusPct >= (estadoObjetivo.transformacion.dmgBonusPct || 0)) estadoObjetivo.transformacion = { dmgBonusPct: e.dmgBonusPct, defBonusPct: e.defBonusPct, nombre: e.nombreEstado }
                    mensajes.push(`🦍 *${e.nombreEstado}*: @${objetivoJid.split('@')[0]} se transforma.`)
                } else mensajes.push(`🦶 La transformación no se activó.`)
                break
            }
            case 'buff_def_self': estadoObjetivo.buffDefPct = e.pct; estadoObjetivo.buffDefTurnos = e.turnos; mensajes.push(`🩹 @${objetivoJid.split('@')[0]} +${Math.round(e.pct * 100)}% DEF (${e.turnos}t).`); break
            case 'reflejo_dano_prob': estadoObjetivo.reflejoDanoProb = { prob: e.prob, pct: e.pct, turnos: e.turnos, soloFisico: !!e.soloFisico }; mensajes.push(`🩸 @${objetivoJid.split('@')[0]} puede redirigir daño (${e.turnos}t).`); break
            case 'debuff_all_stats':
                estadoObjetivo.debuffAgiPct = e.pct; estadoObjetivo.debuffAgiTurnos = e.turnos
                estadoObjetivo.debuffDefPct = e.pct; estadoObjetivo.debuffDefTurnos = e.turnos
                estadoObjetivo.debuffStrPct = e.pct; estadoObjetivo.debuffStrTurnos = e.turnos
                estadoObjetivo.debuffIntPct = e.pct; estadoObjetivo.debuffIntTurnos = e.turnos
                mensajes.push(`🧠 Todos los stats de @${objetivoJid.split('@')[0]} bajan ${Math.round(e.pct * 100)}%.`)
                break
            case 'debuff_dmg_flat': estadoObjetivo.debuffDmgFlat = e.valor; estadoObjetivo.debuffDmgFlatTurnos = e.turnos; mensajes.push(`🧠 Daño de @${objetivoJid.split('@')[0]} baja -${e.valor}.`); break
            case 'marcar_redirigir': estadoObjetivo.habilidadRedirigida = true; mensajes.push(`🧠 La próxima habilidad de @${objetivoJid.split('@')[0]} se volverá contra sí mismo/a.`); break
            case 'control_aleatorio': {
                const roll = Math.random()
                if (roll < 0.34) { estadoDefensor.debuffDmgFlat = 10; estadoDefensor.debuffDmgFlatTurnos = 2; mensajes.push(`🧠 Daño de @${defensorJid.split('@')[0]} -10.`) }
                else if (roll < 0.67) { estadoDefensor.habilidadRedirigida = true; mensajes.push(`🧠 Habilidad de @${defensorJid.split('@')[0]} marcada.`) }
                else { estadoDefensor.debuffAgiPct = 0.05; estadoDefensor.debuffAgiTurnos = 2; estadoDefensor.debuffDefPct = 0.05; estadoDefensor.debuffDefTurnos = 2; estadoDefensor.debuffStrPct = 0.05; estadoDefensor.debuffStrTurnos = 2; estadoDefensor.debuffIntPct = 0.05; estadoDefensor.debuffIntTurnos = 2; mensajes.push(`🧠 Stats de @${defensorJid.split('@')[0]} -5%.`) }
                break
            }
            case 'caos_aleatorio': {
                const roll = Math.random()
                if (roll < 0.40) { const extra = daño; dg.hp[defensorJid] = Math.max(0, dg.hp[defensorJid] - extra); mensajes.push(`🌀 ¡Daño duplicado! +${extra} extra.`) }
                else if (roll < 0.70) { estadoDefensor.aturdidoTurnos = Math.max(estadoDefensor.aturdidoTurnos, 1); mensajes.push(`🌀 @${defensorJid.split('@')[0]} aturdido por el caos.`) }
                else { estadoAtacante.debuffStrPct = 0.15; estadoAtacante.debuffStrTurnos = 2; estadoAtacante.debuffIntPct = 0.15; estadoAtacante.debuffIntTurnos = 2; mensajes.push(`🌀 El caos se revierte contra @${atacanteJid.split('@')[0]}.`) }
                break
            }
        }
    }

    estadoDefensor.ultimoDaño = daño
    if (koInstant) dg.hp[defensorJid] = 0
    return { daño, esquivo: false, mensajes, koInstant, atacanteMuereAuto, esCritico }
}

// ========== WOLFRIC PROTOCOL: TRADING ==========
const tradesActivos = new Map() // id -> { from, to, coins, chatId, timestamp }
let tradeIdCounter = 1

// ========== WOLFRIC PROTOCOL: MARES E ISLAS ==========
// 3 mares, cada uno con 2 islas temáticas para farmear + 1 isla aparte para el boss de ese mar.
// Mar 1 y 2 son gratis; Mar 3 requiere nivel 50 y $3000. Para viajar a CUALQUIER mar hace falta
// estar en un gremio de al menos 2 personas (viaje en grupo).
const MARES = [
    {
        id: 1, nombre: 'Mar Esmeralda', gratis: true,
        islas: [
            { id: 1, nombre: 'Isla Verdania', tema: '🌴 selva', monstruo: 'Pantera de Musgo', min: 40, max: 90 },
            { id: 2, nombre: 'Isla Coralina', tema: '🐚 arrecife', monstruo: 'Cangrejo Acorazado', min: 40, max: 90 }
        ],
        boss: { nombre: 'Leviatán Esmeralda', hpMax: 8000, coins: 300, exp: 20, bounty: 20 }
    },
    {
        id: 2, nombre: 'Mar Carmesí', gratis: true,
        islas: [
            { id: 1, nombre: 'Isla Volcánica', tema: '🌋 lava', monstruo: 'Salamandra de Magma', min: 60, max: 120 },
            { id: 2, nombre: 'Isla Cenicienta', tema: '🌫️ ceniza', monstruo: 'Fénix Menor', min: 60, max: 120 }
        ],
        boss: { nombre: 'Dragón Carmesí', hpMax: 12000, coins: 450, exp: 30, bounty: 30 }
    },
    {
        id: 3, nombre: 'Mar Abisal', gratis: false, nivelMin: 50, costo: 3000,
        islas: [
            { id: 1, nombre: 'Isla del Vacío', tema: '⚫ abismo', monstruo: 'Horror Abisal', min: 90, max: 180 },
            { id: 2, nombre: 'Isla Fantasma', tema: '👻 niebla', monstruo: 'Espectro Errante', min: 90, max: 180 }
        ],
        boss: { nombre: 'Kraken del Vacío', hpMax: 20000, coins: 800, exp: 60, bounty: 60 }
    }
]
const islaBosses = new Map() // marId -> { hp, hpMax }
const EXPLORAR_COOLDOWN_MS = 2 * 60 * 1000
const REGEN_HP_TIERRA_POR_MIN = 3 // HP que se recupera por minuto estando en la Isla Principal

// Regeneración lenta de HP mientras estás en tierra (isla principal). Se llama de forma "perezosa"
// (calcula el tiempo transcurrido) en vez de necesitar un timer corriendo todo el tiempo.
function regenerarHpTierra(user) {
    if (user.marActual !== null) return // si estás de viaje, no regenerás así
    if (user.hp >= user.maxHp) { user.lastVueltaTierra = Date.now(); return }
    const minutos = (Date.now() - user.lastVueltaTierra) / 60000
    const regen = Math.floor(minutos * REGEN_HP_TIERRA_POR_MIN)
    if (regen > 0) {
        user.hp = Math.min(user.maxHp, user.hp + regen)
        user.lastVueltaTierra = Date.now()
    }
}

// ========== EVENTOS ALEATORIOS DE EXPEDICIÓN (mar/isla) — GDD de exploración ==========
// Se disparan con cierta probabilidad al usar .explorar, en vez del farmeo tranquilo de siempre.
const EVENTOS_EXPEDICION = [
    {
        id: 'piratas', nombre: 'Emboscada Pirata',
        ejecutar: (user, isla) => {
            const dañoBase = 15 + Math.floor(Math.random() * 16)
            const conFruta = Math.random() < 0.20
            const daño = conFruta ? dañoBase + 15 : dañoBase
            user.hp = Math.max(1, user.hp - daño)
            let texto = `🏴‍☠️ *Emboscada Pirata* en ${isla.nombre}. Te atacan y perdés *${daño}* HP.`
            if (conFruta) texto += `\n⚠️ ¡Uno de ellos tenía poderes de una fruta! El golpe dolió el doble de lo normal.`
            return texto
        }
    },
    {
        id: 'kraken', nombre: 'Kraken Menor',
        ejecutar: (user, isla) => {
            const ganaste = Math.random() < 0.5
            if (ganaste) {
                const premio = Math.floor(Math.random() * 120) + 80
                user.coins += premio; user.lifetimeCoinsEarned += premio
                user.krakensVencidos = (user.krakensVencidos || 0) + 1
                return `🐙 Un *Kraken Menor* emerge cerca de ${isla.nombre}. Decidís plantarte y pelear... ¡y ganás! Entre sus restos encontrás *$${premio}* monedas.`
            } else {
                const daño = 25 + Math.floor(Math.random() * 20)
                user.hp = Math.max(1, user.hp - daño)
                if (user.hp <= user.maxHp * 0.2) user.sobrevivioCritico = true
                return `🐙 Un *Kraken Menor* te sorprende cerca de ${isla.nombre}. La pelea sale mal: perdés *${daño}* HP escapando a duras penas.`
            }
        }
    },
    {
        id: 'bestia', nombre: 'Bestia de la Isla',
        ejecutar: (user, isla) => {
            const daño = 10 + Math.floor(Math.random() * 15)
            user.hp = Math.max(1, user.hp - daño)
            user.debuffExpedicionStat = ['str', 'def', 'agi', 'int'][Math.floor(Math.random() * 4)]
            user.debuffExpedicionExpira = Date.now() + 15 * 60 * 1000
            return `🐺 Una bestia salvaje de ${isla.nombre} te ataca. Perdés *${daño}* HP y quedás con *${user.debuffExpedicionStat.toUpperCase()} reducido* por 15 minutos (herida leve).`
        }
    },
    {
        id: 'naufragio', nombre: 'Naufragio en la Costa',
        ejecutar: (user, isla) => {
            const perdido = Math.min(user.coins, Math.floor(Math.random() * 100) + 40)
            user.coins -= perdido
            return `🌊 Restos de un naufragio te arrastran. En el caos, perdés *${perdido}* monedas que se hunden con la marea.`
        }
    },
    {
        id: 'contrabandistas', nombre: 'Emboscada de Contrabandistas',
        ejecutar: (user, isla) => {
            const perdido = Math.min(user.coins, Math.floor(Math.random() * 80) + 30)
            user.coins -= perdido
            user.debuffExpedicionStat = ['str', 'def', 'agi', 'int'][Math.floor(Math.random() * 4)]
            user.debuffExpedicionExpira = Date.now() + 10 * 60 * 1000
            return `🗡️ Contrabandistas te asaltan en ${isla.nombre}. Te quitan *${perdido}* monedas y en el forcejeo te dejan con *${user.debuffExpedicionStat.toUpperCase()} reducido* por 10 minutos.`
        }
    },
    {
        id: 'corriente', nombre: 'Corriente Traicionera',
        ejecutar: (user, isla) => {
            const daño = 10 + Math.floor(Math.random() * 10)
            user.hp = Math.max(1, user.hp - daño)
            return `🌊 Una corriente traicionera te revuelca contra las rocas de ${isla.nombre}. Perdés *${daño}* HP, sin nada a cambio.`
        }
    },
    {
        id: 'comerciante', nombre: 'Comerciante Errante',
        ejecutar: (user, isla) => {
            const items = ITEMS_CONSUMIBLES.filter(i => !i.precioGemas)
            const item = items[Math.floor(Math.random() * items.length)]
            user.inventory.push(item.nombre)
            return `🧳 Te cruzás con un comerciante errante en ${isla.nombre}. Te regala un *${item.nombre}* de muestra gratis.`
        }
    },
    {
        id: 'cofre', nombre: 'Cofre Escondido',
        ejecutar: (user, isla) => {
            const base = Math.floor(Math.random() * 150) + 100
            const { premio, rareza, esRaro, emoji } = tirarRecompensaVariable(base)
            user.coins += premio; user.lifetimeCoinsEarned += premio
            return esRaro
                ? `📦 Encontrás un *cofre escondido* enterrado en ${isla.nombre}... ${emoji} *¡ES ${rareza.toUpperCase()}!* Adentro hay *$${premio}* monedas.`
                : `📦 Encontrás un *cofre escondido* enterrado en ${isla.nombre}. Adentro hay *$${premio}* monedas.`
        }
    }
]
const PROB_EVENTO_EXPEDICION = 0.35 // % de que salga un evento en vez del farmeo tranquilo

// ========== WOLFRIC PROTOCOL: MERCADO DE JUGADORES ==========
// Los jugadores pueden vender frutas e ítems directamente a otros, sin necesidad de negociar como en .trade.
// Mientras el objeto está en venta, se retira de la colección/inventario del vendedor (no se puede usar hasta que se cancele o se venda).
const mercadoJugadores = new Map() // id -> { vendedorJid, tipo: 'fruta'|'item', nombre, categoria, precio, timestamp }
let mercadoIdCounter = 1

// ========== WOLFRIC PROTOCOL: COMPRADOR CERCANO ==========
// Un NPC que compra frutas e ítems al instante, sin esperar a otro jugador — pero a precio bajo (no es un buen negocio,
// es para descartar duplicados o cosas que no usás por monedas rápidas).
const PRECIOS_COMPRADOR_FRUTA = { comun: 150, rara: 400, epica: 900, mitica: 2500, divina: 8000, evento: 500 }
function precioCompradorFruta(categoria) { return PRECIOS_COMPRADOR_FRUTA[categoria] || 150 }
function precioCompradorItem(itemCat) {
    const base = itemCat ? (itemCat.precioGemas || itemCat.precio || 500) : 300
    return Math.max(20, Math.floor(base * 0.30))
}

// ========== WOLFRIC PROTOCOL: ROOT ACCESS ==========
const overdriveActivo = new Set() // jids en modo Protocolo Overdrive
let pvpDeshabilitado = false

// ========== WOLFRIC PROTOCOL: TÍTULOS ==========
// Solo los marcados con auto:true se otorgan automáticamente. El resto los otorga el dueño con .granttitle
const TITULOS = [
    // ---- Combate y PvP ----
    { nombre: 'Primera Sangre', logro: 'Ganar tu primer duelo PvP', comando: 'provocar', auto: true, check: u => u.wins >= 1 },
    { nombre: 'Gladiador Neón', logro: 'Ganar 50 duelos PvP', comando: 'arena_stats', auto: true, check: u => u.wins >= 50 },
    { nombre: 'Asesino Implacable', logro: 'Ganar un duelo PvP en menos de 3 turnos', comando: 'ejecutar', auto: true, check: u => u.ganoDueloRapido === true },
    { nombre: 'Intocable', logro: 'Ganar un duelo sin recibir nada de daño', comando: 'espejismo', auto: true, check: u => u.ganoDueloSinDaño === true },
    { nombre: 'Cazador de Cabezas', logro: 'Derrotar a 10 jugadores de rango Leyenda o superior — otorgado por el dueño', comando: 'bounty', auto: false },
    // ---- Economía y Gacha ----
    { nombre: 'Apostador Compulsivo', logro: 'Gastar $100,000 en el Gacha de Frutas', comando: 'apuesta_alta', auto: true, check: u => u.fruitGachaSpent >= 100000 },
    { nombre: 'Magnate del Cripto', logro: 'Acumular 1,000,000 de monedas ganadas en total', comando: 'lluviamonedas', auto: true, check: u => u.lifetimeCoinsEarned >= 1000000 },
    { nombre: 'El Suertudo', logro: 'Sacar 2 frutas Míticas en menos de 10 tiradas — otorgado por el dueño', comando: 'bendecir', auto: false },
    { nombre: 'Traficante de Datos', logro: 'Completar 50 trades exitosos', comando: 'mercado_negro', auto: true, check: u => u.tradesCompleted >= 50 },
    { nombre: 'Bancarrota', logro: 'Quedarte exactamente con 0 monedas', comando: 'mendigar', auto: true, check: u => u.coins === 0 },
    // ---- Frutas y Poderes ----
    { nombre: 'El Tóxico', logro: 'Usar la fruta Veneno 100 veces', comando: 'contaminar', auto: true, check: u => (u.contadorHabilidades?.['Veneno'] || 0) >= 100 },
    { nombre: 'Señor del Magma', logro: 'Matar 20 enemigos usando daño de quemadura — otorgado por el dueño', comando: 'erupcion', auto: false },
    { nombre: 'Maestro del Tiempo', logro: 'Usar la Ultimate "Paradoja Temporal" de la fruta Tiempo 10 veces', comando: 'alterar_tiempo', auto: true, check: u => (u.contadorHabilidades?.['Tiempo_ultimate'] || 0) >= 10 },
    { nombre: 'Despertado', logro: 'Conseguir cualquier fruta de rareza Divina', comando: 'aura_secreta', auto: true, check: u => u.obtuvoSecreta === true },
    { nombre: 'Coleccionista', logro: 'Haber tenido al menos una vez todas las frutas Comunes y Raras', comando: 'tasar', auto: true, check: u => [...FRUTAS.comun.nombres, ...FRUTAS.rara.nombres].every(f => (u.frutasObtenidas || []).includes(f)) },
    // ---- Jefes Globales (PvE) ----
    { nombre: 'Slayer Abisal', logro: 'MVP contra un Boss Global — otorgado por el dueño', comando: 'intimidar', auto: false },
    { nombre: 'El Oportunista', logro: 'Dar el golpe de gracia a un Boss Global — otorgado por el dueño', comando: 'saquear', auto: false },
    { nombre: 'Escudo Humano', logro: 'Recibir más de 10,000 de daño acumulado de un Boss y sobrevivir — otorgado por el dueño', comando: 'provocar_boss', auto: false },
    { nombre: 'Estratega de Gremio', logro: 'Participar en 10 muertes de Bosses estando en un gremio — otorgado por el dueño', comando: 'buff_gremial', auto: false },
    { nombre: 'Sobreviviente', logro: 'Quedar a 1 HP después del ataque de un Boss — otorgado por el dueño', comando: 'adrenalina_pura', auto: false },
    // ---- Interacción y Rol (Sociales) ----
    { nombre: 'Spammer Neón', logro: 'Usar comandos del bot 1,000 veces', comando: 'flood_visual', auto: true, check: u => u.comandosUsados >= 1000 },
    { nombre: 'El Silencioso', logro: 'Subir a nivel 20 sin usar el chat general, solo comandos por DM — otorgado por el dueño', comando: 'sombras', auto: false },
    { nombre: 'Hacker de Sistema', logro: 'Descubrir un comando oculto o Easter Egg — otorgado por el dueño', comando: 'override', auto: false },
    { nombre: 'VIP del Club', logro: 'Comprar el pase premium o donar al creador — otorgado por el dueño', comando: 'vip_lounge', auto: false },
    { nombre: 'Dictador del Chat', logro: 'Ser Administrador del grupo y tener nivel 50+', comando: 'decreto_supremo', auto: true, check: u => u.fueAdminConNivel50 === true },
    { nombre: 'El Sabio', logro: 'Jugar activamente durante 6 meses', comando: 'oraculo', auto: true, check: u => (Date.now() - (u.primeraInteraccion || Date.now())) >= 182 * 24 * 60 * 60 * 1000 },
    { nombre: 'Traicionero', logro: 'Abandonar un gremio e inmediatamente unirte a otro', comando: 'infiltrar', auto: true, check: u => u.hizoTraicionGremio === true },
    { nombre: 'Filántropo', logro: 'Regalar más de $50,000 monedas a otros', comando: 'beca', auto: true, check: u => u.totalGifted >= 50000 },
    { nombre: 'Glitch Viviente', logro: 'Obtener una fruta Secreta duplicada — otorgado por el dueño', comando: 'crashear_matrix', auto: false },
    { nombre: 'Dios de Wolfric', logro: 'Nivel máximo (100), todas las frutas y estilo Godhuman — otorgado por el dueño', comando: 'juicio_final', auto: false },
    { nombre: 'Arquitecto Caído', logro: 'Ex-creador de Wolfric. El Protocolo recuerda su firma.', comando: 'legado', auto: false },
    // ---- Nuevos (actualización de Bounty, Racha, Mazmorras, Estilos y Ruleta) ----
    { nombre: 'Cazarrecompensas', logro: 'Alcanzar $5,000 de Bounty', comando: 'marcar', auto: true, check: u => u.bounty >= 5000 },
    { nombre: 'Racha Imparable', logro: 'Ganar 10 duelos PvP seguidos sin perder', comando: 'frenesi', auto: true, check: u => u.rachaMejor >= 10 },
    { nombre: 'Maestro de las Mazmorras', logro: 'Completar 20 mazmorras', comando: 'titan_dungeon', auto: true, check: u => u.mazmorrasCompletadas >= 20 },
    { nombre: 'Cazador de Bestias', logro: 'Cazar 200 monstruos salvajes', comando: 'instinto_salvaje', auto: true, check: u => u.monstruosCazados >= 200 },
    { nombre: 'Maestría Total', logro: 'Aprender los 13 estilos de combate', comando: 'maestria_total', auto: true, check: u => (u.estilosComprados || []).length >= ESTILOS_COMBATE.length },
    { nombre: 'Fusión Perfecta', logro: 'Despertar 5 frutas distintas', comando: 'resonancia', auto: true, check: u => (u.frutasPoseidas || []).filter(f => f.despertada).length >= 5 },
    { nombre: 'Duelista Legendario', logro: 'Ganar 200 duelos PvP', comando: 'legado', auto: true, check: u => u.wins >= 200 },
    { nombre: 'Compañero de Equipo', logro: 'Ganar 20 combates 2vs2', comando: 'sincronia', auto: true, check: u => u.victorias2v2 >= 20 },
    { nombre: 'Golpe de Suerte', logro: 'Ganar el premio mayor de la Ruleta (una fruta Mítica)', comando: 'jackpot', auto: true, check: u => u.ganoRuletaMitica === true },
    { nombre: 'Arquitecto en Ascenso', logro: 'Alcanzar el nivel 75', comando: 'ascension', auto: true, check: u => u.level >= 75 },
    { nombre: 'Amistad Inquebrantable', logro: 'Jugar 15 duelos 2vs2', comando: 'lazo_eterno', auto: true, check: u => (u.partidas2v2Jugadas || 0) >= 15 }
]
// Los comandos-título (provocar, arena_stats, etc.) también son parte del juego — se
// suman a la categoría "rpg" de .desactivar ahora que TITULOS ya está definido.
CATEGORIAS_COMANDOS.rpg.push(...TITULOS.map(t => t.comando))

function revisarTitulosAutomaticos(user, jid) {
    const nuevos = []
    for (const t of TITULOS) {
        if (t.auto && t.check(user) && !user.titles.includes(t.nombre)) {
            user.titles.push(t.nombre)
            nuevos.push(t.nombre)
        }
    }
    const nuevosLogros = revisarLogrosAutomaticos(user)
    nuevosLogros.forEach(nombreLogro => nuevos.push(`🏅 ${nombreLogro} (logro)`))
    return nuevos
}

// ========== WOLFRIC PROTOCOL: LOGROS (separado de los Títulos) ==========
// Los Títulos se equipan y dan comandos especiales. Los Logros son simples: se desbloquean, se guardan
// en el perfil y se pueden consultar con .logros. No dan un comando, dan una mini recompensa al desbloquearse.
const LOGROS = [
    // ---- Comienzos ----
    { nombre: 'Un gran comienzo', seccion: 'Comienzos', como: 'Registrarte con .crearperfil', auto: false, premio: '(ya la recibiste al registrarte)' },
    { nombre: 'Primeros Pasos', seccion: 'Comienzos', como: 'Llegar a nivel 5', auto: true, check: u => u.level >= 5, premio: '$200' , premioCoins: 200, premioGemas: 0 },
    { nombre: 'Aprendiz de Combate', seccion: 'Comienzos', como: 'Ganar tu primer duelo PvP', auto: true, check: u => u.wins >= 1, premio: '$200' , premioCoins: 200, premioGemas: 0 },
    // ---- Combate ----
    { nombre: 'Algunos sobreviven', seccion: 'Combate', como: 'Ganar 5 duelos PvP', auto: true, check: u => u.wins >= 5, premio: '$300' , premioCoins: 300, premioGemas: 0 },
    { nombre: 'Otro no', seccion: 'Combate', como: 'Perder 5 duelos PvP', auto: true, check: u => (u.derrotas || 0) >= 5, premio: '$150' , premioCoins: 150, premioGemas: 0 },
    { nombre: 'Veterano de Guerra', seccion: 'Combate', como: 'Participar en 50 duelos PvP (ganados o perdidos)', auto: true, check: u => (u.wins + (u.derrotas || 0)) >= 50, premio: '$800' , premioCoins: 800, premioGemas: 0 },
    { nombre: 'Duelista Legendario', seccion: 'Combate', como: 'Ganar 100 duelos PvP', auto: true, check: u => u.wins >= 100, premio: '$1500' , premioCoins: 1500, premioGemas: 0 },
    { nombre: 'Racha Encendida', seccion: 'Combate', como: 'Conseguir una racha de 5 victorias seguidas', auto: true, check: u => (u.rachaMejor || 0) >= 5, premio: '$400' , premioCoins: 400, premioGemas: 0 },
    { nombre: 'Compañero de Equipo', seccion: 'Combate', como: 'Ganar 10 combates 2vs2', auto: true, check: u => (u.victorias2v2 || 0) >= 10, premio: '$500' , premioCoins: 500, premioGemas: 0 },
    { nombre: 'Amistad Inquebrantable', seccion: 'Combate', como: 'Jugar 15 duelos 2vs2 (ganes o pierdas)', auto: true, check: u => (u.partidas2v2Jugadas || 0) >= 15, premio: '$500' , premioCoins: 500, premioGemas: 0 },
    // ---- Economía ----
    { nombre: 'Ahorrista', seccion: 'Economía', como: 'Tener $10,000 monedas al mismo tiempo', auto: true, check: u => u.coins >= 10000, premio: '💎 50 gemas' , premioCoins: 0, premioGemas: 50 },
    { nombre: 'Magnate', seccion: 'Economía', como: 'Ganar $500,000 monedas acumuladas', auto: true, check: u => (u.lifetimeCoinsEarned || 0) >= 500000, premio: '💎 200 gemas' , premioCoins: 0, premioGemas: 200 },
    { nombre: 'Comerciante', seccion: 'Economía', como: 'Completar al menos 1 trade o venta', auto: true, check: u => (u.tradesCompleted || 0) >= 1, premio: '$300' , premioCoins: 300, premioGemas: 0 },
    // ---- Frutas y Poderes ----
    { nombre: 'Coleccionista', seccion: 'Frutas y Poderes', como: 'Poseer 10 frutas distintas al mismo tiempo', auto: true, check: u => (u.frutasPoseidas || []).length >= 10, premio: '$500' , premioCoins: 500, premioGemas: 0 },
    { nombre: 'Coleccionista Mayor', seccion: 'Frutas y Poderes', como: 'Poseer 20 frutas distintas al mismo tiempo', auto: true, check: u => (u.frutasPoseidas || []).length >= 20, premio: '$1500' , premioCoins: 1500, premioGemas: 0 },
    { nombre: 'Despierto', seccion: 'Frutas y Poderes', como: 'Despertar tu primera fruta', auto: true, check: u => (u.frutasPoseidas || []).some(f => f.despertada), premio: '$300' , premioCoins: 300, premioGemas: 0 },
    { nombre: 'Fusión Perfecta', seccion: 'Frutas y Poderes', como: 'Despertar 5 frutas distintas', auto: true, check: u => (u.frutasPoseidas || []).filter(f => f.despertada).length >= 5, premio: '$1000' , premioCoins: 1000, premioGemas: 0 },
    // ---- Mazmorras y Exploración ----
    { nombre: 'Explorador de Mazmorras', seccion: 'Mazmorras y Exploración', como: 'Completar 3 mazmorras', auto: true, check: u => (u.mazmorrasCompletadas || 0) >= 3, premio: '$400' , premioCoins: 400, premioGemas: 0 },
    { nombre: 'Maestro de las Mazmorras', seccion: 'Mazmorras y Exploración', como: 'Completar 20 mazmorras', auto: true, check: u => (u.mazmorrasCompletadas || 0) >= 20, premio: '$2000' , premioCoins: 2000, premioGemas: 0 },
    { nombre: 'Cazador de Monstruos', seccion: 'Mazmorras y Exploración', como: 'Cazar 10 monstruos salvajes del chat', auto: true, check: u => (u.monstruosCazados || 0) >= 10, premio: '$200' , premioCoins: 200, premioGemas: 0 },
    { nombre: 'Cazador de Monstruos Nivel 2', seccion: 'Mazmorras y Exploración', como: 'Cazar 50 monstruos salvajes del chat', auto: true, check: u => (u.monstruosCazados || 0) >= 50, premio: '$600' , premioCoins: 600, premioGemas: 0 },
    { nombre: 'Cazador de Monstruos Nivel 3', seccion: 'Mazmorras y Exploración', como: 'Cazar 200 monstruos salvajes del chat', auto: true, check: u => (u.monstruosCazados || 0) >= 200, premio: '$2000' , premioCoins: 2000, premioGemas: 0 },
    { nombre: 'Navegante', seccion: 'Mazmorras y Exploración', como: 'Viajar a un mar por primera vez', auto: true, check: u => u.haViajado === true, premio: '$300' , premioCoins: 300, premioGemas: 0 },
    { nombre: 'Cazador de Tesoros', seccion: 'Mazmorras y Exploración', como: 'Usar .explorar 20 veces en las islas', auto: true, check: u => (u.explorarUsos || 0) >= 20, premio: '$500' , premioCoins: 500, premioGemas: 0 },
    // ---- Social ----
    { nombre: 'Fundador', seccion: 'Social', como: 'Crear un gremio', auto: false, premio: '(ya la recibiste al crear tu gremio)' },
    { nombre: 'Compañerismo', seccion: 'Social', como: 'Unirte a un gremio', auto: false, premio: '(ya la recibiste al unirte)' },
    { nombre: 'Maestría Total', seccion: 'Social', como: 'Aprender los 13 estilos de combate', auto: true, check: u => (u.estilosComprados || []).length >= ESTILOS_COMBATE.length, premio: '$1000' , premioCoins: 1000, premioGemas: 0 },
    { nombre: 'Golpe de Suerte', seccion: 'Social', como: 'Ganar el premio mayor de la Ruleta (una fruta Mítica)', auto: true, check: u => u.ganoRuletaMitica === true, premio: '💎 100 gemas' , premioCoins: 0, premioGemas: 100 },
    { nombre: 'Arquitecto en Ascenso', seccion: 'Social', como: 'Alcanzar el nivel 75', auto: true, check: u => u.level >= 75, premio: '💎 100 gemas' , premioCoins: 0, premioGemas: 100 },
    // ---- Exploración marítima y frutas revolucionarias ----
    { nombre: 'Superviviente del Mar', seccion: 'Mazmorras y Exploración', como: 'Sobrevivir a un evento de expedición con HP crítica', auto: true, check: u => u.sobrevivioCritico === true, premio: '$300', premioCoins: 300, premioGemas: 0 },
    { nombre: 'Cazador de Krakens', seccion: 'Mazmorras y Exploración', como: 'Vencer 3 Krakens Menores en expediciones', auto: true, check: u => (u.krakensVencidos || 0) >= 3, premio: '$500', premioCoins: 500, premioGemas: 0 },
    { nombre: 'Alma Errante', seccion: 'Mazmorras y Exploración', como: 'Volver a la Isla Principal 10 veces', auto: true, check: u => (u.vecesVolvioTierra || 0) >= 10, premio: '$300', premioCoins: 300, premioGemas: 0 },
    { nombre: 'Mente Revolucionaria', seccion: 'Frutas y Poderes', como: 'Tener equipada alguna de las 10 frutas revolucionarias nuevas', auto: true, check: u => ['Deuda', 'Espejismo', 'Apuesta', 'Trueque', 'Balanza', 'Grieta', 'Bucle', 'Simbiosis', 'Sacrificio', 'Copia Copia'].includes(u.fruitEquipada), premio: '$500', premioCoins: 500, premioGemas: 0 },
    { nombre: 'Doctor de Combate', seccion: 'Combate', como: 'Usar un Antídoto Universal o Kit de Primeros Auxilios', auto: true, check: u => (u.itemsCurativosUsados || 0) >= 1, premio: '$200', premioCoins: 200, premioGemas: 0 },
    { nombre: 'Maestro de la Apuesta', seccion: 'Frutas y Poderes', como: 'Usar la habilidad de la fruta Apuesta 10 veces', auto: true, check: u => (u.contadorHabilidades?.['Apuesta'] || 0) >= 10, premio: '$400', premioCoins: 400, premioGemas: 0 },
    { nombre: 'Simbionte', seccion: 'Frutas y Poderes', como: 'Usar la habilidad de la fruta Simbiosis', auto: true, check: u => (u.contadorHabilidades?.['Simbiosis'] || 0) >= 1, premio: '$300', premioCoins: 300, premioGemas: 0 },
    { nombre: 'Copión Maestro', seccion: 'Frutas y Poderes', como: 'Usar la habilidad de la fruta Copia Copia 5 veces', auto: true, check: u => (u.contadorHabilidades?.['Copia Copia'] || 0) >= 5, premio: '$500', premioCoins: 500, premioGemas: 0 },
    // ---- Comunidad (referidos, torneo) ----
    { nombre: 'Reclutador', seccion: 'Social', como: 'Conseguir 3 referidos exitosos con tu código', auto: true, check: u => (u.referidosExitosos || 0) >= 3, premio: '$500', premioCoins: 500, premioGemas: 0 },
    { nombre: 'Campeón del Torneo', seccion: 'Combate', como: 'Ganar un torneo del grupo', auto: true, check: u => (u.torneosGanados || 0) >= 1, premio: '💎 50 gemas', premioCoins: 0, premioGemas: 50 },
    // ---- El cierre ----
    { nombre: 'Un gran comienzo conlleva a un gran final', seccion: 'Final', como: 'Desbloquear TODOS los demás logros', auto: true, check: u => LOGROS.filter(l => l.nombre !== 'Un gran comienzo conlleva a un gran final').every(l => (u.logrosDesbloqueados || []).includes(l.nombre)), premio: '💎 500 gemas + título especial' , premioCoins: 0, premioGemas: 500 }
]

function revisarLogrosAutomaticos(user) {
    const nuevos = []
    for (const l of LOGROS) {
        if (l.auto && l.check(user) && !user.logrosDesbloqueados.includes(l.nombre)) {
            user.logrosDesbloqueados.push(l.nombre)
            if (l.premioCoins) { user.coins += l.premioCoins; user.lifetimeCoinsEarned += l.premioCoins }
            if (l.premioGemas) user.gems += l.premioGemas
            nuevos.push(l.nombre)
        }
    }
    return nuevos
}

// ========== WOLFRIC PROTOCOL: MISIONES (20 en total — 12 diarias + 8 semanales, rotativas) ==========
// Cada misión mide el AVANCE de un campo acumulativo desde que se asignó (no el total histórico).
const RECOMPENSA_POR_DIFICULTAD = {
    facil: { coins: 100, exp: 10, bounty: 0, gemas: 0 },
    media: { coins: 300, exp: 25, bounty: 5, gemas: 0 },
    dificil: { coins: 700, exp: 50, bounty: 10, gemas: 0 },
    extrema: { coins: 1500, exp: 100, bounty: 30, gemas: 20 }
}
const MISIONES_DIARIAS = [
    { id: 'd1', nombre: 'Calentando motores', desc: 'Ganá 1 duelo PvP', campo: 'wins', meta: 1, dificultad: 'facil' },
    { id: 'd2', nombre: 'De cacería', desc: 'Cazá 3 monstruos salvajes del chat', campo: 'monstruosCazados', meta: 3, dificultad: 'facil' },
    { id: 'd3', nombre: 'Turista de islas', desc: 'Explorá 2 veces en las islas', campo: 'explorarUsos', meta: 2, dificultad: 'facil' },
    { id: 'd4', nombre: 'Activo en el chat', desc: 'Usá 10 comandos del bot', campo: 'comandosUsados', meta: 10, dificultad: 'facil' },
    { id: 'd5', nombre: 'Trabajo en equipo', desc: 'Ganá 1 combate 2vs2', campo: 'victorias2v2', meta: 1, dificultad: 'media' },
    { id: 'd6', nombre: 'Compañeros de armas', desc: 'Jugá 2 duelos 2vs2 (ganes o pierdas)', campo: 'partidas2v2Jugadas', meta: 2, dificultad: 'facil' },
    { id: 'd7', nombre: 'A la mazmorra', desc: 'Completá 1 mazmorra', campo: 'mazmorrasCompletadas', meta: 1, dificultad: 'media' },
    { id: 'd8', nombre: 'Vuelta a casa', desc: 'Volvé a la Isla Principal 2 veces', campo: 'vecesVolvioTierra', meta: 2, dificultad: 'facil' },
    { id: 'd9', nombre: 'Primeros auxilios', desc: 'Usá un ítem curativo', campo: 'itemsCurativosUsados', meta: 1, dificultad: 'facil' },
    { id: 'd10', nombre: 'Racha del día', desc: 'Ganá 3 duelos PvP', campo: 'wins', meta: 3, dificultad: 'media' },
    { id: 'd11', nombre: 'Cazador de Krakens', desc: 'Vencé un Kraken Menor en una expedición', campo: 'krakensVencidos', meta: 1, dificultad: 'dificil' },
    { id: 'd12', nombre: 'Inversor del día', desc: 'Hacé al menos 1 tirada de gacha de frutas', campo: 'fruitGachaSpent', meta: COSTO_GACHA_FRUTA, dificultad: 'media' }
]
const MISIONES_SEMANALES = [
    { id: 's1', nombre: 'Semana de gloria', desc: 'Ganá 10 duelos PvP', campo: 'wins', meta: 10, dificultad: 'dificil' },
    { id: 's2', nombre: 'Exterminador', desc: 'Cazá 20 monstruos salvajes', campo: 'monstruosCazados', meta: 20, dificultad: 'media' },
    { id: 's3', nombre: 'Explorador incansable', desc: 'Explorá 15 veces en las islas', campo: 'explorarUsos', meta: 15, dificultad: 'media' },
    { id: 's4', nombre: 'Conquistador de mazmorras', desc: 'Completá 3 mazmorras', campo: 'mazmorrasCompletadas', meta: 3, dificultad: 'dificil' },
    { id: 's5', nombre: 'Dúo imparable', desc: 'Ganá 5 combates 2vs2', campo: 'victorias2v2', meta: 5, dificultad: 'dificil' },
    { id: 's6', nombre: 'Terror de los mares', desc: 'Vencé 3 Krakens Menores', campo: 'krakensVencidos', meta: 3, dificultad: 'dificil' },
    { id: 's7', nombre: 'Comerciante activo', desc: 'Completá 5 trades o ventas en el mercado', campo: 'tradesCompleted', meta: 5, dificultad: 'media' },
    { id: 's8', nombre: 'Semana productiva', desc: 'Acumulá $50,000 en monedas ganadas', campo: 'lifetimeCoinsEarned', meta: 50000, dificultad: 'extrema' }
]
const MISION_DIARIA_MS = 24 * 60 * 60 * 1000
const MISION_SEMANAL_MS = 7 * 24 * 60 * 60 * 1000

function elegirMisionesAlAzar(catalogo, cantidad) {
    const copia = [...catalogo]
    const elegidas = []
    for (let i = 0; i < cantidad && copia.length; i++) {
        const idx = Math.floor(Math.random() * copia.length)
        elegidas.push(copia.splice(idx, 1)[0])
    }
    return elegidas
}

// Asegura que el usuario tenga misiones asignadas y vigentes (las rota si vencieron)
function actualizarMisiones(user) {
    const ahora = Date.now()
    if (!user.misionesDiarias || ahora - (user.misionesDiariasAsignadas || 0) >= MISION_DIARIA_MS) {
        user.misionesDiarias = elegirMisionesAlAzar(MISIONES_DIARIAS, 3).map(m => ({ ...m, inicio: user[m.campo] || 0, reclamada: false }))
        user.misionesDiariasAsignadas = ahora
    }
    if (!user.misionesSemanales || ahora - (user.misionesSemanalesAsignadas || 0) >= MISION_SEMANAL_MS) {
        user.misionesSemanales = elegirMisionesAlAzar(MISIONES_SEMANALES, 2).map(m => ({ ...m, inicio: user[m.campo] || 0, reclamada: false }))
        user.misionesSemanalesAsignadas = ahora
    }
}

// Revisa el progreso y reclama automáticamente las misiones completas, devolviendo un texto de aviso
function reclamarMisionesCompletas(user) {
    const avisos = []
    for (const lista of [user.misionesDiarias, user.misionesSemanales]) {
        for (const m of lista) {
            if (m.reclamada) continue
            const progreso = (user[m.campo] || 0) - m.inicio
            if (progreso >= m.meta) {
                m.reclamada = true
                const r = RECOMPENSA_POR_DIFICULTAD[m.dificultad]
                user.coins += r.coins; user.lifetimeCoinsEarned += r.coins
                user.exp += r.exp
                user.bounty += r.bounty
                user.gems += r.gemas
                avisos.push(`✅ Misión completada: *${m.nombre}* → +$${r.coins}, +${r.exp} EXP${r.bounty ? `, +${r.bounty} Bounty` : ''}${r.gemas ? `, +${r.gemas} gemas` : ''}`)
            }
        }
    }
    return avisos
}



// ========== WOLFRIC FRONTIER: MUNDO TEXTUAL ==========
// Esta capa convive con los sistemas antiguos durante la migración. El objetivo es
// ofrecer una experiencia de exploración clara sin borrar frutas, mares ni PvP.
const encuentrosFrontierActivos = new Map() // chatId -> encuentro de región


// ========== WOLFRIC FRONTIER: GUARDIANES Y PRIMER SOBERANO ==========
const FRONTIER_SOBERANO_ARCHIVO = './frontier_soberano.json'
const frontierSoberanosActivos = new Map() // chatId -> encuentro grupal persistente
const FRONTIER_SOBERANO_DURACION_MS = 30 * 60 * 1000
const FRONTIER_MAX_PARTICIPANTES = 5

const FRONTIER_GUARDIANES = [
    {
        id: 'guardian-umbral', etapa: 1, nombre: 'Guardián del Umbral', region: 'llanuras-ceniza', nivel: 6,
        hp: 850, dano: 32, desc: 'Una armadura sin rostro que protege una ruta que no aparece en ningún mapa.',
        fases: ['El guardián analiza a los intrusos.', 'La armadura abre sus sellos y acelera el patrón de ataque.', 'El núcleo queda expuesto: cada golpe provoca una respuesta.'],
        recompensa: { coins: 650, exp: 45, bounty: 8, materiales: { fragmento_ceniza: 4 } }
    },
    {
        id: 'guardian-prisma', etapa: 2, nombre: 'Guardián Prismático', region: 'bosque-prismatico', nivel: 14,
        hp: 1650, dano: 50, desc: 'Una entidad de cristal que cambia de forma cada vez que alguien lee su patrón.',
        fases: ['El bosque refleja todas las siluetas.', 'El guardián divide su núcleo en tres trayectorias.', 'La luz converge en un único punto vulnerable.'],
        recompensa: { coins: 1200, exp: 85, bounty: 15, materiales: { seda_prisma: 6, fragmento_divino: 2 }, arte: 'lectura_patron' }
    },
    {
        id: 'soberano-ruptura', etapa: 3, nombre: 'Soberano de la Ruptura', region: 'ruinas-divinidad', nivel: 24,
        hp: 3600, dano: 78, desc: 'El primer Soberano no gobierna una especie: gobierna la anomalía que mantiene unido el mundo.',
        fases: ['El Soberano observa y no ataca.', 'La Ruina se pliega sobre sí misma.', 'La señal se rompe: cada acción cambia el campo de batalla.'],
        recompensa: { coins: 3000, exp: 220, bounty: 50, materiales: { fragmento_divino: 8, cristal_abismal: 2 }, arma: 'corona_soberano' }
    }
]

function frontierGuardarSoberanos() {
    try {
        fs.writeFileSync(FRONTIER_SOBERANO_ARCHIVO, JSON.stringify(Object.fromEntries(frontierSoberanosActivos), null, 2))
    } catch (e) { console.log('Error guardando encuentros del Primer Soberano:', e) }
}
function frontierCargarSoberanos() {
    try {
        if (!fs.existsSync(FRONTIER_SOBERANO_ARCHIVO)) return
        const datos = JSON.parse(fs.readFileSync(FRONTIER_SOBERANO_ARCHIVO, 'utf8'))
        const ahora = Date.now()
        for (const [chatId, encuentro] of Object.entries(datos || {})) {
            if (encuentro && encuentro.timestamp && ahora - encuentro.timestamp < FRONTIER_SOBERANO_DURACION_MS && encuentro.hp > 0) {
                frontierSoberanosActivos.set(chatId, encuentro)
            }
        }
        frontierGuardarSoberanos()
    } catch (e) { console.log('Error cargando encuentros del Primer Soberano:', e) }
}
function frontierSoberanoActivo(chatId) {
    const encuentro = frontierSoberanosActivos.get(chatId)
    if (!encuentro) return null
    if (!encuentro.timestamp || Date.now() - encuentro.timestamp >= FRONTIER_SOBERANO_DURACION_MS || encuentro.hp <= 0) {
        frontierSoberanosActivos.delete(chatId)
        frontierGuardarSoberanos()
        return null
    }
    if (!Array.isArray(encuentro.participantes)) encuentro.participantes = []
    return encuentro
}
function frontierEscenario(user, crear = false) {
    const f = frontierInicializar(user)
    let escenario = f.escenariosUnicos.find(e => e.id === 'primer-soberano')
    if (!escenario && crear) {
        escenario = {
            id: 'primer-soberano', nombre: 'La Señal del Primer Soberano', progreso: 1, meta: 3,
            etapa: 1, estado: 'activo', faseNarrativa: 'pista', decisionPendiente: false,
            decisiones: [], ultimaActualizacion: Date.now()
        }
        f.escenariosUnicos.push(escenario)
    }
    if (escenario) {
        if (!Number.isFinite(escenario.etapa)) escenario.etapa = Math.max(1, Math.min(3, escenario.progreso || 1))
        if (!escenario.estado) escenario.estado = 'activo'
        if (!Array.isArray(escenario.decisiones)) escenario.decisiones = []
        if (escenario.decisionPendiente === undefined) escenario.decisionPendiente = false
    }
    return escenario || null
}
function frontierGuardianPorEtapa(etapa) {
    return FRONTIER_GUARDIANES.find(g => g.etapa === Number(etapa)) || null
}
function frontierNombreParticipantes(encuentro) {
    return encuentro.participantes.length ? encuentro.participantes.map(p => `@${(p.jid || '').split('@')[0]}`).join(', ') : 'nadie'
}
function frontierSoberanoTexto(encuentro, lang = 'es') {
    const L = (es, pt, en) => tr(lang, es, pt, en)
    const guardian = FRONTIER_GUARDIANES.find(g => g.id === encuentro.guardianId)
    const faseTexto = lore(lang, guardian?.fases?.[Math.max(0, (encuentro.fase || 1) - 1)]) || L('El patrón del enemigo se vuelve ilegible.', 'O padrão do inimigo fica ilegível.', 'The enemy pattern turns unreadable.')
    const tipo = encuentro.tipo === 'soberano' ? L('𝗦𝗢𝗕𝗘𝗥𝗔𝗡𝗢 𝗣𝗥𝗜𝗠𝗢𝗥𝗗𝗜𝗔𝗟', '𝗦𝗢𝗕𝗘𝗥𝗔𝗡𝗢 𝗣𝗥𝗜𝗠𝗢𝗥𝗗𝗜𝗔𝗟', '𝗣𝗥𝗜𝗠𝗢𝗥𝗗𝗜𝗔𝗟 𝗦𝗢𝗩𝗘𝗥𝗘𝗜𝗚𝗡') : L('𝗚𝗨𝗔𝗥𝗗𝗜𝗔́𝗡 𝗗𝗘 𝗥𝗨𝗧𝗔', '𝗚𝗨𝗔𝗥𝗗𝗜𝗔̃𝗢 𝗗𝗘 𝗥𝗢𝗧𝗔', '𝗥𝗢𝗨𝗧𝗘 𝗚𝗨𝗔𝗥𝗗𝗜𝗔𝗡')
    const cabecera = frontierTitulo(tipo, guardian?.nombre || encuentro.nombre, encuentro.tipo === 'soberano' ? '👑' : '⚔️')
    const lectura = frontierPanel(L('𝗟𝗘𝗖𝗧𝗨𝗥𝗔 𝗗𝗘𝗟 𝗝𝗘𝗙𝗘', '𝗟𝗘𝗜𝗧𝗨𝗥𝗔 𝗗𝗢 𝗖𝗛𝗘𝗙𝗘', '𝗕𝗢𝗦𝗦 𝗥𝗘𝗔𝗗𝗢𝗨𝗧'), [
        `📍 ${L('Región', 'Região', 'Region')}: ${guardian?.region || encuentro.region}`,
        `⚔️ ${L('Nivel', 'Nível', 'Level')}: ${encuentro.nivel}`,
        `❤️ HP: ${Math.max(0, encuentro.hp)}/${encuentro.hpMax}`,
        `🔻 ${L('Fase', 'Fase', 'Phase')}: ${encuentro.fase}/3`,
        `👥 ${L('Equipo', 'Time', 'Team')}: ${frontierNombreParticipantes(encuentro)}`,
        `⏳ ${L('Tiempo', 'Tempo', 'Time')}: ${clockString(Math.max(0, FRONTIER_SOBERANO_DURACION_MS - (Date.now() - encuentro.timestamp)))}`
    ], '📡')
    const acciones = frontierPanel(L('𝗔𝗖𝗖𝗜𝗢𝗡𝗘𝗦 𝗗𝗘𝗟 𝗘𝗡𝗖𝗨𝗘𝗡𝗧𝗥𝗢', '𝗔𝗖̧𝗢̃𝗘𝗦 𝗗𝗢 𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢', '𝗘𝗡𝗖𝗢𝗨𝗡𝗧𝗘𝗥 𝗔𝗖𝗧𝗜𝗢𝗡𝗦'), [
        `📜 ${faseTexto}`,
        `⚔️ ${prefix}atacarfrontera · ${L('golpe físico', 'golpe físico', 'physical hit')}`,
        `✨ ${prefix}habilidadfrontera · ${L('Arte equipado', 'Arte equipada', 'equipped Art')}`,
        `🍎 ${prefix}frutafrontera · ${L('fruta equipada', 'fruta equipada', 'equipped fruit')}`,
        `🏃 ${prefix}huirfrontera · ${L('abandonar', 'abandonar', 'leave')}`
    ], '🎯')
    return `${cabecera}\n\n${lectura}\n\n${acciones}`
}
function frontierSoberanoAgregarParticipante(encuentro, jid, nombre) {
    const normal = normalizarJidGlobal(jid)
    if (encuentro.participantes.some(p => normalizarJidGlobal(p.jid) === normal)) return true
    if (encuentro.participantes.length >= FRONTIER_MAX_PARTICIPANTES) return false
    encuentro.participantes.push({ jid, nombre: nombre || 'Explorador', dano: 0, acciones: 0 })
    frontierGuardarSoberanos()
    return true
}
function frontierSoberanoFruta(user) {
    const fruta = frutaEquipadaObj(user)
    const catalogo = fruta ? HABILIDADES_FRUTA[fruta.nombre] : null
    return fruta && catalogo?.habilidad1 ? { fruta, habilidad: catalogo.habilidad1 } : null
}
function frontierSoberanoDanio(user, encuentro, modo = 'normal') {
    const f = frontierInicializar(user)
    const arma = frontierArma(user)
    const arte = f.artesEquipadas.map(id => FRONTIER_ARTES.find(a => a.id === id)).find(Boolean)
    const frutaKit = frontierSoberanoFruta(user)
    let dano = Math.max(1, user.stats.str + frontierArmaExtra(user, modo) + Math.floor(Math.random() * 18) + Math.floor(user.stats.agi / 8) + frontierConsumirBonusFase(user))
    if (modo === 'arte') {
        dano = Math.floor(dano * 1.55) + Math.floor(user.stats.int * 0.7)
        if (arte?.id === 'golpe_precision') dano += Math.floor(user.stats.int * 0.5)
        if (arte?.id === 'limite_frontal') dano = Math.floor(dano * 1.15)
    } else if (modo === 'fruta' && frutaKit) {
        dano = Math.floor(user.stats.int * 1.35) + (frutaKit.habilidad.poder || 0) + Math.floor(frontierArmaExtra(user, modo) * 0.35) + frontierConsumirBonusFase(user)
        const mult = frutaKit.habilidad.efectos?.find(e => e.tipo === 'dmg_mult')?.mult
        if (mult) dano = Math.floor(dano * mult)
        if (frutaKit.habilidad.efectos?.some(e => e.tipo === 'crit_asegurado')) dano = Math.floor(dano * 1.35)
        if (frutaKit.habilidad.efectos?.some(e => e.tipo === 'ignora_def_pct')) dano += Math.floor(user.stats.int * 0.25)
    }
    if (arte?.id === 'ruptura_guardian' && encuentro.nivel > user.level) dano = Math.floor(dano * 1.25)
    if (encuentro.fase === 3) dano = Math.floor(dano * 0.90)
    return Math.max(1, dano)
}
function frontierSoberanoAplicarFase(encuentro) {
    const proporcion = encuentro.hp / encuentro.hpMax
    let nueva = encuentro.fase
    if (encuentro.fase === 1 && proporcion <= 0.66) nueva = 2
    else if (encuentro.fase === 2 && proporcion <= 0.33) nueva = 3
    if (nueva === encuentro.fase) return null
    encuentro.fase = nueva
    return FRONTIER_GUARDIANES.find(g => g.id === encuentro.guardianId)?.fases[nueva - 1] || 'El patrón cambia.'
}
function frontierAplicarDecision(user, opcion) {
    const f = frontierInicializar(user)
    const escenario = frontierEscenario(user, true)
    if (!escenario.decisionPendiente) return { ok: false, texto: 'No tienes una decisión pendiente en este momento.' }
    const opciones = { observar: 'observar', romper: 'romper', sellar: 'sellar' }
    const eleccion = opciones[frontierNormalizar(opcion)]
    if (!eleccion) return { ok: false, texto: 'Opciones válidas: observar, romper o sellar.' }
    const etapaDecision = Math.max(1, escenario.etapa - 1)
    escenario.decisiones.push({ etapa: etapaDecision, opcion: eleccion, fecha: Date.now() })
    escenario.decisionPendiente = false
    escenario.faseNarrativa = `decision-${eleccion}`
    f.decisionesUnicas.push({ escenario: 'primer-soberano', etapa: etapaDecision, opcion: eleccion, fecha: Date.now() })
    let texto = ''
    if (eleccion === 'observar') {
        f.reputacion[escenario.etapa === 2 ? 'bosque-prismatico' : 'ruinas-divinidad'] = (f.reputacion[escenario.etapa === 2 ? 'bosque-prismatico' : 'ruinas-divinidad'] || 0) + 5
        f.pistas.push({ id: `patron-observado-${etapaDecision}`, texto: 'La señal responde a quien espera: el siguiente patrón aparece antes del siguiente combate.', fecha: Date.now() })
        texto = 'Has observado el patrón. Obtienes una pista adicional y +5 de reputación regional.'
    } else if (eleccion === 'romper') {
        user.coins += 450
        user.lifetimeCoinsEarned += 450
        user.bounty += 12
        texto = 'Has roto el sello. Recibes +$450 y +12 Bounty, pero la siguiente fase será más agresiva.'
    } else {
        f.artesDesbloqueadas = Array.isArray(f.artesDesbloqueadas) ? f.artesDesbloqueadas : []
        if (!f.artesDesbloqueadas.includes('paso_lateral')) f.artesDesbloqueadas.push('paso_lateral')
        texto = 'Has sellado la grieta. Desbloqueaste el Arte de Combate *Paso Lateral* sin pagar su coste.'
    }
    escenario.ultimaActualizacion = Date.now()
    guardarEconomia()
    return { ok: true, texto }
}
function frontierRecompensarVictoria(encuentro) {
    const guardian = FRONTIER_GUARDIANES.find(g => g.id === encuentro.guardianId)
    const avisos = []
    for (const participante of encuentro.participantes) {
        const user = getUsuario(participante.jid)
        const f = frontierInicializar(user, participante.nombre)
        const escenario = frontierEscenario(user, true)
        const recompensaId = `primer-soberano-${encuentro.etapa}`
        if (!f.recompensasUnicas.includes(recompensaId)) {
            f.guardianesDerrotados = Array.isArray(f.guardianesDerrotados) ? f.guardianesDerrotados : []
            if (!f.guardianesDerrotados.includes(encuentro.guardianId)) f.guardianesDerrotados.push(encuentro.guardianId)
            const r = guardian.recompensa
            user.coins += r.coins; user.lifetimeCoinsEarned += r.coins
            frontierDarExp(user, r.exp)
            user.bounty += r.bounty
            for (const [material, cantidad] of Object.entries(r.materiales || {})) f.materiales[material] = (f.materiales[material] || 0) + cantidad
            if (r.arte && !f.artesDesbloqueadas.includes(r.arte)) f.artesDesbloqueadas.push(r.arte)
            if (r.arma && !f.armasPoseidas.includes(r.arma)) f.armasPoseidas.push(r.arma)
            f.recompensasUnicas.push(recompensaId)
            if (encuentro.etapa < 3) {
                escenario.etapa = encuentro.etapa + 1
                escenario.progreso = escenario.etapa
                escenario.estado = 'decision'
                escenario.decisionPendiente = true
                escenario.faseNarrativa = 'esperando-decision'
            } else {
                escenario.etapa = 3; escenario.progreso = 3; escenario.estado = 'completado'
                escenario.decisionPendiente = false; escenario.faseNarrativa = 'soberano-derrotado'
            }
            escenario.ultimaActualizacion = Date.now()
            avisos.push(`@${participante.jid.split('@')[0]}: +$${r.coins}, +${r.exp} EXP, +${r.bounty} Bounty`)
        }
    }
    if (encuentro.etapa === 3 && encuentro.hp <= 0) frontierMundoRegistrarEvento('primer-soberano', encuentro)
    else if (encuentro.hp <= 0) frontierMundoRegistrarEvento('guardian', encuentro)
    return avisos
}
function frontierCrearSoberano(chatId, user, sender, pushName) {
    const escenario = frontierEscenario(user, false)
    if (!escenario || !user.frontier.pistas.some(p => p.id === 'señal-primer-soberano')) return { ok: false, texto: `Primero debes descubrir la señal. Explora una región con *${prefix}explorar <región>*.` }
    if (escenario.estado === 'completado') return { ok: false, texto: 'Ya completaste La Señal del Primer Soberano. El mundo recuerda tu victoria.' }
    if (escenario.decisionPendiente) return { ok: false, texto: `Tienes una decisión pendiente. Usa *${prefix}decidirfrontera observar*, *romper* o *sellar*.` }
    const guardian = frontierGuardianPorEtapa(escenario.etapa)
    if (!guardian) return { ok: false, texto: 'La cadena no tiene una etapa válida. Contacta al administrador.' }
    if (user.level < guardian.nivel) return { ok: false, texto: `El próximo desafío requiere nivel ${guardian.nivel}. Tu nivel actual es ${user.level}.` }
    const region = frontierRegion(guardian.region)
    if (!user.frontier.regionesDescubiertas.includes(guardian.region)) user.frontier.regionesDescubiertas.push(guardian.region)
    const encuentro = {
        id: `${guardian.id}-${Date.now()}`, tipo: guardian.etapa === 3 ? 'soberano' : 'guardian', guardianId: guardian.id,
        nombre: guardian.nombre, region: guardian.region, etapa: guardian.etapa, nivel: guardian.nivel,
        hp: guardian.hp, hpMax: guardian.hp, dano: guardian.dano, fase: 1, timestamp: Date.now(),
        iniciadoPor: sender, participantes: []
    }
    frontierSoberanosActivos.set(chatId, encuentro)
    frontierSoberanoAgregarParticipante(encuentro, sender, pushName)
    guardarEconomia(); frontierGuardarSoberanos()
    return { ok: true, texto: `${frontierTitulo(guardian.etapa === 3 ? '𝗦𝗢𝗕𝗘𝗥𝗔𝗡𝗢 𝗗𝗘𝗦𝗣𝗘𝗥𝗧𝗔𝗗𝗢' : '𝗚𝗨𝗔𝗥𝗗𝗜𝗔́𝗡 𝗗𝗘𝗦𝗕𝗟𝗢𝗤𝗨𝗘𝗔𝗗𝗢', guardian.nombre)}\n\n${guardian.desc}\n\n${frontierSoberanoTexto(encuentro, lang)}\n\nLos exploradores del grupo pueden unirse con *${prefix}unirsefrontera*.` }
}
frontierCargarSoberanos()

const REGIONES_FRONTIER = [
    { id: 'arca-inicial', nombre: 'Arca Inicial', nivelMin: 1, nivelMax: 5, icono: '🏙️',
      descripcion: 'Ciudad segura. Aquí se registran exploradores, se aceptan misiones y se prepara el equipo.' },
    { id: 'llanuras-ceniza', nombre: 'Llanuras de Ceniza', nivelMin: 3, nivelMax: 12, icono: '🌫️',
      descripcion: 'Una extensión gris donde las criaturas rápidas cazan a los recién llegados.' },
    { id: 'bosque-prismatico', nombre: 'Bosque Prismático', nivelMin: 8, nivelMax: 20, icono: '🌲',
      descripcion: 'Un bosque de rutas cambiantes, señales falsas y materiales de alta pureza.' },
    { id: 'ruinas-divinidad', nombre: 'Ruinas de la Divinidad', nivelMin: 15, nivelMax: 35, icono: '🏛️',
      descripcion: 'Restos de una civilización que dejó máquinas, guardianes y mensajes incompletos.' },
    { id: 'valle-eclipse', nombre: 'Valle del Eclipse', nivelMin: 25, nivelMax: 50, icono: '🌘',
      descripcion: 'La región cambia cuando cae la noche. Algunas rutas solo existen durante el eclipse.' },
    { id: 'abismo-invertido', nombre: 'Abismo Invertido', nivelMin: 40, nivelMax: 100, icono: '🌀',
      descripcion: 'Zona de riesgo extremo. Las reglas de combate y gravedad no son confiables.' }
]

const FRONTIER_MONSTRUOS = [
    { id: 'sabueso-ceniza', nombre: 'Sabueso de Ceniza', region: 'llanuras-ceniza', nivel: 5, hp: 170, dano: 18, drop: 'fragmento_ceniza', material: 'Fragmento de Ceniza', minDrop: 1, maxDrop: 3 },
    { id: 'dron-corrupto', nombre: 'Dron de Vigilancia Corrupto', region: 'llanuras-ceniza', nivel: 7, hp: 220, dano: 22, drop: 'nucleo_datos', material: 'Núcleo de Datos', minDrop: 1, maxDrop: 2 },
    { id: 'araña-prisma', nombre: 'Araña Prisma', region: 'bosque-prismatico', nivel: 12, hp: 360, dano: 30, drop: 'seda_prisma', material: 'Seda Prismática', minDrop: 1, maxDrop: 3 },
    { id: 'bestia-raiz', nombre: 'Bestia de Raíz', region: 'bosque-prismatico', nivel: 15, hp: 430, dano: 34, drop: 'madera_viva', material: 'Madera Viva', minDrop: 1, maxDrop: 2 },
    { id: 'centinela-divino', nombre: 'Centinela de la Divinidad', region: 'ruinas-divinidad', nivel: 24, hp: 680, dano: 46, drop: 'fragmento_divino', material: 'Fragmento Divino', minDrop: 1, maxDrop: 2 },
    { id: 'serpiente-lunar', nombre: 'Serpiente del Eclipse', region: 'valle-eclipse', nivel: 34, hp: 980, dano: 58, drop: 'escama_lunar', material: 'Escama Lunar', minDrop: 1, maxDrop: 2 },
    { id: 'anomalia-abismal', nombre: 'Anomalía del Abismo', region: 'abismo-invertido', nivel: 48, hp: 1500, dano: 78, drop: 'cristal_abismal', material: 'Cristal Abismal', minDrop: 1, maxDrop: 2 }
]

const FRONTIER_ARMAS = [
    { id: 'punos_novato', nombre: 'Puños de Novato', nivelMin: 1, atk: 0, material: null, cantidad: 0, rareza: 'Inicial', desc: 'El arma que nunca se rompe.' },
    { id: 'hoja_fragmentaria', nombre: 'Hoja Fragmentaria', nivelMin: 3, atk: 14, material: 'fragmento_ceniza', cantidad: 5, rareza: 'Común', desc: '+14 de ataque. Ligera y confiable.' },
    { id: 'guanteletes_prisma', nombre: 'Guanteletes Prisma', nivelMin: 10, atk: 28, material: 'seda_prisma', cantidad: 8, rareza: 'Rara', desc: '+28 de ataque. Aumentan el daño de AGI.' },
    { id: 'lanza_divinidad', nombre: 'Lanza de la Divinidad', nivelMin: 18, atk: 48, material: 'fragmento_divino', cantidad: 10, rareza: 'Épica', desc: '+48 de ataque. Diseñada para Guardianes.' },
    { id: 'arco_eclipse', nombre: 'Arco del Eclipse', nivelMin: 30, atk: 75, material: 'escama_lunar', cantidad: 12, rareza: 'Mítica', desc: '+75 de ataque. Su precisión mejora en regiones nocturnas.' },
    { id: 'nucleo_abismal', nombre: 'Núcleo del Abismo', nivelMin: 45, atk: 115, material: 'cristal_abismal', cantidad: 15, rareza: 'Única', desc: '+115 de ataque. Una pieza de tecnología imposible.' },
    { id: 'corona_soberano', nombre: 'Corona del Primer Soberano', nivelMin: 15, atk: 92, material: null, cantidad: 0, rareza: 'Única', desc: '+92 de ataque. Recompensa exclusiva de La Señal del Primer Soberano.' }
]

const FRONTIER_ARTES = [
    { id: 'corte_basico', nombre: 'Corte Básico', nivelMin: 1, costo: 0, desc: 'Ataque estable. No consume recursos.' },
    { id: 'paso_lateral', nombre: 'Paso Lateral', nivelMin: 5, costo: 350, desc: 'Aumenta la probabilidad de evitar el próximo contraataque.' },
    { id: 'golpe_precision', nombre: 'Golpe de Precisión', nivelMin: 10, costo: 700, desc: 'Convierte parte de TEC en daño adicional.' },
    { id: 'ruptura_guardian', nombre: 'Ruptura de Guardián', nivelMin: 18, costo: 1500, desc: 'Daño aumentado contra enemigos de nivel superior.' },
    { id: 'lectura_patron', nombre: 'Lectura de Patrón', nivelMin: 25, costo: 2500, desc: 'Revela una pista adicional al explorar zonas peligrosas.' },
    { id: 'limite_frontal', nombre: 'Límite Frontal', nivelMin: 40, costo: 5000, desc: 'Artes de alto riesgo para encuentros únicos.' }
]

// ========== WOLFRIC FRONTIER: CONTENIDO DE CIERRE ==========
const FRONTIER_NPCS = [
    { id: 'lira', nombre: 'Lira Voss', rol: 'Cartógrafa de anomalías', region: 'arca-inicial', nivelMin: 1, desc: 'Dibuja rutas que solo aparecen cuando una señal cambia de frecuencia.', dialogo: 'El mapa no está incompleto. Está esperando que alguien lo lea de la forma correcta.' },
    { id: 'ordo', nombre: 'Ordo-7', rol: 'Ingeniero de materiales', region: 'bosque-prismatico', nivelMin: 8, desc: 'Un técnico de núcleo que reconoce la pureza de cada material.', dialogo: 'Una buena arma no nace de la fuerza. Nace de saber qué no debe romperse.' },
    { id: 'seren', nombre: 'Seren Aster', rol: 'Archivista de las Ruinas', region: 'ruinas-divinidad', nivelMin: 15, desc: 'Custodia los registros de los Guardianes que fueron borrados del mapa.', dialogo: 'El mundo no castiga la curiosidad. Castiga entrar sin haber entendido el precio.' },
    { id: 'kael', nombre: 'Kael de la Frontera', rol: 'Explorador veterano', region: 'valle-eclipse', nivelMin: 25, desc: 'Acepta encargos de alto riesgo para quienes ya conocen el miedo.', dialogo: 'Si el cielo se apaga, no mires arriba. Mira las sombras que todavía se mueven.' }
]
const FRONTIER_MISIONES = [
    { id: 'lira-ruta-ceniza', npc: 'lira', nombre: 'La ruta que no figura', desc: 'Explora dos veces las Llanuras de Ceniza.', requisito: { tipo: 'explorar', region: 'llanuras-ceniza', cantidad: 2 }, repMin: 0, recompensa: { coins: 250, exp: 18, rep: { 'llanuras-ceniza': 3 }, materiales: { fragmento_ceniza: 2 } } },
    { id: 'ordo-pureza-prisma', npc: 'ordo', nombre: 'Pureza Prismática', desc: 'Reúne 8 unidades de Seda Prismática.', requisito: { tipo: 'material', material: 'seda_prisma', cantidad: 8 }, repMin: 3, recompensa: { coins: 500, exp: 35, rep: { 'bosque-prismatico': 5 }, materiales: { madera_viva: 2 } } },
    { id: 'seren-fragmento-divino', npc: 'seren', nombre: 'El fragmento que recuerda', desc: 'Forja la Lanza de la Divinidad.', requisito: { tipo: 'arma', arma: 'lanza_divinidad' }, repMin: 5, recompensa: { coins: 900, exp: 60, rep: { 'ruinas-divinidad': 8 }, arte: 'lectura_patron' } },
    { id: 'kael-umbral-eclipse', npc: 'kael', nombre: 'Cruzar el eclipse', desc: 'Derrota al Soberano de la Ruptura.', requisito: { tipo: 'guardian', guardian: 'soberano-ruptura' }, repMin: 10, recompensa: { coins: 1800, exp: 120, rep: { 'valle-eclipse': 10 }, materiales: { escama_lunar: 5 } } }
]
const FRONTIER_RECETAS = [
    { id: 'temple-ceniza', nombre: 'Temple de Ceniza', arma: 'hoja_fragmentaria', atkBonus: 8, nivelMin: 6, region: 'llanuras-ceniza', repMin: 2, material: 'fragmento_ceniza', cantidad: 8, costo: 180, desc: 'Refuerza la Hoja Fragmentaria y añade +8 ATK.' },
    { id: 'trama-prisma', nombre: 'Trama Prismática', arma: 'guanteletes_prisma', atkBonus: 12, nivelMin: 14, region: 'bosque-prismatico', repMin: 5, material: 'seda_prisma', cantidad: 12, costo: 420, desc: 'Estabiliza los Guanteletes Prisma y añade +12 ATK.' },
    { id: 'nucleo-divino', nombre: 'Núcleo Divino', arma: 'lanza_divinidad', atkBonus: 18, nivelMin: 22, region: 'ruinas-divinidad', repMin: 8, material: 'fragmento_divino', cantidad: 14, costo: 800, desc: 'Concentra un fragmento divino y añade +18 ATK.' },
    { id: 'cuerda-eclipse', nombre: 'Cuerda del Eclipse', arma: 'arco_eclipse', atkBonus: 25, nivelMin: 34, region: 'valle-eclipse', repMin: 10, material: 'escama_lunar', cantidad: 16, costo: 1300, desc: 'Alinea el arco con la noche y añade +25 ATK.' },
    { id: 'corazon-abismal', nombre: 'Corazón Abismal', arma: 'nucleo_abismal', atkBonus: 35, nivelMin: 48, region: 'abismo-invertido', repMin: 15, material: 'cristal_abismal', cantidad: 20, costo: 2200, desc: 'Una mejora de riesgo extremo que añade +35 ATK.' }
]
const FRONTIER_RESONANCIA = {
    id: 'segunda-resonancia', nombre: 'El Jardín que Recuerda', region: 'bosque-prismatico', nivel: 18,
    hp: 5200, dano: 92, desc: 'Una memoria viva crece debajo del Bosque Prismático y repite las decisiones de cada explorador.',
    fases: ['El Jardín aprende los nombres del equipo.', 'Las raíces copian las habilidades usadas contra ellas.', 'La memoria se divide: integrar, aislar o reprogramar.'],
    recompensa: { coins: 4200, exp: 300, bounty: 75, materiales: { seda_prisma: 10, madera_viva: 8 }, arte: 'limite_frontal' }
}


// ========== WOLFRIC FRONTIER: EXPANSIÓN DE CONTENIDO ==========
const FRONTIER_SUBZONAS = {
    'arca-inicial': [
        { id: 'plaza-nexo', nombre: 'Plaza del Nexo', desc: 'El punto donde los exploradores comparan sus primeras rutas.' },
        { id: 'muelle-lateral', nombre: 'Muelle Lateral', desc: 'Un borde de la ciudad donde llegan señales de regiones lejanas.' }
    ],
    'llanuras-ceniza': [
        { id: 'crater-gris', nombre: 'Cráter Gris', desc: 'El suelo conserva huellas de algo que cayó desde el cielo.' },
        { id: 'tormenta-ceniza', nombre: 'Corredor de la Tormenta', desc: 'La visibilidad cae y los depredadores aprenden tus pasos.' },
        { id: 'torre-caida', nombre: 'Torre Caída', desc: 'Una antena vieja repite una transmisión sin emisor.' }
    ],
    'bosque-prismatico': [
        { id: 'raiz-espejo', nombre: 'Raíz Espejo', desc: 'Las ramas reflejan habilidades que todavía no aprendiste.' },
        { id: 'claro-azul', nombre: 'Claro Azul', desc: 'La luz forma un círculo estable entre las hojas.' },
        { id: 'nido-cristal', nombre: 'Nido de Cristal', desc: 'Algo pequeño protege materiales demasiado puros para este bosque.' }
    ],
    'ruinas-divinidad': [
        { id: 'sala-silente', nombre: 'Sala Silente', desc: 'Las máquinas siguen activas aunque nadie recuerda su propósito.' },
        { id: 'puente-cero', nombre: 'Puente Cero', desc: 'Cruza un vacío que no aparece en los mapas ordinarios.' },
        { id: 'archivo-solar', nombre: 'Archivo Solar', desc: 'Una biblioteca de luz guarda nombres de Guardianes perdidos.' }
    ],
    'valle-eclipse': [
        { id: 'sendero-umbra', nombre: 'Sendero de la Umbra', desc: 'Solo permanece visible durante unos minutos.' },
        { id: 'observatorio-roto', nombre: 'Observatorio Roto', desc: 'Sus lentes apuntan hacia una estrella que no existe.' },
        { id: 'rio-negro', nombre: 'Río Negro', desc: 'El agua devuelve reflejos que todavía no sucedieron.' }
    ],
    'abismo-invertido': [
        { id: 'pozo-invertido', nombre: 'Pozo Invertido', desc: 'La caída hacia arriba exige elegir cada paso.' },
        { id: 'catedral-vacia', nombre: 'Catedral Vacía', desc: 'Un eco responde antes de que termines de hablar.' },
        { id: 'nucleo-suspendido', nombre: 'Núcleo Suspendido', desc: 'El centro del Abismo mantiene una gravedad propia.' }
    ]
}
const FRONTIER_EVENTOS_REGIONALES = [
    { id: 'tormenta-ceniza', region: 'llanuras-ceniza', nombre: 'Tormenta de Ceniza', desc: 'Una tormenta abre una ruta breve entre los cráteres.', rep: 2, coins: 160, exp: 16, item: 'Sello de Rastreo' },
    { id: 'canto-raiz', region: 'bosque-prismatico', nombre: 'El Canto de la Raíz', desc: 'El bosque reconoce a quienes no atacan primero.', rep: 4, coins: 220, exp: 24, item: 'Kit de Recolección' },
    { id: 'archivo-solar', region: 'ruinas-divinidad', nombre: 'El Archivo Solar', desc: 'Una memoria antigua entrega coordenadas de una cámara sellada.', rep: 5, coins: 340, exp: 32, item: 'Llave de Ruina' },
    { id: 'eclipse-total', region: 'valle-eclipse', nombre: 'Eclipse Total', desc: 'La noche dura un poco más y algo observa desde el valle.', rep: 6, coins: 500, exp: 45, item: 'Escudo Prismático' },
    { id: 'gravedad-inversa', region: 'abismo-invertido', nombre: 'Gravedad Inversa', desc: 'El mapa se da vuelta y revela una recompensa escondida.', rep: 8, coins: 750, exp: 60, item: 'Bomba de Ruptura' }
]
const FRONTIER_ELITES = [
    { id: 'sabueso-ceniza-elite', nombre: 'Sabueso de Ceniza Alfa', region: 'llanuras-ceniza', nivel: 8, nivelMin: 5, hp: 360, dano: 34, drop: 'fragmento_ceniza', material: 'Fragmento de Ceniza Alfa', minDrop: 2, maxDrop: 5, elite: true, bounty: 12, itemDrop: 'Sello de Rastreo' },
    { id: 'aracnido-prisma-elite', nombre: 'Arácnido Prisma Madre', region: 'bosque-prismatico', nivel: 18, nivelMin: 10, hp: 780, dano: 55, drop: 'seda_prisma', material: 'Seda Prismática Pura', minDrop: 2, maxDrop: 5, elite: true, bounty: 18, itemDrop: 'Kit de Recolección' },
    { id: 'centinela-divino-elite', nombre: 'Centinela Divino Heraldo', region: 'ruinas-divinidad', nivel: 30, nivelMin: 18, hp: 1400, dano: 72, drop: 'fragmento_divino', material: 'Fragmento Divino Pulido', minDrop: 2, maxDrop: 4, elite: true, bounty: 25, itemDrop: 'Llave de Ruina' },
    { id: 'serpiente-eclipse-elite', nombre: 'Serpiente del Eclipse Alfa', region: 'valle-eclipse', nivel: 42, nivelMin: 28, hp: 2100, dano: 88, drop: 'escama_lunar', material: 'Escama Lunar Negra', minDrop: 2, maxDrop: 4, elite: true, bounty: 35, itemDrop: 'Escudo Prismático' },
    { id: 'anomalia-abismal-elite', nombre: 'Anomalía Abismal Consciente', region: 'abismo-invertido', nivel: 58, nivelMin: 42, hp: 3300, dano: 116, drop: 'cristal_abismal', material: 'Cristal Abismal Vivo', minDrop: 3, maxDrop: 5, elite: true, bounty: 50, itemDrop: 'Bomba de Ruptura' }
]
FRONTIER_MONSTRUOS.push(
    { id: 'saqueador-ceniza', nombre: 'Saqueador de Ceniza', region: 'llanuras-ceniza', nivel: 6, hp: 250, dano: 25, drop: 'fragmento_ceniza', material: 'Fragmento de Ceniza', minDrop: 1, maxDrop: 4 },
    { id: 'aracnido-coral', nombre: 'Arácnido Coral', region: 'bosque-prismatico', nivel: 14, hp: 460, dano: 37, drop: 'seda_prisma', material: 'Seda Prismática', minDrop: 1, maxDrop: 4 },
    { id: 'golem-nexo', nombre: 'Gólem del Nexo', region: 'bosque-prismatico', nivel: 19, hp: 720, dano: 48, drop: 'placa_nexo', material: 'Placa del Nexo', minDrop: 1, maxDrop: 3 },
    { id: 'acólito-fractal', nombre: 'Acólito Fractal', region: 'ruinas-divinidad', nivel: 28, hp: 880, dano: 58, drop: 'reliquia_fractal', material: 'Reliquia Fractal', minDrop: 1, maxDrop: 3 },
    { id: 'espectro-eclipse', nombre: 'Espectro del Eclipse', region: 'valle-eclipse', nivel: 38, hp: 1220, dano: 68, drop: 'fragmento_sombra', material: 'Fragmento de Sombra', minDrop: 1, maxDrop: 3 },
    { id: 'basilisco-lunar', nombre: 'Basilisco Lunar', region: 'valle-eclipse', nivel: 44, hp: 1600, dano: 82, drop: 'escama_lunar', material: 'Escama Lunar', minDrop: 2, maxDrop: 4 },
    { id: 'larva-vacio', nombre: 'Larva del Vacío', region: 'abismo-invertido', nivel: 55, hp: 1900, dano: 90, drop: 'fragmento_vacio', material: 'Fragmento del Vacío', minDrop: 1, maxDrop: 3 },
    { id: 'coro-abismal', nombre: 'Coro Abismal', region: 'abismo-invertido', nivel: 65, hp: 2500, dano: 104, drop: 'cristal_abismal', material: 'Cristal Abismal', minDrop: 2, maxDrop: 4 }
)
FRONTIER_ARMAS.push(
    { id: 'daga_laminal', nombre: 'Daga Laminal', nivelMin: 6, atk: 22, material: 'placa_nexo', cantidad: 6, rareza: 'Común', especializacion: 'velocidad', desc: '+22 ATK. Convierte AGI en daño adicional.' },
    { id: 'grimoire_prisma', nombre: 'Grimorio Prisma', nivelMin: 12, atk: 40, material: 'seda_prisma', cantidad: 14, rareza: 'Rara', especializacion: 'tecnica', desc: '+40 ATK. Potencia acciones de Arte y fruta.' },
    { id: 'martillo_nexo', nombre: 'Martillo del Nexo', nivelMin: 20, atk: 66, material: 'placa_nexo', cantidad: 12, rareza: 'Épica', especializacion: 'fortaleza', desc: '+66 ATK. Convierte DEF en resistencia ofensiva.' },
    { id: 'guadana_eclipse', nombre: 'Guadaña del Eclipse', nivelMin: 32, atk: 98, material: 'fragmento_sombra', cantidad: 12, rareza: 'Mítica', especializacion: 'drenaje', desc: '+98 ATK. Recupera una parte de la HP al conectar.' },
    { id: 'rifle_archivo', nombre: 'Rifle del Archivo', nivelMin: 38, atk: 112, material: 'reliquia_fractal', cantidad: 10, rareza: 'Mítica', especializacion: 'precision', desc: '+112 ATK. Mejora el daño de TEC/INT.' },
    { id: 'orbe_vacio', nombre: 'Orbe del Vacío', nivelMin: 52, atk: 150, material: 'fragmento_vacio', cantidad: 14, rareza: 'Única', especializacion: 'abismo', desc: '+150 ATK. Aumenta el daño contra élites y jefes.' }
)
ITEMS_CONSUMIBLES.push(
    { id: 15, nombre: 'Suero de Restauración', precio: 650, tipo: 'curar', valor: 45, desc: 'Cura 45 HP al instante.' },
    { id: 16, nombre: 'Célula de Energía', precio: 700, tipo: 'energia', valor: 70, desc: 'Restaura 70⚡ de energía.' },
    { id: 17, nombre: 'Escudo Prismático', precio: 900, tipo: 'frontier_escudo', valor: 0.60, desc: 'Bloquea el 60% del próximo contraataque de Frontier.' },
    { id: 18, nombre: 'Bomba de Ruptura', precio: 1100, tipo: 'frontier_bomba', valor: 120, desc: 'Inflige daño directo a un encuentro activo de Frontier.' },
    { id: 19, nombre: 'Sello de Rastreo', precio: 800, tipo: 'frontier_pista', desc: 'Registra una pista adicional cuando el mapa detecta una señal.' },
    { id: 20, nombre: 'Kit de Recolección', precio: 600, tipo: 'frontier_material', valor: 2, desc: 'Obtiene materiales de la región actual.' },
    { id: 21, nombre: 'Llave de Ruina', precio: 1500, tipo: 'frontier_llave', desc: 'Aumenta la reputación y registra una llave de escenario.' },
    { id: 22, nombre: 'Catalizador de Fase', precio: 1300, tipo: 'frontier_fase', valor: 35, desc: 'Añade daño fijo a tu próxima acción contra un jefe Frontier.' }
)
function frontierElegirSubzona(user, regionId) {
    const lista = FRONTIER_SUBZONAS[regionId] || []
    if (!lista.length) return null
    const subzona = lista[Math.floor(Math.random() * lista.length)]
    const f = frontierInicializar(user)
    if (!f.subzonasDescubiertas[regionId]) f.subzonasDescubiertas[regionId] = []
    if (!f.subzonasDescubiertas[regionId].includes(subzona.id)) f.subzonasDescubiertas[regionId].push(subzona.id)
    return subzona
}
function frontierElegirMonstruo(regionId, user) {
    const elites = FRONTIER_ELITES.filter(e => e.region === regionId && user.level >= e.nivelMin)
    if (elites.length && Math.random() < 0.20) return { ...elites[Math.floor(Math.random() * elites.length)] }
    const candidatos = FRONTIER_MONSTRUOS.filter(monstruo => monstruo.region === regionId)
    return { ...(candidatos.length ? candidatos[Math.floor(Math.random() * candidatos.length)] : FRONTIER_MONSTRUOS[0]) }
}
function frontierEventoRegional(regionId) {
    const lista = FRONTIER_EVENTOS_REGIONALES.filter(e => e.region === regionId)
    return lista.length ? lista[Math.floor(Math.random() * lista.length)] : null
}
function frontierArmaExtra(user, modo = 'normal') {
    const arma = frontierArma(user)
    let extra = arma.atk
    if (arma.especializacion === 'velocidad') extra += Math.floor(user.stats.agi * 0.28)
    if (arma.especializacion === 'fortaleza') extra += Math.floor(user.stats.def * 0.22)
    if (arma.especializacion === 'tecnica' && modo !== 'normal') extra += Math.floor(user.stats.int * 0.28)
    if (arma.especializacion === 'precision') extra += Math.floor(user.stats.int * 0.35)
    if (arma.especializacion === 'abismo' && modo !== 'normal') extra += 24
    return extra
}
function frontierAplicarEscudo(user, dano) {
    const pct = Number(user.frontier?.escudoFrontier || 0)
    if (pct <= 0) return dano
    user.frontier.escudoFrontier = 0
    return Math.max(1, Math.floor(dano * (1 - pct)))
}
function frontierConsumirBonusFase(user) {
    const bonus = Number(user.frontier?.bonusFase || 0)
    if (bonus > 0) user.frontier.bonusFase = 0
    return bonus
}
function frontierAplicarItemActivo(user, item, activo) {
    const f = frontierInicializar(user)
    if (!activo) return { ok: false, texto: 'Necesitas un encuentro Frontier activo para usar ese objeto.' }
    if (item.tipo === 'frontier_escudo') {
        f.escudoFrontier = item.valor; return { ok: true, texto: `🛡️ Escudo Prismático activo: ${Math.round(item.valor * 100)}% menos daño en el próximo contraataque.` }
    }
    if (item.tipo === 'frontier_bomba') {
        const dano = Math.max(1, item.valor + Math.floor(user.stats.int * 0.45))
        if (activo.tipo === 'resonancia' || activo.hp !== undefined) activo.hp = Math.max(1, activo.hp - dano)
        else if (activo.monster) activo.monster.hp = Math.max(1, activo.monster.hp - dano)
        return { ok: true, texto: `💣 La Bomba de Ruptura impacta el encuentro e inflige *${dano}* de daño directo.` }
    }
    if (item.tipo === 'frontier_pista') {
        const nueva = frontierPistaInicial(user); return { ok: true, texto: nueva ? '🔐 El Sello de Rastreo ha registrado una nueva pista.' : '🛰️ El Sello detectó una señal repetida, pero no añadió una pista nueva.' }
    }
    if (item.tipo === 'frontier_material') {
        const regionId = activo.regionId || activo.region || f.regionActual
        const candidatos = FRONTIER_MONSTRUOS.filter(monstruo => monstruo.region === regionId)
        const fuente = candidatos[0] || FRONTIER_MONSTRUOS[0]
        f.materiales[fuente.drop] = (f.materiales[fuente.drop] || 0) + item.valor
        return { ok: true, texto: `📦 El Kit recuperó *${item.valor}x ${fuente.material}* de la región.` }
    }
    if (item.tipo === 'frontier_llave') {
        f.reputacion[f.regionActual] = (f.reputacion[f.regionActual] || 0) + 3
        if (!f.consecuencias.includes('llave-de-ruina')) f.consecuencias.push('llave-de-ruina')
        return { ok: true, texto: '🗝️ La Llave de Ruina registra una ruta sellada y otorga +3 reputación regional.' }
    }
    if (item.tipo === 'frontier_fase') {
        f.bonusFase = (f.bonusFase || 0) + item.valor
        return { ok: true, texto: `🔻 Catalizador preparado: +${item.valor} daño en tu próxima acción contra un jefe.` }
    }
    return { ok: false, texto: 'Ese objeto no tiene un efecto Frontier válido.' }
}

function frontierInicializar(user, alias = null) {
    if (!user.frontier) user.frontier = {}
    const f = user.frontier
    if (alias && !f.alias) f.alias = alias
    if (!f.rango) f.rango = 'E'
    if (!f.regionActual) f.regionActual = 'arca-inicial'
    if (!Array.isArray(f.regionesDescubiertas) || !f.regionesDescubiertas.length) f.regionesDescubiertas = ['arca-inicial']
    if (!Array.isArray(f.pistas)) f.pistas = []
    if (!Array.isArray(f.escenariosUnicos)) f.escenariosUnicos = []
    if (!Array.isArray(f.guardianesDerrotados)) f.guardianesDerrotados = []
    if (!f.materiales) f.materiales = {}
    if (!Array.isArray(f.armasPoseidas) || !f.armasPoseidas.length) f.armasPoseidas = ['punos_novato']
    if (!f.armaEquipada) f.armaEquipada = 'punos_novato'
    if (!Array.isArray(f.artesDesbloqueadas) || !f.artesDesbloqueadas.length) f.artesDesbloqueadas = ['corte_basico']
    if (!Array.isArray(f.artesEquipadas) || !f.artesEquipadas.length) f.artesEquipadas = ['corte_basico']
    if (!f.reputacion) f.reputacion = {}
    if (!Array.isArray(f.encuentrosDescubiertos)) f.encuentrosDescubiertos = []
    if (!f.exploraciones) f.exploraciones = {}
    if (!f.subzonasDescubiertas) f.subzonasDescubiertas = {}
    if (!Array.isArray(f.elitesDerrotadas)) f.elitesDerrotadas = []
    if (!Array.isArray(f.eventosFrontier)) f.eventosFrontier = []
    if (!Array.isArray(f.misionesFrontier)) f.misionesFrontier = []
    if (!Array.isArray(f.npcsConocidos)) f.npcsConocidos = []
    if (!Array.isArray(f.recetasDescubiertas)) f.recetasDescubiertas = ['temple-ceniza']
    if (!f.mejorasArmas) f.mejorasArmas = {}
    if (!Array.isArray(f.consecuencias)) f.consecuencias = []
    if (!Number.isFinite(f.prestigio)) f.prestigio = 0
    if (!f.tutorial || typeof f.tutorial !== 'object') f.tutorial = { estado: 'pendiente', ruta: null, pasos: [], recompensaReclamada: false, creadoEn: null }
    if (!f.tutorial.estado) f.tutorial.estado = 'pendiente'
    if (!Array.isArray(f.tutorial.pasos)) f.tutorial.pasos = []
    if (f.tutorial.ruta === undefined) f.tutorial.ruta = null
    if (f.tutorial.recompensaReclamada === undefined) f.tutorial.recompensaReclamada = false
    if (f.tutorial.creadoEn === undefined) f.tutorial.creadoEn = null
    return f
}

function frontierTutorial(user, alias = null) {
    return frontierInicializar(user, alias).tutorial
}

function frontierTutorialRegistrarPaso(user, paso) {
    const tutorial = frontierTutorial(user)
    if (!tutorial.pasos.includes(paso)) tutorial.pasos.push(paso)
    if (tutorial.estado === 'pendiente') tutorial.estado = 'en-recorrido'
    return tutorial
}

function frontierTutorialElegirRuta(user, ruta) {
    const opcion = frontierNormalizar(ruta)
    if (!['guia', 'habilidades'].includes(opcion)) return { ok: false, texto: 'Elige una apertura válida: guía o habilidades.' }
    const tutorial = frontierTutorialRegistrarPaso(user, `ruta:${opcion}`)
    tutorial.ruta = opcion
    return { ok: true, ruta: opcion, tutorial }
}

function frontierTutorialCompletar(user) {
    const tutorial = frontierTutorial(user)
    const requisitos = ['ruta:guia', 'ruta:habilidades']
    if (!requisitos.every(paso => tutorial.pasos.includes(paso))) return { ok: false, texto: 'Antes de cerrar el recorrido abre las dos rutas: .inicio guia y .inicio habilidades.' }
    tutorial.estado = 'completado'
    if (tutorial.recompensaReclamada) return { ok: true, texto: 'El recorrido ya está registrado. Puedes seguir tu propia ruta con .orientacion.' }
    tutorial.recompensaReclamada = true
    user.coins += 150; user.lifetimeCoinsEarned += 150
    user.inventory.push('Kit de Recolección')
    return { ok: true, texto: 'Recorrido inicial completado: +$150 y Kit de Recolección. Ahora Lira Voss espera en el Arca Inicial con tu primera misión.' }
}

function frontierOrientacionInicial(user, prefijo = prefix, lang = 'es') {
    const f = frontierInicializar(user)
    const tutorial = frontierTutorial(user)
    const rutas = []
    if (tutorial.estado !== 'completado') rutas.push(tr(lang,
        `1. Completa la zona inicial: ${prefijo}inicio guia, ${prefijo}inicio habilidades y ${prefijo}inicio completar.`,
        `1. Fecha a zona inicial: ${prefijo}start guide, ${prefijo}start skills e ${prefijo}start complete.`,
        `1. Finish the starter zone: ${prefijo}start guide, ${prefijo}start skills and ${prefijo}start complete.`))
    if (user.level < 3) rutas.push(tr(lang,
        `2. Sube a nivel 3 con ${prefijo}daily, ${prefijo}work y ${prefijo}mazmorra; las Llanuras de Ceniza se abren en nivel 3.`,
        `2. Sobe pro nível 3 com ${prefijo}daily, ${prefijo}work e ${prefijo}dungeon; as Planícies de Cinza abrem no nível 3.`,
        `2. Hit level 3 with ${prefijo}daily, ${prefijo}work and ${prefijo}dungeon; Ash Plains opens at level 3.`))
    else if (!f.regionesDescubiertas.includes('llanuras-ceniza')) rutas.push(tr(lang,
        `2. Abre tu primera frontera con ${prefijo}viajar Llanuras de Ceniza.`,
        `2. Abre sua primeira fronteira com ${prefijo}travel Llanuras de Ceniza.`,
        `2. Open your first border with ${prefijo}travel Llanuras de Ceniza.`))
    else if ((f.exploraciones['llanuras-ceniza'] || 0) < 2) rutas.push(tr(lang,
        `2. Explora las Llanuras dos veces con ${prefijo}explorar Llanuras de Ceniza y reúne Fragmentos de Ceniza.`,
        `2. Explore as Planícies duas vezes com ${prefijo}explore Llanuras de Ceniza e junte Fragmentos de Ceniza.`,
        `2. Explore the Plains twice with ${prefijo}explore Llanuras de Ceniza and gather Ash Fragments.`))
    else if (!f.misionesFrontier.some(m => m.id === 'lira-ruta-ceniza' && m.reclamada)) rutas.push(tr(lang,
        `2. Habla con Lira: ${prefijo}hablarnpc Lira Voss; acepta y entrega la misión La ruta que no figura.`,
        `2. Fala com a Lira: ${prefijo}talknpc Lira Voss; aceita e entrega a missão La ruta que no figura.`,
        `2. Talk to Lira: ${prefijo}talknpc Lira Voss; accept and turn in the quest La ruta que no figura.`))
    else rutas.push(tr(lang,
        `2. Revisa ${prefijo}mapa, ${prefijo}misionesfrontier y ${prefijo}equipo para elegir tu siguiente frontera.`,
        `2. Olha ${prefijo}map, ${prefijo}frontiermissions e ${prefijo}gear pra escolher a próxima fronteira.`,
        `2. Check ${prefijo}map, ${prefijo}frontiermissions and ${prefijo}gear to pick your next border.`))
    rutas.push(tr(lang,
        `3. Para farmear: ${prefijo}explorar <región> da materiales y EXP; ${prefijo}daily y ${prefijo}work sostienen créditos.`,
        `3. Pra farmear: ${prefijo}explore <região> dá materiais e EXP; ${prefijo}daily e ${prefijo}work seguram os créditos.`,
        `3. To farm: ${prefijo}explore <region> gives mats and EXP; ${prefijo}daily and ${prefijo}work keep credits coming.`))
    rutas.push(tr(lang,
        `4. Para combate y botín: ${prefijo}mazmorra, ${prefijo}duel2v2 y, al tener grupo, ${prefijo}iniciarfrontera.`,
        `4. Pra combate e loot: ${prefijo}dungeon, ${prefijo}duel2v2 e, com grupo, ${prefijo}frontierstart.`,
        `4. For fights and loot: ${prefijo}dungeon, ${prefijo}duel2v2 and, with a group, ${prefijo}frontierstart.`))
    return rutas
}


FRONTIER_NPCS.push(
    { id: 'mara', nombre: 'Mara Quill', rol: 'Cazadora de élites', region: 'llanuras-ceniza', nivelMin: 5, desc: 'Marca monstruos que aprendieron a esconder sus niveles.', dialogo: 'Un monstruo élite no es solo más fuerte. Es un monstruo que ya sobrevivió a tus métodos.' },
    { id: 'yume', nombre: 'Yume Raíz', rol: 'Intérprete del bosque', region: 'bosque-prismatico', nivelMin: 10, desc: 'Escucha la memoria de las raíces y traduce sus silencios.', dialogo: 'El bosque no quiere que lo conquistes. Quiere saber qué harás cuando tengas la oportunidad.' },
    { id: 'riven', nombre: 'Riven-IX', rol: 'Archivista de combate', region: 'ruinas-divinidad', nivelMin: 18, desc: 'Clasifica patrones de combate recuperados de cámaras antiguas.', dialogo: 'Cada arma es una hipótesis. La batalla decide si era correcta.' },
    { id: 'solis', nombre: 'Solis Noct', rol: 'Guía del eclipse', region: 'valle-eclipse', nivelMin: 28, desc: 'Solo aparece cuando el valle pierde su segunda sombra.', dialogo: 'El eclipse no oculta el camino. Oculta quién estaba caminando contigo.' }
)
FRONTIER_MISIONES.push(
    { id: 'mara-caceria-alfa', npc: 'mara', nombre: 'Cacería Alfa', desc: 'Derrota una variante élite en las Llanuras de Ceniza.', requisito: { tipo: 'elite', region: 'llanuras-ceniza', cantidad: 1 }, repMin: 0, recompensa: { coins: 650, exp: 42, rep: { 'llanuras-ceniza': 5 }, materiales: { placa_nexo: 2 }, items: { 'Sello de Rastreo': 1 } } },
    { id: 'yume-memoria-raiz', npc: 'yume', nombre: 'Memoria de Raíz', desc: 'Completa un evento regional del Bosque Prismático.', requisito: { tipo: 'evento', evento: 'canto-raiz', cantidad: 1 }, repMin: 3, recompensa: { coins: 800, exp: 58, rep: { 'bosque-prismatico': 8 }, materiales: { madera_viva: 4 }, arte: 'lectura_patron' } },
    { id: 'riven-arma-archivo', npc: 'riven', nombre: 'El arma como hipótesis', desc: 'Equipa el Rifle del Archivo.', requisito: { tipo: 'arma', arma: 'rifle_archivo' }, repMin: 5, recompensa: { coins: 1200, exp: 85, rep: { 'ruinas-divinidad': 10 }, materiales: { reliquia_fractal: 3 }, items: { 'Catalizador de Fase': 1 } } },
    { id: 'solis-segunda-sombra', npc: 'solis', nombre: 'La segunda sombra', desc: 'Completa la Segunda Resonancia y elige su destino.', requisito: { tipo: 'escenario', escenario: 'segunda-resonancia', cantidad: 1 }, repMin: 8, recompensa: { coins: 2200, exp: 140, rep: { 'valle-eclipse': 12 }, materiales: { escama_lunar: 6 }, arma: 'guadana_eclipse' } }
)
function frontierNormalizar(texto = '') {
    return texto.toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}
function frontierRegion(input) {
    const q = frontierNormalizar(input)
    return REGIONES_FRONTIER.find(r => frontierNormalizar(r.id) === q || frontierNormalizar(r.nombre) === q || frontierNormalizar(r.nombre).includes(q)) || null
}
function frontierArma(user) {
    const f = frontierInicializar(user)
    const base = FRONTIER_ARMAS.find(a => a.id === f.armaEquipada) || FRONTIER_ARMAS[0]
    const bonus = Number(f.mejorasArmas?.[base.id] || 0)
    return { ...base, atk: base.atk + bonus, desc: bonus ? `${base.desc} Refuerzo activo: +${bonus} ATK.` : base.desc }
}
function frontierArte(input) {
    const q = frontierNormalizar(input)
    return FRONTIER_ARTES.find(a => frontierNormalizar(a.id) === q || frontierNormalizar(a.nombre) === q || frontierNormalizar(a.nombre).includes(q)) || null
}
function frontierArteEquipada(user) {
    const f = frontierInicializar(user)
    const id = Array.isArray(f.artesEquipadas) && f.artesEquipadas.length ? f.artesEquipadas[0] : 'corte_basico'
    return FRONTIER_ARTES.find(a => a.id === id) || FRONTIER_ARTES[0]
}
function frontierArteHabilidad(user) {
    const arte = frontierArteEquipada(user)
    const habilidades = {
        corte_basico: { poder: 8, costo: 0, efectos: [] },
        paso_lateral: { poder: 9, costo: 12, efectos: [{ tipo: 'buff_agi_evasion', pct: 0.25, turnos: 1, autoObjetivo: true }] },
        golpe_precision: { poder: 19, costo: 18, efectos: [{ tipo: 'ignora_def_pct', pct: 0.20 }] },
        ruptura_guardian: { poder: 25, costo: 24, efectos: [{ tipo: 'ignora_def_pct', pct: 0.35 }] },
        lectura_patron: { poder: 12, costo: 20, efectos: [{ tipo: 'crit_asegurado' }] },
        limite_frontal: { poder: 34, costo: 32, efectos: [{ tipo: 'dmg_mult', mult: 1.30 }] }
    }
    return { nombre: `Arte: ${arte.nombre}`, ...habilidades[arte.id] || habilidades.corte_basico }
}
function frontierRango(nivel) {
    if (nivel >= 80) return 'S'
    if (nivel >= 60) return 'A'
    if (nivel >= 40) return 'B'
    if (nivel >= 20) return 'C'
    if (nivel >= 8) return 'D'
    return 'E'
}
function frontierActualizarRango(user) {
    const f = frontierInicializar(user)
    f.rango = frontierRango(user.level)
}
function frontierTitulo(titulo, subtitulo = '', icono = '🌐') {
    const temporada = frontierMundo?.temporada?.nombre || 'Temporada 02 · El Umbral'
    return `» ˚₊*– ͟͞ 𝖂𝖔𝖑𝖋𝖗𝖎𝖈-🜲 FRONTIER\n_\`${temporada.toUpperCase()}\`_\n——————————————>\n╭━━⪩ *${titulo}* ⪨━━\n${subtitulo ? `> ❏ • ${subtitulo}\n` : ''}╰━━─「${icono}」─━━━━━━━━`
}
function frontierPanel(titulo, filas = [], icono = '✦') {
    const cuerpo = filas.filter(fila => fila !== undefined && fila !== null && String(fila).trim()).map(fila => `> ❏ • ${fila}`).join('\n')
    return `╭━━⪩ *${titulo}* ⪨━━${cuerpo ? `\n${cuerpo}` : ''}\n╰━━─「${icono}」─━━━━━━━━`
}
function frontierMaterialesTexto(f) {
    const entradas = Object.entries(f.materiales || {}).filter(([, cantidad]) => cantidad > 0)
    return entradas.length ? entradas.map(([id, cantidad]) => {
        const monster = FRONTIER_MONSTRUOS.find(m => m.drop === id)
        return `• ${monster?.material || id}: ${cantidad}`
    }).join('\n') : '• Todavía no tienes materiales.'
}
function frontierPistaInicial(user) {
    const f = frontierInicializar(user)
    const id = 'señal-primer-soberano'
    if (f.pistas.some(p => p.id === id)) return false
    f.pistas.push({ id, texto: 'Una señal desconocida menciona a un Soberano que duerme detrás del mapa.', fecha: Date.now() })
    if (!f.escenariosUnicos.some(e => e.id === 'primer-soberano')) {
        f.escenariosUnicos.push({ id: 'primer-soberano', nombre: 'La Señal del Primer Soberano', progreso: 1, meta: 3, etapa: 1, estado: 'activo', faseNarrativa: 'pista', decisionPendiente: false, decisiones: [], ultimaActualizacion: Date.now() })
    }
    return true
}
function frontierDarExp(user, cantidad) {
    user.level = Math.max(1, Number(user.level) || 1)
    const antes = user.level
    const cantidadFinal = Math.floor(Math.max(0, cantidad) * multiplicadorActivo('xp')) // eventos programados de doble XP
    user.exp = (user.exp || 0) + cantidadFinal
    while (user.exp >= user.level * 20) {
        user.exp -= user.level * 20
        user.level++
        user.statPoints = (user.statPoints || 0) + 3
    }
    frontierActualizarRango(user)
    return user.level - antes
}
function frontierIntentarDesbloqueo(user) {
    const f = frontierInicializar(user)
    const siguiente = REGIONES_FRONTIER.find(region => !f.regionesDescubiertas.includes(region.id) && user.level >= region.nivelMin)
    if (!siguiente) return null
    f.regionesDescubiertas.push(siguiente.id)
    f.reputacion[siguiente.id] = f.reputacion[siguiente.id] || 0
    return siguiente
}

// ========== WOLFRIC FRONTIER: PROGRESIÓN FINAL ==========
const FRONTIER_MUNDO_ARCHIVO = './frontier_mundo.json'
const FRONTIER_RESONANCIA_ARCHIVO = './frontier_resonancia.json'
const FRONTIER_RESONANCIA_DURACION_MS = 30 * 60 * 1000
const FRONTIER_MAX_RESONANCIA = 5
const frontierResonanciasActivas = new Map()
let frontierMundo = {
    temporada: { nombre: 'Temporada 01 · La Señal', estado: 'activa', inicio: Date.now(), fin: null },
    eventos: [], consecuencias: [], anuncios: [],
    estadisticas: { guardianes: 0, soberanos: 0, resonancias: 0 }
}
function frontierMundoGuardar() {
    try { fs.writeFileSync(FRONTIER_MUNDO_ARCHIVO, JSON.stringify(frontierMundo, null, 2)) } catch (e) { console.log('Error guardando mundo Frontier:', e) }
}
function frontierMundoCargar() {
    try {
        if (fs.existsSync(FRONTIER_MUNDO_ARCHIVO)) {
            const datos = JSON.parse(fs.readFileSync(FRONTIER_MUNDO_ARCHIVO, 'utf8')) || {}
            frontierMundo = {
                ...frontierMundo, ...datos,
                temporada: { ...frontierMundo.temporada, ...(datos.temporada || {}) },
                eventos: Array.isArray(datos.eventos) ? datos.eventos : [],
                consecuencias: Array.isArray(datos.consecuencias) ? datos.consecuencias : [],
                anuncios: Array.isArray(datos.anuncios) ? datos.anuncios : [],
                estadisticas: { ...frontierMundo.estadisticas, ...(datos.estadisticas || {}) }
            }
        }
    } catch (e) { console.log('Error cargando mundo Frontier:', e) }
    frontierMundoGuardar()
}
function frontierMundoRegistrarEvento(tipo, encuentro = null) {
    const clave = encuentro?.id || tipo
    if (frontierMundo.eventos.some(e => e.clave === clave)) return false
    frontierMundo.eventos.push({ clave, tipo, fecha: Date.now() })
    if (tipo === 'primer-soberano') {
        frontierMundo.estadisticas.soberanos++
        frontierMundo.consecuencias.push('Las Ruinas de la Divinidad dejaron de ocultar sus rutas.')
    }
    if (tipo === 'guardian') frontierMundo.estadisticas.guardianes++
    if (tipo === 'segunda-resonancia') {
        frontierMundo.estadisticas.resonancias++
        frontierMundo.consecuencias.push('El Jardín que Recuerda devolvió una memoria al mapa.')
    }
    frontierMundoGuardar()
    return true
}
function frontierPrestigio(user) {
    const f = frontierInicializar(user)
    return (f.prestigio || 0) + f.guardianesDerrotados.length * 25 + f.pistas.length * 3 + f.escenariosUnicos.filter(e => e.estado === 'completado').length * 100
}
function frontierReputacionNivel(valor) {
    const n = Number(valor || 0)
    if (n >= 25) return 'aliado'
    if (n >= 10) return 'respetado'
    if (n >= 3) return 'conocido'
    if (n <= -5) return 'desconfiado'
    return 'neutral'
}
function frontierNpc(input) {
    const q = frontierNormalizar(input)
    return FRONTIER_NPCS.find(n => frontierNormalizar(n.id) === q || frontierNormalizar(n.nombre) === q || frontierNormalizar(n.nombre).includes(q)) || null
}
function frontierMision(input) {
    const q = frontierNormalizar(input)
    return FRONTIER_MISIONES.find(m => frontierNormalizar(m.id) === q || frontierNormalizar(m.nombre) === q || frontierNormalizar(m.nombre).includes(q)) || null
}
function frontierMisionProgreso(user, m) {
    const f = frontierInicializar(user)
    const r = m.requisito
    if (r.tipo === 'explorar') return f.exploraciones[r.region] || 0
    if (r.tipo === 'material') return f.materiales[r.material] || 0
    if (r.tipo === 'arma') return f.armasPoseidas.includes(r.arma) ? 1 : 0
    if (r.tipo === 'guardian') return f.guardianesDerrotados.includes(r.guardian) ? 1 : 0
    if (r.tipo === 'elite') return f.elitesDerrotadas.filter(id => FRONTIER_ELITES.some(elite => elite.id === id && elite.region === r.region)).length
    if (r.tipo === 'evento') return f.eventosFrontier.includes(r.evento) ? 1 : 0
    if (r.tipo === 'escenario') return f.escenariosUnicos.some(e => e.id === r.escenario && e.estado === 'completado') ? 1 : 0
    if (r.tipo === 'item') return user.inventory.filter(x => x === r.item).length
    return 0
}
function frontierEstadoMision(user, m) {
    const actual = user.frontier.misionesFrontier.find(x => x.id === m.id)
    return actual || { id: m.id, aceptada: false, reclamada: false }
}
function frontierAceptarMision(user, m) {
    const f = frontierInicializar(user)
    const actual = frontierEstadoMision(user, m)
    const reputacion = f.reputacion[m.npc === 'lira' ? 'arca-inicial' : FRONTIER_NPCS.find(n => n.id === m.npc)?.region] || 0
    if (reputacion < m.repMin) return { ok: false, texto: `Necesitas reputación ${m.repMin} con el NPC para aceptar esta misión.` }
    if (actual.reclamada) return { ok: false, texto: 'Esta misión ya fue completada.' }
    if (!actual.aceptada) f.misionesFrontier.push({ id: m.id, aceptada: true, reclamada: false, fecha: Date.now() })
    return { ok: true, texto: actual.aceptada ? 'La misión ya está activa.' : `Misión aceptada: *${m.nombre}*.` }
}
function frontierReclamarMision(user, m) {
    const f = frontierInicializar(user)
    const actual = frontierEstadoMision(user, m)
    if (!actual.aceptada) return { ok: false, texto: `Primero acepta la misión con *${prefix}aceptarmision ${m.id}*.` }
    if (actual.reclamada) return { ok: false, texto: 'Esta misión ya fue reclamada.' }
    const progreso = frontierMisionProgreso(user, m)
    if (progreso < m.requisito.cantidad && m.requisito.tipo !== 'arma' && m.requisito.tipo !== 'guardian') return { ok: false, texto: `Progreso: ${progreso}/${m.requisito.cantidad}. Todavía no está completa.` }
    if ((m.requisito.tipo === 'arma' || m.requisito.tipo === 'guardian') && progreso < 1) return { ok: false, texto: 'El objetivo todavía no está completo.' }
    const r = m.recompensa
    user.coins += r.coins || 0; user.lifetimeCoinsEarned += r.coins || 0; frontierDarExp(user, r.exp || 0)
    for (const [region, cantidad] of Object.entries(r.rep || {})) f.reputacion[region] = (f.reputacion[region] || 0) + cantidad
    for (const [material, cantidad] of Object.entries(r.materiales || {})) f.materiales[material] = (f.materiales[material] || 0) + cantidad
    for (const [item, cantidad] of Object.entries(r.items || {})) for (let i = 0; i < cantidad; i++) user.inventory.push(item)
    if (r.arma && !f.armasPoseidas.includes(r.arma)) f.armasPoseidas.push(r.arma)
    if (r.arte && !f.artesDesbloqueadas.includes(r.arte)) f.artesDesbloqueadas.push(r.arte)
    actual.reclamada = true; f.prestigio += 15
    const nuevasRecetas = frontierActualizarRecetas(user)
    return { ok: true, texto: `Misión completada: *${m.nombre}*\nRecompensa: +$${r.coins || 0} · +${r.exp || 0} EXP · +${Object.values(r.rep || {})[0] || 0} reputación.${nuevasRecetas.length ? `\n🛠️ Recetas descubiertas: ${nuevasRecetas.join(', ')}.` : ''}` }
}
function frontierReceta(input) {
    const q = frontierNormalizar(input)
    return FRONTIER_RECETAS.find(r => frontierNormalizar(r.id) === q || frontierNormalizar(r.nombre) === q || frontierNormalizar(r.nombre).includes(q)) || null
}
function frontierActualizarRecetas(user) {
    const f = frontierInicializar(user); const nuevas = []
    for (const receta of FRONTIER_RECETAS) {
        if (!f.recetasDescubiertas.includes(receta.id) && (f.reputacion[receta.region] || 0) >= receta.repMin) {
            f.recetasDescubiertas.push(receta.id); nuevas.push(receta.nombre)
        }
    }
    return nuevas
}
function frontierFabricar(user, receta) {
    const f = frontierInicializar(user)
    if (!f.armasPoseidas.includes(receta.arma)) return { ok: false, texto: `Necesitas poseer *${FRONTIER_ARMAS.find(a => a.id === receta.arma)?.nombre || receta.arma}*.` }
    if (user.level < receta.nivelMin) return { ok: false, texto: `Esta receta requiere nivel ${receta.nivelMin}.` }
    if ((f.reputacion[receta.region] || 0) < receta.repMin) return { ok: false, texto: `Necesitas reputación ${receta.repMin} en la región.` }
    if ((f.materiales[receta.material] || 0) < receta.cantidad) return { ok: false, texto: `Te faltan materiales: ${receta.cantidad}x ${receta.material}.` }
    if (user.coins < receta.costo) return { ok: false, texto: `Necesitas $${receta.costo}.` }
    const actual = Number(f.mejorasArmas[receta.arma] || 0)
    if (actual >= receta.atkBonus) return { ok: false, texto: 'Esta mejora ya está instalada.' }
    f.materiales[receta.material] -= receta.cantidad; user.coins -= receta.costo; f.mejorasArmas[receta.arma] = receta.atkBonus; f.prestigio += 10
    return { ok: true, texto: `${frontierTitulo('𝗙𝗔𝗕𝗥𝗜𝗖𝗔𝗖𝗜𝗢́𝗡 𝗔𝗩𝗔𝗡𝗭𝗔𝗗𝗔', receta.nombre, '🛠️')}\n\n${receta.desc}\n💰 Coste: $${receta.costo}\n✅ Mejora instalada en el arma.` }
}
function frontierEscenarioDos(user, crear = false) {
    const f = frontierInicializar(user)
    let escenario = f.escenariosUnicos.find(e => e.id === FRONTIER_RESONANCIA.id)
    if (!escenario && crear) {
        escenario = { id: FRONTIER_RESONANCIA.id, nombre: FRONTIER_RESONANCIA.nombre, progreso: 1, meta: 1, etapa: 1, estado: 'bloqueado', faseNarrativa: 'memoria', decisionPendiente: false, decisiones: [], ultimaActualizacion: Date.now() }
        f.escenariosUnicos.push(escenario)
    }
    return escenario || null
}
function frontierResonanciaDesbloqueada(user) {
    const f = frontierInicializar(user)
    return user.level >= FRONTIER_RESONANCIA.nivel && (f.guardianesDerrotados.includes('soberano-ruptura') || f.escenariosUnicos.some(e => e.id === 'primer-soberano' && e.estado === 'completado'))
}
function frontierGuardarResonancias() {
    try { fs.writeFileSync(FRONTIER_RESONANCIA_ARCHIVO, JSON.stringify(Object.fromEntries(frontierResonanciasActivas), null, 2)) } catch (e) { console.log('Error guardando resonancias:', e) }
}
function frontierCargarResonancias() {
    try {
        if (!fs.existsSync(FRONTIER_RESONANCIA_ARCHIVO)) return
        const datos = JSON.parse(fs.readFileSync(FRONTIER_RESONANCIA_ARCHIVO, 'utf8'))
        for (const [chatId, e] of Object.entries(datos || {})) if (e && e.timestamp && Date.now() - e.timestamp < FRONTIER_RESONANCIA_DURACION_MS && e.hp > 0) frontierResonanciasActivas.set(chatId, e)
        frontierGuardarResonancias()
    } catch (e) { console.log('Error cargando resonancias:', e) }
}
function frontierResonanciaActiva(chatId) {
    const e = frontierResonanciasActivas.get(chatId)
    if (!e) return null
    if (Date.now() - e.timestamp >= FRONTIER_RESONANCIA_DURACION_MS || e.hp <= 0) { frontierResonanciasActivas.delete(chatId); frontierGuardarResonancias(); return null }
    return e
}
function frontierResonanciaTexto(e, lang = 'es') {
    const L = (es, pt, en) => tr(lang, es, pt, en)
    const fase = lore(lang, FRONTIER_RESONANCIA.fases[Math.max(0, (e.fase || 1) - 1)])
    return `${frontierTitulo(L('𝗦𝗘𝗚𝗨𝗡𝗗𝗔 𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔', '𝗦𝗘𝗚𝗨𝗡𝗗𝗔 𝗥𝗘𝗦𝗦𝗢𝗡𝗔̂𝗡𝗖𝗜𝗔', '𝗦𝗘𝗖𝗢𝗡𝗗 𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗘'), FRONTIER_RESONANCIA.nombre, '🌱')}\n\n${frontierPanel(L('𝗖𝗔𝗠𝗣𝗢 𝗗𝗘 𝗠𝗘𝗠𝗢𝗥𝗜𝗔', '𝗖𝗔𝗠𝗣𝗢 𝗗𝗘 𝗠𝗘𝗠𝗢́𝗥𝗜𝗔', '𝗠𝗘𝗠𝗢𝗥𝗬 𝗙𝗜𝗘𝗟𝗗'), [`📍 ${L('Región', 'Região', 'Region')}: Bosque Prismático`, `❤️ HP: ${Math.max(0, e.hp)}/${e.hpMax}`, `🔻 ${L('Fase', 'Fase', 'Phase')}: ${e.fase}/3`, `👥 ${L('Equipo', 'Time', 'Team')}: ${frontierNombreParticipantes(e)}`, `⏳ ${L('Tiempo', 'Tempo', 'Time')}: ${clockString(Math.max(0, FRONTIER_RESONANCIA_DURACION_MS - (Date.now() - e.timestamp)))}`], '🌿')}\n\n${frontierPanel(L('𝗣𝗔𝗧𝗥𝗢́𝗡', '𝗣𝗔𝗗𝗥𝗔̃𝗢', '𝗣𝗔𝗧𝗧𝗘𝗥𝗡'), [fase, `⚔️ ${prefix}atacarresonancia · ${L('golpe', 'golpe', 'hit')}`, `✨ ${prefix}arteresonancia · Arte`, `🍎 ${prefix}frutaresonancia · ${L('fruta', 'fruta', 'fruit')}`, `🏃 ${prefix}huirresonancia · ${L('abandonar', 'abandonar', 'leave')}`], '🎯')}`
}
function frontierCrearResonancia(chatId, user, sender, nombre) {
    if (!frontierResonanciaDesbloqueada(user)) return { ok: false, texto: `La resonancia requiere nivel ${FRONTIER_RESONANCIA.nivel} y haber completado al Primer Soberano.` }
    const estado = frontierEscenarioDos(user, true)
    if (estado.estado === 'completado') return { ok: false, texto: 'El Jardín que Recuerda ya fue completado.' }
    const e = { id: `resonancia-${Date.now()}`, tipo: 'resonancia', nombre: FRONTIER_RESONANCIA.nombre, nivel: FRONTIER_RESONANCIA.nivel, hp: FRONTIER_RESONANCIA.hp, hpMax: FRONTIER_RESONANCIA.hp, dano: FRONTIER_RESONANCIA.dano, fase: 1, timestamp: Date.now(), iniciadoPor: sender, participantes: [], etapa: 1 }
    frontierResonanciasActivas.set(chatId, e); e.participantes.push({ jid: sender, nombre: nombre || 'Explorador', dano: 0, acciones: 0 }); estado.estado = 'activo'; estado.ultimaActualizacion = Date.now(); frontierGuardarResonancias(); guardarEconomia()
    return { ok: true, texto: `${frontierTitulo('𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔 𝗔𝗖𝗧𝗜𝗩𝗔', FRONTIER_RESONANCIA.nombre, '🌱')}\n\n${FRONTIER_RESONANCIA.desc}\n\n${frontierResonanciaTexto(e)}` }
}
function frontierResonanciaAgregar(e, jid, nombre) {
    if (e.participantes.some(p => normalizarJidGlobal(p.jid) === normalizarJidGlobal(jid))) return true
    if (e.participantes.length >= FRONTIER_MAX_RESONANCIA) return false
    e.participantes.push({ jid, nombre: nombre || 'Explorador', dano: 0, acciones: 0 }); frontierGuardarResonancias(); return true
}
function frontierResonanciaDanio(user, e, modo = 'normal') {
    const arma = frontierArma(user); const fruta = frontierSoberanoFruta(user); const arte = frontierArteEquipada(user)
    let dano = Math.max(1, user.stats.str + frontierArmaExtra(user, modo) + Math.floor(Math.random() * 20) + Math.floor(user.stats.agi / 7) + frontierConsumirBonusFase(user))
    if (modo === 'arte') dano = Math.floor(dano * 1.45) + Math.floor(user.stats.int * 0.85) + (arte.id === 'limite_frontal' ? 35 : 0)
    if (modo === 'fruta' && fruta) dano = Math.floor(user.stats.int * 1.25) + (fruta.habilidad.poder || 0) + Math.floor(frontierArmaExtra(user, modo) * 0.40) + frontierConsumirBonusFase(user)
    if (e.fase === 3) dano = Math.floor(dano * 0.88)
    return Math.max(1, dano)
}
function frontierResonanciaFase(e) {
    const propor = e.hp / e.hpMax; let nueva = e.fase
    if (e.fase === 1 && propor <= 0.66) nueva = 2
    else if (e.fase === 2 && propor <= 0.33) nueva = 3
    if (nueva === e.fase) return null; e.fase = nueva; return FRONTIER_RESONANCIA.fases[nueva - 1]
}
function frontierRecompensarResonancia(e) {
    const avisos = []
    for (const p of e.participantes) {
        const user = getUsuario(p.jid); const f = frontierInicializar(user, p.nombre); const estado = frontierEscenarioDos(user, true)
        if (f.recompensasUnicas.includes('segunda-resonancia')) continue
        const r = FRONTIER_RESONANCIA.recompensa
        user.coins += r.coins; user.lifetimeCoinsEarned += r.coins; frontierDarExp(user, r.exp); user.bounty += r.bounty
        for (const [mat, cantidad] of Object.entries(r.materiales)) f.materiales[mat] = (f.materiales[mat] || 0) + cantidad
        if (r.arte && !f.artesDesbloqueadas.includes(r.arte)) f.artesDesbloqueadas.push(r.arte)
        f.recompensasUnicas.push('segunda-resonancia'); f.prestigio += 100; estado.estado = 'decision'; estado.decisionPendiente = true; estado.faseNarrativa = 'jardín-abierto'; estado.ultimaActualizacion = Date.now()
        avisos.push(`@${p.jid.split('@')[0]}: +$${r.coins}, +${r.exp} EXP, +${r.bounty} Bounty`)
    }
    frontierMundoRegistrarEvento('segunda-resonancia', e); return avisos
}
function frontierAplicarDecisionResonancia(user, opcion) {
    const f = frontierInicializar(user); const estado = frontierEscenarioDos(user, false)
    if (!estado || !estado.decisionPendiente) return { ok: false, texto: 'No tienes una decisión pendiente para la Segunda Resonancia.' }
    const op = frontierNormalizar(opcion)
    if (!['integrar', 'aislar', 'reprogramar'].includes(op)) return { ok: false, texto: 'Opciones válidas: integrar, aislar o reprogramar.' }
    estado.decisionPendiente = false; estado.estado = 'completado'; estado.decisiones.push({ opcion: op, fecha: Date.now() }); f.consecuencias.push(`segunda-resonancia:${op}`); f.prestigio += 35
    if (op === 'integrar') { f.reputacion['bosque-prismatico'] = (f.reputacion['bosque-prismatico'] || 0) + 12; const recetas = frontierActualizarRecetas(user); return { ok: true, texto: `Integraste la memoria al bosque. La región gana estabilidad y reputación.${recetas.length ? ` Recetas descubiertas: ${recetas.join(', ')}.` : ''}` } }
    if (op === 'aislar') { user.coins += 900; user.lifetimeCoinsEarned += 900; return { ok: true, texto: 'Aislaste la memoria. Recibes +$900 y mantienes el peligro contenido.' } }
    if (!f.artesDesbloqueadas.includes('lectura_patron')) f.artesDesbloqueadas.push('lectura_patron')
    return { ok: true, texto: 'Reprogramaste la memoria. El Arte Lectura de Patrón queda desbloqueado.' }
}
frontierMundoCargar()
frontierCargarResonancias()

function frontierGuia(prefix, lang = 'es') {
    if (lang === 'pt') return `${frontierTitulo('𝗚𝗨𝗜𝗔 𝗗𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗜𝗥𝗔', 'Explore. Aprenda. Descubra o que o mapa esconde.')}

𝗣𝗥𝗜𝗠𝗘𝗜𝗥𝗢𝗦 𝗣𝗔𝗦𝗦𝗢𝗦
• ${prefix}crearperfil — registra seu explorador.
• ${prefix}perfil — identidade, rank e progresso.
• ${prefix}mapa — regiões conhecidas.
• ${prefix}viajar <região> — vai pra uma região liberada.
• ${prefix}explorar <região> — procura monstros, materiais e pistas.

𝗖𝗢𝗠𝗕𝗔𝗧𝗘 𝗗𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗜𝗥𝗔
• ${prefix}atacarfrontera — golpeia o encontro ativo do chat.
• ${prefix}frutafrontera — usa a habilidade da fruta num chefe.
• ${prefix}arte — usa a Arte equipada num duelo 1v1.
• ${prefix}defender — prepara um escudo pro próximo hit.
• ${prefix}huir — abandona o encontro atual.
• ${prefix}huirfrontera — abandona um Guardião em grupo.
• ${prefix}equipo — vê a arma equipada.
• ${prefix}forjar <arma> — fabrica armas com materiais.
• ${prefix}equipararma <arma> — troca de arma.

𝗔𝗥𝗧𝗘𝗦 𝗘 𝗗𝗘𝗦𝗖𝗢𝗕𝗘𝗥𝗧𝗔𝗦
• ${prefix}artes — consulta as Artes de Combate.
• ${prefix}aprenderarte <arte> — destrava uma arte.
• ${prefix}equipararte <arte> — prepara uma arte.
• ${prefix}combate — vê a carga completa.
• ${prefix}pistas — sinais obtidos.
• ${prefix}escenarios — cenários únicos.
• ${prefix}rastrear — pede uma pista contextual.
• ${prefix}subzonas [região] — coordenadas descobertas.
• ${prefix}elites — assinaturas de alto risco.

𝗚𝗨𝗔𝗥𝗗𝗜𝗢̃𝗘𝗦 𝗘 𝗦𝗢𝗕𝗘𝗥𝗔𝗡𝗢
• ${prefix}guardianes — os três desafios da cadeia.
• ${prefix}soberano — estado do cenário único.
• ${prefix}iniciarfrontera — inicia a etapa no grupo.
• ${prefix}unirsefrontera — entra no time do chefe.
• ${prefix}decidirfrontera <opção> — observar, romper ou selar.

𝗡𝗣𝗖𝗦 𝗘 𝗣𝗥𝗢𝗚𝗥𝗘𝗦𝗦𝗢
• ${prefix}npc — personagens da Fronteira.
• ${prefix}hablarnpc <nome> — conversa e vê missões.
• ${prefix}reputacion — relação com cada região.
• ${prefix}misionesfrontier — missões ativas.
• ${prefix}aceptarmision / ${prefix}entregarmision <id> — aceita ou entrega.
• ${prefix}recetas / ${prefix}fabricar <receita> — melhorias.

𝗦𝗘𝗚𝗨𝗡𝗗𝗔 𝗥𝗘𝗦𝗦𝗢𝗡𝗔̂𝗡𝗖𝗜𝗔
• ${prefix}resonancia — segundo cenário único.
• ${prefix}iniciaresonancia / ${prefix}unirresonancia — monta o time.
• ${prefix}decidirresonancia <opção> — integrar, isolar ou reprogramar.

𝗧𝗘𝗠𝗣𝗢𝗥𝗔𝗗𝗔 𝗘 𝗠𝗨𝗡𝗗𝗢
• ${prefix}temporada / ${prefix}mundofrontier — estado global.
• ${prefix}clasificacionfrontier — ranking de prestígio.

Os comandos antigos de frutas, duelos, 2vs2, masmorras, guildas, mercado e bosses continuam ativos. Frontier adiciona mundo, equipamento e descoberta por cima.

Use ${prefix}ayuda frontier, ${prefix}ayuda combate ou ${prefix}ayuda social pra ver uma seção.`
    if (lang === 'en') return `${frontierTitulo('𝗙𝗥𝗢𝗡𝗧𝗜𝗘𝗥 𝗚𝗨𝗜𝗗𝗘', 'Explore. Learn. Find what the map hides.')}

𝗙𝗜𝗥𝗦𝗧 𝗦𝗧𝗘𝗣𝗦
• ${prefix}crearperfil — register your explorer.
• ${prefix}perfil — identity, rank and progress.
• ${prefix}mapa — known regions.
• ${prefix}viajar <region> — move to an unlocked region.
• ${prefix}explorar <region> — hunt monsters, mats and clues.

𝗙𝗥𝗢𝗡𝗧𝗜𝗘𝗥 𝗖𝗢𝗠𝗕𝗔𝗧
• ${prefix}atacarfrontera — hit the active chat encounter.
• ${prefix}frutafrontera — use your fruit skill on a boss.
• ${prefix}arte — use the equipped Art in a 1v1.
• ${prefix}defender — ready a shield for the next hit.
• ${prefix}huir — leave the current encounter.
• ${prefix}huirfrontera — leave a group Guardian.
• ${prefix}equipo — check equipped weapon.
• ${prefix}forjar <weapon> — craft weapons from mats.
• ${prefix}equipararma <weapon> — swap weapon.

𝗔𝗥𝗧𝗦 𝗔𝗡𝗗 𝗙𝗜𝗡𝗗𝗦
• ${prefix}artes — Combat Arts list.
• ${prefix}aprenderarte <art> — unlock an Art.
• ${prefix}equipararte <art> — prep an Art.
• ${prefix}combate — full loadout.
• ${prefix}pistas — signals found.
• ${prefix}escenarios — unique stages.
• ${prefix}rastrear — ask for a contextual clue.
• ${prefix}subzonas [region] — discovered coordinates.
• ${prefix}elites — high-risk signatures.

𝗚𝗨𝗔𝗥𝗗𝗜𝗔𝗡𝗦 𝗔𝗡𝗗 𝗦𝗢𝗩𝗘𝗥𝗘𝗜𝗚𝗡
• ${prefix}guardianes — the three chain fights.
• ${prefix}soberano — unique stage status.
• ${prefix}iniciarfrontera — start the stage in the group.
• ${prefix}unirsefrontera — join the boss team.
• ${prefix}decidirfrontera <option> — watch, break or seal.

𝗡𝗣𝗖𝗦 𝗔𝗡𝗗 𝗣𝗥𝗢𝗚𝗥𝗘𝗦𝗦
• ${prefix}npc — Frontier characters.
• ${prefix}hablarnpc <name> — talk and check jobs.
• ${prefix}reputacion — standing with each region.
• ${prefix}misionesfrontier — active jobs.
• ${prefix}aceptarmision / ${prefix}entregarmision <id> — accept or turn in.
• ${prefix}recetas / ${prefix}fabricar <recipe> — upgrades.

𝗦𝗘𝗖𝗢𝗡𝗗 𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗘
• ${prefix}resonancia — second unique stage.
• ${prefix}iniciaresonancia / ${prefix}unirresonancia — form the team.
• ${prefix}decidirresonancia <option> — integrate, isolate or reprogram.

𝗦𝗘𝗔𝗦𝗢𝗡 𝗔𝗡𝗗 𝗪𝗢𝗥𝗟𝗗
• ${prefix}temporada / ${prefix}mundofrontier — global status.
• ${prefix}clasificacionfrontier — prestige ranking.

Old fruit, duel, 2v2, dungeon, guild, market and boss commands stay live. Frontier adds a world, gear and discovery layer on top.

Use ${prefix}ayuda frontier, ${prefix}ayuda combate or ${prefix}ayuda social for one section.`
    return `${frontierTitulo('𝗚𝗨𝗜́𝗔 𝗗𝗘 𝗟𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗥𝗔', 'Explora. Aprende. Descubre lo que el mapa oculta.')}

𝗣𝗥𝗜𝗠𝗘𝗥𝗢𝗦 𝗣𝗔𝗦𝗢𝗦
• ${prefix}crearperfil — registra tu explorador.
• ${prefix}perfil — consulta tu identidad, rango y progreso.
• ${prefix}mapa — revisa las regiones conocidas.
• ${prefix}viajar <región> — desplázate a una región desbloqueada.
• ${prefix}explorar <región> — busca monstruos, materiales y pistas.

𝗖𝗢𝗠𝗕𝗔𝗧𝗘 𝗗𝗘 𝗟𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗥𝗔
• ${prefix}atacarfrontera — golpea al encuentro activo del chat.
• ${prefix}frutafrontera — usa la habilidad de tu fruta en un jefe.
• ${prefix}arte — usa el Arte equipado en un duelo 1v1.
• ${prefix}defender — prepara un escudo para el próximo impacto.
• ${prefix}huir — abandona el encuentro actual.
• ${prefix}huirfrontera — abandona un Guardián grupal.
• ${prefix}equipo — revisa tu arma equipada.
• ${prefix}forjar <arma> — fabrica armas con materiales.
• ${prefix}equipararma <arma> — cambia de arma.

𝗔𝗥𝗧𝗘𝗦 𝗬 𝗗𝗘𝗦𝗖𝗨𝗕𝗥𝗜𝗠𝗜𝗘𝗡𝗧𝗢𝗦
• ${prefix}artes — consulta las Artes de Combate.
• ${prefix}aprenderarte <arte> — desbloquea un arte.
• ${prefix}equipararte <arte> — prepara un arte.
• ${prefix}combate — revisa tu carga completa de combate.
• ${prefix}pistas — revisa señales obtenidas.
• ${prefix}escenarios — consulta tus escenarios únicos.
• ${prefix}rastrear — solicita una pista contextual.
• ${prefix}subzonas [región] — revisa coordenadas descubiertas.
• ${prefix}elites — consulta firmas de alto riesgo y recompensas.

𝗚𝗨𝗔𝗥𝗗𝗜𝗔𝗡𝗘𝗦 𝗬 𝗦𝗢𝗕𝗘𝗥𝗔𝗡𝗢
• ${prefix}guardianes — consulta los tres desafíos de la cadena.
• ${prefix}soberano — revisa el estado del escenario único.
• ${prefix}iniciarfrontera — inicia la etapa disponible en el grupo.
• ${prefix}unirsefrontera — entra al equipo del jefe.
• ${prefix}atacarfrontera — ataque físico grupal.
• ${prefix}frutafrontera — habilidad de tu fruta equipada.
• ${prefix}habilidadfrontera — Arte de Combate del encuentro.
• ${prefix}usarfrontera <objeto> — usa un consumible de expedición.
• ${prefix}decidirfrontera <opción> — observar, romper o sellar.
• ${prefix}huirfrontera — abandona el encuentro activo.

𝗡𝗣𝗖𝗦 𝗬 𝗣𝗥𝗢𝗚𝗥𝗘𝗦𝗜𝗢́𝗡
• ${prefix}npc — lista los personajes de la Frontera.
• ${prefix}hablarnpc <nombre> — conversa y consulta encargos.
• ${prefix}reputacion — muestra tu relación con cada región.
• ${prefix}misionesfrontier — consulta encargos activos.
• ${prefix}aceptarmision / ${prefix}entregarmision <id> — acepta o entrega.
• ${prefix}recetas / ${prefix}fabricar <receta> — mejoras avanzadas.

𝗦𝗘𝗚𝗨𝗡𝗗𝗔 𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔
• ${prefix}resonancia — consulta el segundo escenario único.
• ${prefix}iniciaresonancia / ${prefix}unirresonancia — forma el equipo.
• ${prefix}atacarresonancia — golpe físico del grupo.
• ${prefix}arteresonancia / ${prefix}frutaresonancia — usa tu carga.
• ${prefix}decidirresonancia <opción> — integrar, aislar o reprogramar.

𝗧𝗘𝗠𝗣𝗢𝗥𝗔𝗗𝗔 𝗬 𝗠𝗨𝗡𝗗𝗢
• ${prefix}temporada / ${prefix}mundofrontier — estado global.
• ${prefix}clasificacionfrontier — ranking de prestigio.

𝗖𝗢𝗠𝗣𝗔𝗧𝗜𝗕𝗜𝗟𝗜𝗗𝗔𝗗
Los comandos antiguos de frutas, duelos, 2vs2, mazmorras, gremios, mercado y bosses siguen activos durante la transición. Frontier añade una capa de mundo, equipo y descubrimiento sobre esa base.

Usa ${prefix}ayuda frontier, ${prefix}ayuda combate o ${prefix}ayuda social para consultar una sección concreta.`
}

// Interfaz móvil: los índices deben orientar; los comandos detallados viven en páginas breves.
function frontierMenuPrincipal(prefix, lang = 'es') {
    const L = (es, pt, en) => tr(lang, es, pt, en)
    return `${frontierTitulo(L('CENTRAL DE MANDO', 'CENTRAL DE COMANDO', 'COMMAND CENTER'), L('El Arca Inicial está lista para nuevos exploradores.', 'A Arca Inicial está pronta pra novos exploradores.', 'The Initial Ark is ready for new explorers.'), '◈')}

${frontierPanel(L('EMPEZAR', 'COMEÇAR', 'START'), [
    `${prefix}crearperfil · ${L('crea tu explorador', 'cria seu explorador', 'create your explorer')}`,
    `${prefix}inicio · ${L('zona de bienvenida', 'zona de boas-vindas', 'welcome zone')}`,
    `${prefix}orientacion · ${L('por dónde comenzar', 'por onde começar', 'where to start')}`,
    `${prefix}perfil · ${L('mira tu estado', 'veja seu estado', 'check your status')}`,
    `${prefix}frontera · ${L('abre las rutas', 'abre as rotas', 'open the routes')}`
], '✦')}

${frontierPanel(L('RUTAS DE FRONTIER', 'ROTAS DE FRONTIER', 'FRONTIER ROUTES'), [
    `${prefix}frontera explorar · ${L('mapa y viaje', 'mapa e viagem', 'map and travel')}`,
    `${prefix}frontera combate · ${L('carga y acción', 'carga e ação', 'loadout and action')}`,
    `${prefix}frontera progreso · ${L('armas y Artes', 'armas e Artes', 'weapons and Arts')}`,
    `${prefix}frontera comunidad · ${L('NPCs y misiones', 'NPCs e missões', 'NPCs and quests')}`,
    `${prefix}frontera desafios · ${L('jefes grupales', 'chefes em grupo', 'group bosses')}`,
    `${prefix}frontera archivo · ${L('señales y temporada', 'sinais e temporada', 'signals and season')}`
], '🧭')}

${frontierPanel(L('OTROS SISTEMAS', 'OUTROS SISTEMAS', 'OTHER SYSTEMS'), [
    `${prefix}wolfric · ${L('protocolo clásico', 'protocolo clássico', 'classic protocol')}`,
    `${prefix}wolfric media · ${L('descargas y stickers', 'downloads e figurinhas', 'downloads and stickers')}`,
    `${prefix}wolfric interactivo · ${L('acciones con otros jugadores', 'ações com outros jogadores', 'actions with other players')}`,
    `${prefix}ayuda social · ${L('gremio y mercado', 'guilda e mercado', 'guild and market')}`
], '◌')}

_${L('Abrí una ruta para ver solo lo que necesitás. Descargas:', 'Abre uma rota pra ver só o que você precisa. Downloads:', 'Open a route to see only what you need. Downloads:')} ${prefix}wolfric media_
`
}

function frontierGuiaInicial(prefix, tema = '', lang = 'es') {
    const q0 = frontierNormalizar(tema)
    const q = ({ guide: 'inicio', monsters: 'monstruos', monster: 'monstruos', borders: 'fronteras', regions: 'regiones', explore: 'explorar', gear: 'equipo', skills: 'habilidades', quests: 'misiones', farm: 'farmear', dungeons: 'mazmorras', dungeon: 'mazmorras' })[q0] || q0
    const volver = lang === 'pt' ? `\n_← Zona inicial: ${prefix}start` : lang === 'en' ? `\n_← Starter zone: ${prefix}start` : `\n_← Zona inicial: ${prefix}inicio`
    if (lang === 'pt') {
        if (!q || ['inicio', 'indice', 'menu'].includes(q)) return `${frontierTitulo('GUIA DO EXPLORADOR', 'O essencial antes de sair da Arca Inicial.', '📖')}

${frontierPanel('CONSULTAS', [
    `${prefix}guide monsters · tipos de inimigo e elites`,
    `${prefix}guide borders · regiões, níveis e locais`,
    `${prefix}guide explore · encontros, pistas e materiais`,
    `${prefix}guide gear · fruta, arma, Arte e itens`,
    `${prefix}guide quests · NPCs e progresso`,
    `${prefix}guide farm · créditos, EXP e materiais`,
    `${prefix}guide dungeons · cooperação e loot`
], '🧭')}${volver}`
        if (['monstruo', 'monstruos', 'elite', 'elites'].includes(q)) return `${frontierTitulo('GUIA · MONSTROS', 'Nem todo encontro se resolve igual.', '👹')}

${frontierPanel('LEITURA RÁPIDA', [
    'Monstros normais · aparecem ao explorar e dão materiais.',
    'Elites · mais HP, Bounty, prestígio e um item especial.',
    'Guardiões · desafios em grupo da história, não surgem ao acaso.',
    'Veja .elites antes de procurar uma variante especial.'
], '⚔️')}${volver}`
        if (['frontera', 'fronteras', 'region', 'regiones', 'ubicacion', 'ubicaciones'].includes(q)) return `${frontierTitulo('GUIA · FRONTEIRAS', 'Cada região tem nível mínimo e um propósito.', '🗺️')}

${frontierPanel('ROTA DO MUNDO', [
    'Arca Inicial · registro, Lira Voss e preparação.',
    'Planícies de Cinza · nível 3 · primeiro farm de Fragmentos de Cinza.',
    'Bosque Prismático · nível 8 · materiais raros e sinais complexos.',
    'Ruínas, Vale e Abismo · rotas de nível alto, Guardiões e risco.'
], '📍')}

${frontierPanel('NAVEGAR', [`${prefix}map · bloqueios`, `${prefix}travel <região> · muda de local`, `${prefix}subzones [região] · coordenadas`], '🧭')}${volver}`
        if (['explorar', 'exploracion', 'pista', 'pistas'].includes(q)) return `${frontierTitulo('GUIA · EXPLORAÇÃO', 'Uma exploração pode dar combate, material, sinal ou evento.', '🔎')}

${frontierPanel('CICLO DE EXPLORAÇÃO', [
    `1. ${prefix}travel <região> · escolha uma fronteira liberada.`,
    `2. ${prefix}explore <região> · ativa um encontro ou achado.`,
    `3. ${prefix}frontierattack · resolve um combate ativo.`,
    `4. ${prefix}gear e ${prefix}frontiermissions · use o que conseguiu.`
], '◈')}${volver}`
        if (['equipo', 'habilidad', 'habilidades', 'arma', 'artes'].includes(q)) return `${frontierTitulo('GUIA · EQUIPE E HABILIDADES', 'Sua carga junta quatro camadas.', '🧩')}

${frontierPanel('CARGA', [
    'Fruta · habilidade especial; troque com .equipfruit.',
    'Arma · dano e especialização; crie com .forge.',
    'Arte · técnica Frontier; veja com .arts.',
    'Itens · cura ou efeitos; veja com .inventory.'
], '✨')}

${frontierPanel('PREPARAR', [`${prefix}combat · carga ativa`, `${prefix}gear · armas e materiais`, `${prefix}skills · rota de desbloqueio`], '⚔️')}${volver}`
        if (['mision', 'misiones', 'npc'].includes(q)) return `${frontierTitulo('GUIA · MISSÕES', 'Os NPCs dão direção ao mundo, não só recompensa.', '📜')}

${frontierPanel('PRIMEIRA MISSÃO', [
    `Lira Voss está na Arca Inicial: ${prefix}talknpc Lira Voss.`,
    `Aceite com ${prefix}acceptquest <id>.`,
    `Veja o progresso com ${prefix}frontiermissions.`,
    `Entregue com ${prefix}turninquest <id> ao cumprir o objetivo.`
], '👥')}${volver}`
        if (['farmear', 'farm', 'economia'].includes(q)) return `${frontierTitulo('GUIA · FARM', 'Alterne créditos, experiência e materiais.', '💰')}

${frontierPanel('ROTA ESTÁVEL', [
    `${prefix}daily e ${prefix}work · créditos base.`,
    `${prefix}dungeon · EXP e loot em grupo.`,
    `${prefix}explore <região> · materiais, EXP e reputação.`,
    `${prefix}frontiermissions · objetivos com recompensa definida.`
], '⛏️')}${volver}`
        if (['mazmorra', 'mazmorras', 'cooperativo'].includes(q)) return `${frontierTitulo('GUIA · DUNGEONS', 'O progresso difícil se divide.', '🏰')}

${frontierPanel('ANTES DE ENTRAR', [
    `${prefix}combat · revise fruta, Arte e arma.`,
    `${prefix}dungeon · abra ou consulte o desafio.`,
    `${prefix}join · entre quando o grupo abrir.`,
    'Dungeons, 2v2 e Guardiões rendem mais com parceiros.'
], '🤝')}${volver}`
        return `${frontierTitulo('GUIA DO EXPLORADOR', 'Tema não reconhecido.', '⚠️')}\n\n${frontierPanel('TEMAS', [`${prefix}guide monsters`, `${prefix}guide borders`, `${prefix}guide explore`, `${prefix}guide gear`, `${prefix}guide quests`, `${prefix}guide farm`, `${prefix}guide dungeons`], '📖')}`
    }
    if (lang === 'en') {
        const back = `\n_← Starter zone: ${prefix}start`
        if (!q || ['inicio', 'indice', 'menu'].includes(q)) return `${frontierTitulo('EXPLORER GUIDE', 'The essentials before you leave the Initial Ark.', '📖')}

${frontierPanel('LOOKUPS', [
    `${prefix}guide monsters · enemy types and elites`,
    `${prefix}guide borders · regions, levels and places`,
    `${prefix}guide explore · encounters, clues and materials`,
    `${prefix}guide gear · fruit, weapon, Art and items`,
    `${prefix}guide quests · NPCs and progress`,
    `${prefix}guide farm · credits, EXP and materials`,
    `${prefix}guide dungeons · co-op and loot`
], '🧭')}${back}`
        if (['monstruo', 'monstruos', 'elite', 'elites'].includes(q)) return `${frontierTitulo('GUIDE · MONSTERS', 'Not every encounter plays the same.', '👹')}

${frontierPanel('QUICK READ', [
    'Normal monsters · show up while exploring and drop materials.',
    'Elites · more HP, Bounty, prestige and a special item.',
    'Guardians · story group fights, they do not spawn at random.',
    'Check .elites before hunting a special variant.'
], '⚔️')}${back}`
        if (['frontera', 'fronteras', 'region', 'regiones', 'ubicacion', 'ubicaciones'].includes(q)) return `${frontierTitulo('GUIDE · BORDERS', 'Each region has a min level and a job.', '🗺️')}

${frontierPanel('WORLD ROUTE', [
    'Initial Ark · register, Lira Voss and prep.',
    'Ash Plains · level 3 · first Ash Fragment farm.',
    'Prismatic Forest · level 8 · rare mats and complex signals.',
    'Ruins, Valley and Abyss · high-level routes, Guardians and risk.'
], '📍')}

${frontierPanel('NAVIGATE', [`${prefix}map · lockouts`, `${prefix}travel <region> · change place`, `${prefix}subzones [region] · coordinates`], '🧭')}${back}`
        if (['explorar', 'exploracion', 'pista', 'pistas'].includes(q)) return `${frontierTitulo('GUIDE · EXPLORATION', 'One explore can give a fight, a mat, a signal or an event.', '🔎')}

${frontierPanel('EXPLORE LOOP', [
    `1. ${prefix}travel <region> · pick an unlocked border.`,
    `2. ${prefix}explore <region> · trigger a fight or find.`,
    `3. ${prefix}frontierattack · resolve an active fight.`,
    `4. ${prefix}gear and ${prefix}frontiermissions · spend what you got.`
], '◈')}${back}`
        if (['equipo', 'habilidad', 'habilidades', 'arma', 'artes'].includes(q)) return `${frontierTitulo('GUIDE · GEAR AND SKILLS', 'Your loadout stacks four layers.', '🧩')}

${frontierPanel('LOADOUT', [
    'Fruit · special skill; swap with .equipfruit.',
    'Weapon · damage and specialty; craft with .forge.',
    'Art · Frontier technique; check with .arts.',
    'Items · heals or effects; check with .inventory.'
], '✨')}

${frontierPanel('PREP', [`${prefix}combat · active loadout`, `${prefix}gear · weapons and mats`, `${prefix}skills · unlock route`], '⚔️')}${back}`
        if (['mision', 'misiones', 'npc'].includes(q)) return `${frontierTitulo('GUIDE · QUESTS', 'NPCs steer the world, they are not just loot piñatas.', '📜')}

${frontierPanel('FIRST JOB', [
    `Lira Voss is in the Initial Ark: ${prefix}talknpc Lira Voss.`,
    `Accept with ${prefix}acceptquest <id>.`,
    `Track it with ${prefix}frontiermissions.`,
    `Turn in with ${prefix}turninquest <id> when you finish the goal.`
], '👥')}${back}`
        if (['farmear', 'farm', 'economia'].includes(q)) return `${frontierTitulo('GUIDE · FARM', 'Rotate credits, EXP and materials.', '💰')}

${frontierPanel('STABLE ROUTE', [
    `${prefix}daily and ${prefix}work · base credits.`,
    `${prefix}dungeon · group EXP and loot.`,
    `${prefix}explore <region> · mats, EXP and reputation.`,
    `${prefix}frontiermissions · jobs with a set payout.`
], '⛏️')}${back}`
        if (['mazmorra', 'mazmorras', 'cooperativo'].includes(q)) return `${frontierTitulo('GUIDE · DUNGEONS', 'The hard progress gets shared.', '🏰')}

${frontierPanel('BEFORE YOU GO IN', [
    `${prefix}combat · check fruit, Art and weapon.`,
    `${prefix}dungeon · open or check the challenge.`,
    `${prefix}join · hop in when a group opens.`,
    'Dungeons, 2v2 and Guardians pay more with partners.'
], '🤝')}${back}`
        return `${frontierTitulo('EXPLORER GUIDE', 'Unknown topic.', '⚠️')}\n\n${frontierPanel('TOPICS', [`${prefix}guide monsters`, `${prefix}guide borders`, `${prefix}guide explore`, `${prefix}guide gear`, `${prefix}guide quests`, `${prefix}guide farm`, `${prefix}guide dungeons`], '📖')}`
    }
    if (!q || ['inicio', 'indice', 'menu'].includes(q)) return `${frontierTitulo('GUÍA DEL EXPLORADOR', 'Todo lo esencial antes de dejar el Arca Inicial.', '📖')}

${frontierPanel('CONSULTAS', [
    `${prefix}guia monstruos · tipos de enemigo y élites`,
    `${prefix}guia fronteras · regiones, niveles y ubicaciones`,
    `${prefix}guia explorar · encuentros, pistas y materiales`,
    `${prefix}guia equipo · fruta, arma, Arte e ítems`,
    `${prefix}guia misiones · NPCs y progreso`,
    `${prefix}guia farmear · créditos, EXP y materiales`,
    `${prefix}guia mazmorras · cooperación y botín`
], '🧭')}${volver}`
    if (['monstruo', 'monstruos', 'elite', 'elites'].includes(q)) return `${frontierTitulo('GUÍA · MONSTRUOS', 'No todos los encuentros se resuelven igual.', '👹')}

${frontierPanel('LECTURA RÁPIDA', [
    'Monstruos normales · aparecen al explorar y entregan materiales.',
    'Élites · tienen más HP, Bounty, prestigio y un objeto especial.',
    'Guardianes · desafíos grupales de la historia, no aparecen al azar.',
    'Revisa .elites antes de buscar una variante especial.'
], '⚔️')}${volver}`
    if (['frontera', 'fronteras', 'region', 'regiones', 'ubicacion', 'ubicaciones'].includes(q)) return `${frontierTitulo('GUÍA · FRONTERAS', 'Cada región tiene un nivel mínimo y un propósito.', '🗺️')}

${frontierPanel('RUTA DEL MUNDO', [
    'Arca Inicial · registro, Lira Voss y preparación.',
    'Llanuras de Ceniza · nivel 3 · primer farmeo de Fragmentos de Ceniza.',
    'Bosque Prismático · nivel 8 · materiales raros y señales complejas.',
    'Ruinas, Valle y Abismo · rutas de nivel alto, Guardianes y riesgo.'
], '📍')}

${frontierPanel('NAVEGAR', [`${prefix}mapa · consulta bloqueos`, `${prefix}viajar <región> · cambia de ubicación`, `${prefix}subzonas [región] · revisa coordenadas`], '🧭')}${volver}`
    if (['explorar', 'exploracion', 'pista', 'pistas'].includes(q)) return `${frontierTitulo('GUÍA · EXPLORACIÓN', 'Una exploración puede darte combate, material, señal o evento.', '🔎')}

${frontierPanel('CICLO DE EXPLORACIÓN', [
    `1. ${prefix}viajar <región> · elige una frontera desbloqueada.`,
    `2. ${prefix}explorar <región> · activa un encuentro o hallazgo.`,
    `3. ${prefix}atacarfrontera · resuelve un combate activo.`,
    `4. ${prefix}equipo y ${prefix}misionesfrontier · usa lo obtenido.`
], '◈')}${volver}`
    if (['equipo', 'habilidad', 'habilidades', 'arma', 'artes'].includes(q)) return `${frontierTitulo('GUÍA · EQUIPO Y HABILIDADES', 'Tu carga combina cuatro capas.', '🧩')}

${frontierPanel('CARGA', [
    'Fruta · habilidad especial; se cambia con .equiparfruta.',
    'Arma · daño y especialización; se crea con .forjar.',
    'Arte · técnica Frontier; se consulta con .artes.',
    'Ítems · recuperación o efectos; se revisan con .inventario.'
], '✨')}

${frontierPanel('PREPARARTE', [`${prefix}combate · carga activa`, `${prefix}equipo · armas y materiales`, `${prefix}habilidades · ruta de desbloqueo`], '⚔️')}${volver}`
    if (['mision', 'misiones', 'npc'].includes(q)) return `${frontierTitulo('GUÍA · MISIONES', 'Los NPCs dan dirección al mundo, no solo recompensas.', '📜')}

${frontierPanel('PRIMER ENCARGO', [
    `Lira Voss está en el Arca Inicial: ${prefix}hablarnpc Lira Voss.`,
    `Acepta con ${prefix}aceptarmision <id>.`,
    `Consulta progreso con ${prefix}misionesfrontier.`,
    `Entrega con ${prefix}entregarmision <id> al cumplir el objetivo.`
], '👥')}${volver}`
    if (['farmear', 'farm', 'economia'].includes(q)) return `${frontierTitulo('GUÍA · FARMEO', 'Alterna créditos, experiencia y materiales.', '💰')}

${frontierPanel('RUTA ESTABLE', [
    `${prefix}daily y ${prefix}work · créditos de base.`,
    `${prefix}mazmorra · EXP y botín cooperativo.`,
    `${prefix}explorar <región> · materiales, EXP y reputación.`,
    `${prefix}misionesfrontier · objetivos con recompensa definida.`
], '⛏️')}${volver}`
    if (['mazmorra', 'mazmorras', 'cooperativo'].includes(q)) return `${frontierTitulo('GUÍA · MAZMORRAS', 'El progreso difícil se comparte.', '🏰')}

${frontierPanel('ANTES DE ENTRAR', [
    `${prefix}combate · revisa fruta, Arte y arma.`,
    `${prefix}mazmorra · abre o consulta el desafío.`,
    `${prefix}unirme · participa cuando un grupo la inició.`,
    'Las mazmorras, 2v2 y Guardianes son mejores con compañeros.'
], '🤝')}${volver}`
    return `${frontierTitulo('GUÍA DEL EXPLORADOR', 'Tema no reconocido.', '⚠️')}\n\n${frontierPanel('TEMAS DISPONIBLES', [`${prefix}guia monstruos`, `${prefix}guia fronteras`, `${prefix}guia explorar`, `${prefix}guia equipo`, `${prefix}guia misiones`, `${prefix}guia farmear`, `${prefix}guia mazmorras`], '📖')}`
}

function frontierZonaInicial(user, prefijo = prefix, opcion = '', lang = 'es') {
    const f = frontierInicializar(user)
    const tutorial = frontierTutorial(user)
    const q0 = frontierNormalizar(opcion)
    const q = ({ guide: 'guia', skills: 'habilidades', gear: 'equipo', complete: 'completar', done: 'completar' })[q0] || q0
    if (lang === 'pt') {
        if (!q || ['inicio', 'menu', 'zona'].includes(q)) return `${frontierTitulo('ARCA INICIAL', 'Seu ponto de partida. Nenhuma rota fica fechada para sempre.', '🏙️')}

${frontierPanel('DUAS ABERTURAS', [
    `${prefijo}start guide · monstros, fronteiras, exploração e locais.`,
    `${prefijo}start skills · dungeons, Artes, equipamento e preparação.`
], '🚪')}

${frontierPanel('LIBERDADE DE ROTA', [
    `${prefijo}orientation · recomendação conforme seu progresso.`,
    `${prefijo}start complete · feche o tutorial depois de ver as duas aberturas.`,
    `Estado: ${tutorial.estado === 'completado' ? 'percurso concluído' : 'percurso opcional em andamento'}.`
], '🧭')}`
        if (['habilidad', 'habilidades', 'equipo'].includes(q)) {
            frontierTutorialRegistrarPaso(user, 'ruta:habilidades')
            return `${frontierTitulo('ABERTURA · HABILIDADES', 'Conheça sua carga antes de escolher como crescer.', '⚔️')}

${frontierPanel('O QUE VOCÊ JÁ TEM', [
    'Punhos de Novato · arma inicial que não quebra.',
    'Corte Básico · Arte inicial sem custo.',
    'Fruta de boas-vindas · sua primeira habilidade especial.',
    `Use ${prefijo}combat para ver sua carga real.`
], '🧩')}

${frontierPanel('O QUE ABRE DEPOIS', [
    `${prefijo}arts e ${prefijo}learnart <arte> · técnicas.`,
    `${prefijo}gear e ${prefijo}forge <arma> · materiais e armas.`,
    `${prefijo}dungeon e ${prefijo}duel2v2 · loot em grupo.`,
    `${prefijo}start guide · volta à explicação do mundo.`
], '✨')}`
        }
        if (['completar', 'terminar', 'listo'].includes(q)) {
            const resultado = frontierTutorialCompletar(user)
            return `${frontierTitulo(resultado.ok ? 'PERCURSO REGISTRADO' : 'PERCURSO INCOMPLETO', 'A Arca não decide seu caminho; só organiza.', resultado.ok ? '✦' : '⚠️')}\n\n${frontierPanel('ESTADO', [resultado.texto, `Próxima recomendação: ${prefijo}orientation.`], resultado.ok ? '🏆' : '🧭')}`
        }
        if (!( !q || ['inicio', 'menu', 'zona', 'guia'].includes(q) || ['habilidad', 'habilidades', 'equipo'].includes(q) || ['completar', 'terminar', 'listo'].includes(q))) {
            return `${frontierTitulo('ARCA INICIAL', 'Abertura não reconhecida.', '⚠️')}\n\n${frontierPanel('ROTAS', [`${prefijo}start guide`, `${prefijo}start skills`, `${prefijo}start complete`, `${prefijo}orientation`], '🧭')}`
        }
    }
    if (lang === 'en') {
        if (!q || ['inicio', 'menu', 'zona'].includes(q)) return `${frontierTitulo('INITIAL ARK', 'Your starting point. No route stays locked forever.', '🏙️')}

${frontierPanel('TWO OPENINGS', [
    `${prefijo}start guide · monsters, borders, exploration and places.`,
    `${prefijo}start skills · dungeons, Arts, gear and prep.`
], '🚪')}

${frontierPanel('ROUTE FREEDOM', [
    `${prefijo}orientation · a tip based on your progress.`,
    `${prefijo}start complete · close the tutorial after you saw both openings.`,
    `Status: ${tutorial.estado === 'completado' ? 'route completed' : 'optional route still open'}.`
], '🧭')}`
        if (['habilidad', 'habilidades', 'equipo'].includes(q)) {
            frontierTutorialRegistrarPaso(user, 'ruta:habilidades')
            return `${frontierTitulo('OPENING · SKILLS', 'Know your loadout before you pick how to grow.', '⚔️')}

${frontierPanel('WHAT YOU ALREADY HAVE', [
    'Novice Fists · starter weapon that does not break.',
    'Basic Cut · starter Art with no cost.',
    'Welcome fruit · your first special skill.',
    `Use ${prefijo}combat to see your real loadout.`
], '🧩')}

${frontierPanel('WHAT OPENS LATER', [
    `${prefijo}arts and ${prefijo}learnart <art> · techniques.`,
    `${prefijo}gear and ${prefijo}forge <weapon> · mats and weapons.`,
    `${prefijo}dungeon and ${prefijo}duel2v2 · group loot.`,
    `${prefijo}start guide · back to the world explainer.`
], '✨')}`
        }
        if (['completar', 'terminar', 'listo'].includes(q)) {
            const resultado = frontierTutorialCompletar(user)
            return `${frontierTitulo(resultado.ok ? 'ROUTE LOGGED' : 'ROUTE INCOMPLETE', 'The Ark does not pick your path; it just sorts it.', resultado.ok ? '✦' : '⚠️')}\n\n${frontierPanel('STATUS', [resultado.texto, `Next tip: ${prefijo}orientation.`], resultado.ok ? '🏆' : '🧭')}`
        }
        if (!( !q || ['inicio', 'menu', 'zona', 'guia'].includes(q) || ['habilidad', 'habilidades', 'equipo'].includes(q) || ['completar', 'terminar', 'listo'].includes(q))) {
            return `${frontierTitulo('INITIAL ARK', 'Unknown opening.', '⚠️')}\n\n${frontierPanel('ROUTES', [`${prefijo}start guide`, `${prefijo}start skills`, `${prefijo}start complete`, `${prefijo}orientation`], '🧭')}`
        }
    }
    if (!q || ['inicio', 'menu', 'zona'].includes(q)) return `${frontierTitulo('ARCA INICIAL', 'Tu punto de partida. Ninguna ruta está cerrada para siempre.', '🏙️')}

${frontierPanel('DOS APERTURAS', [
    `${prefijo}inicio guia · monstruos, fronteras, exploración y ubicaciones.`,
    `${prefijo}inicio habilidades · mazmorras, Artes, equipo y preparación.`
], '🚪')}

${frontierPanel('LIBERTAD DE RUTA', [
    `${prefijo}orientacion · recomendación según tu progreso.`,
    `${prefijo}inicio completar · reclama el cierre del tutorial al ver ambas aperturas.`,
    `Estado: ${tutorial.estado === 'completado' ? 'recorrido completado' : 'recorrido opcional en curso'}.`
], '🧭')}`
    if (q === 'guia') {
        frontierTutorialRegistrarPaso(user, 'ruta:guia')
        return `${frontierGuiaInicial(prefijo, '', lang)}\n\n${frontierPanel(lang === 'pt' ? 'PRÓXIMA ABERTURA' : lang === 'en' ? 'NEXT OPENING' : 'SIGUIENTE APERTURA', [lang === 'pt' ? `Abra ${prefijo}start skills quando terminar de ler.` : lang === 'en' ? `Open ${prefijo}start skills when you finish reading.` : `Abre ${prefijo}inicio habilidades cuando termines de leer.`, lang === 'pt' ? `Peça uma recomendação com ${prefijo}orientation.` : lang === 'en' ? `Ask for a tip with ${prefijo}orientation.` : `Puedes pedir una recomendación con ${prefijo}orientacion.`], '→')}`
    }
    if (['habilidad', 'habilidades', 'equipo'].includes(q)) {
        frontierTutorialRegistrarPaso(user, 'ruta:habilidades')
        return `${frontierTitulo('APERTURA · HABILIDADES', 'Conocé tu carga antes de elegir cómo crecer.', '⚔️')}

${frontierPanel('LO QUE YA TIENES', [
    'Puños de Novato · arma inicial que no se rompe.',
    'Corte Básico · Arte inicial sin coste.',
    'Fruta de bienvenida · tu primera habilidad especial.',
    `Usa ${prefijo}combate para revisar tu carga real.`
], '🧩')}

${frontierPanel('LO QUE SE ABRE DESPUÉS', [
    `${prefijo}artes y ${prefijo}aprenderarte <arte> · técnicas.`,
    `${prefijo}equipo y ${prefijo}forjar <arma> · materiales y armas.`,
    `${prefijo}mazmorra y ${prefijo}duel2v2 · botín cooperativo.`,
    `${prefijo}inicio guia · vuelve a la explicación del mundo.`
], '✨')}`
    }
    if (['completar', 'terminar', 'listo'].includes(q)) {
        const resultado = frontierTutorialCompletar(user)
        return `${frontierTitulo(resultado.ok ? 'RECORRIDO REGISTRADO' : 'RECORRIDO INCOMPLETO', 'El Arca no decide tu camino; solo lo ordena.', resultado.ok ? '✦' : '⚠️')}\n\n${frontierPanel('ESTADO', [resultado.texto, `Siguiente recomendación: ${prefijo}orientacion.`], resultado.ok ? '🏆' : '🧭')}`
    }
    return `${frontierTitulo('ARCA INICIAL', 'Apertura no reconocida.', '⚠️')}\n\n${frontierPanel('RUTAS', [`${prefijo}inicio guia`, `${prefijo}inicio habilidades`, `${prefijo}inicio completar`, `${prefijo}orientacion`], '🧭')}`
}

function frontierGuiaMovil(prefix, categoria = '', lang = 'es') {
    const L = (es, pt, en) => tr(lang, es, pt, en)
    const q = frontierNormalizar(categoria).replace(/\s+/g, '-')
    const volver = `\n_← ${L('Volver', 'Voltar', 'Back')}: ${prefix}frontera`
    if (!q || ['inicio', 'menu', 'indice', 'guia', 'frontier'].includes(q)) return `${frontierMenuPrincipal(prefix, lang)}\n\n_${L('Atajo', 'Atalho', 'Shortcut')}: ${prefix}frontera explorar_`
    if (['explorar', 'exploracion', 'rutas'].includes(q)) return `${frontierTitulo(L('RUTA DE EXPLORACIÓN', 'ROTA DE EXPLORAÇÃO', 'EXPLORATION ROUTE'), L('El mundo se abre paso a paso.', 'O mundo se abre passo a passo.', 'The world opens one step at a time.'), '🧭')}

${frontierPanel(L('ORIENTACIÓN', 'ORIENTAÇÃO', 'ORIENTATION'), [
    `${prefix}profile · ${L('rango y posición', 'rank e posição', 'rank and position')}`,
    `${prefix}map · ${L('regiones conocidas', 'regiões conhecidas', 'known regions')}`,
    `${prefix}travel <región> · ${L('cambia de zona', 'muda de zona', 'change zone')}`,
    `${prefix}explore <región> · ${L('busca actividad', 'procura atividade', 'look for activity')}`
], '◈')}

${frontierPanel(L('SEÑALES DE RIESGO', 'SINAIS DE RISCO', 'RISK SIGNALS'), [
    `${prefix}subzones [región] · ${L('coordenadas', 'coordenadas', 'coordinates')}`,
    `${prefix}elites · ${L('objetivos especiales', 'alvos especiais', 'special targets')}`,
    `${prefix}track · ${L('pista contextual', 'pista contextual', 'contextual clue')}`
], '⚑')}${volver}`
    if (['combate', 'batalla'].includes(q)) return `${frontierTitulo(L('RUTA DE COMBATE', 'ROTA DE COMBATE', 'COMBAT ROUTE'), L('Revisá tu carga antes de entrar.', 'Revisa sua carga antes de entrar.', 'Check your loadout before you go in.'), '⚔')}

${frontierPanel(L('PREPARACIÓN', 'PREPARAÇÃO', 'PREP'), [
    `${prefix}combat · ${L('fruta, arma y Arte', 'fruta, arma e Arte', 'fruit, weapon and Art')}`,
    `${prefix}gear · ${L('carga equipada', 'carga equipada', 'equipped loadout')}`,
    `${prefix}arts · ${L('Artes disponibles', 'Artes disponíveis', 'available Arts')}`
], '✦')}

${frontierPanel(L('ENCUENTRO ACTIVO', 'ENCONTRO ATIVO', 'ACTIVE ENCOUNTER'), [
    `${prefix}frontierattack · ${L('golpe físico', 'golpe físico', 'physical hit')}`,
    `${prefix}arte · ${L('Arte en duelo', 'Arte no duelo', 'Art in a duel')}`,
    `${prefix}defend · ${L('prepara escudo', 'prepara escudo', 'ready a shield')}`,
    `${prefix}run · ${L('abandona encuentro', 'abandona o encontro', 'leave the encounter')}`,
    `${prefix}frontieruse <objeto> · ${L('apoyo', 'apoio', 'support')}`
], '⚔')}${volver}`
    if (['progreso', 'equipo', 'forja'].includes(q)) return `${frontierTitulo(L('RUTA DE PROGRESO', 'ROTA DE PROGRESSO', 'PROGRESS ROUTE'), L('Tu equipo decide hasta dónde llegás.', 'Seu equipamento decide até onde você chega.', 'Your gear decides how far you get.'), '✦')}

${frontierPanel(L('EQUIPAMIENTO', 'EQUIPAMENTO', 'GEAR'), [
    `${prefix}gear · ${L('carga y materiales', 'carga e materiais', 'loadout and mats')}`,
    `${prefix}forge <arma> · ${L('crea un arma', 'cria uma arma', 'craft a weapon')}`,
    `${prefix}equipweapon <arma> · ${L('cambia arma', 'troca arma', 'swap weapon')}`,
    `${prefix}recipes · ${L('mejoras disponibles', 'melhorias disponíveis', 'available upgrades')}`,
    `${prefix}craft <receta> · ${L('mejora arma', 'melhora arma', 'upgrade weapon')}`
], '🛠')}

${frontierPanel(L('ARTES', 'ARTES', 'ARTS'), [
    `${prefix}arts · ${L('consulta el catálogo', 'veja o catálogo', 'browse the catalog')}`,
    `${prefix}learnart <arte> · ${L('desbloquea', 'desbloqueia', 'unlock')}`,
    `${prefix}equipart <arte> · ${L('prepara', 'prepara', 'equip')}`
], '✧')}${volver}`
    if (['comunidad', 'npc', 'misiones'].includes(q)) return `${frontierTitulo(L('RUTA DE COMUNIDAD', 'ROTA DE COMUNIDADE', 'COMMUNITY ROUTE'), L('Cada región recuerda tus decisiones.', 'Cada região lembra das suas escolhas.', 'Each region remembers your choices.'), '◌')}

${frontierPanel(L('CONTACTOS', 'CONTATOS', 'CONTACTS'), [
    `${prefix}npc · ${L('lista personajes', 'lista personagens', 'list characters')}`,
    `${prefix}talknpc <nombre> · ${L('conversa', 'conversa', 'talk')}`,
    `${prefix}reputation · ${L('vínculo regional', 'vínculo regional', 'regional standing')}`
], '☏')}

${frontierPanel(L('ENCARGOS', 'MISSÕES', 'QUESTS'), [
    `${prefix}frontiermissions · ${L('misiones', 'missões', 'quests')}`,
    `${prefix}acceptquest <id> · ${L('acepta', 'aceita', 'accept')}`,
    `${prefix}turninquest <id> · ${L('entrega', 'entrega', 'turn in')}`
], '⌁')}${volver}`
    if (['desafios', 'desafios', 'jefes', 'jefe'].includes(q)) return `${frontierTitulo(L('DESAFÍOS DE GRUPO', 'DESAFIOS EM GRUPO', 'GROUP CHALLENGES'), L('Los escenarios no se vencen solo.', 'Os cenários não se vencem sozinho.', 'These stages are not solo clears.'), '⚑')}

${frontierPanel(L('CADENA PRIMORDIAL', 'CADEIA PRIMORDIAL', 'PRIMORDIAL CHAIN'), [
    `${prefix}guardians · ${L('progreso de jefes', 'progresso dos chefes', 'boss progress')}`,
    `${prefix}sovereign · ${L('estado del escenario', 'estado do cenário', 'stage status')}`,
    `${prefix}frontera guardian · ${L('acciones', 'ações', 'actions')}`
], '⚔')}

${frontierPanel(L('SEGUNDA RESONANCIA', 'SEGUNDA RESSONÂNCIA', 'SECOND RESONANCE'), [
    `${prefix}resonance · ${L('estado del jardín', 'estado do jardim', 'garden status')}`,
    `${prefix}frontera resonancia · ${L('acciones', 'ações', 'actions')}`
], '✦')}${volver}`
    if (['guardian', 'guardianes', 'soberano'].includes(q)) return `${frontierTitulo(L('CADENA DE GUARDIANES', 'CADEIA DE GUARDIÕES', 'GUARDIAN CHAIN'), L('Formá un equipo. Leé el patrón.', 'Monta um time. Lê o padrão.', 'Form a team. Read the pattern.'), '⚔')}

${frontierPanel(L('ANTES DE EMPEZAR', 'ANTES DE COMEÇAR', 'BEFORE YOU START'), [
    `${prefix}guardians · ${L('revisa etapas', 'veja as etapas', 'check stages')}`,
    `${prefix}sovereign · ${L('mira el estado', 'veja o estado', 'check status')}`,
    `${prefix}frontierstart · ${L('abre etapa', 'abre a etapa', 'open the stage')}`,
    `${prefix}frontierjoin · ${L('entra al grupo', 'entra no grupo', 'join the group')}`
], '◈')}

${frontierPanel(L('DURANTE EL JEFE', 'DURANTE O CHEFE', 'DURING THE BOSS'), [
    `${prefix}frontierattack · ${L('golpe', 'golpe', 'hit')}`,
    `${prefix}frontierskill · ${L('usa Arte', 'usa Arte', 'use Art')}`,
    `${prefix}frontierfruit · ${L('usa fruta', 'usa fruta', 'use fruit')}`,
    `${prefix}frontieruse <objeto> · ${L('apoyo', 'apoio', 'support')}`,
    `${prefix}frontierdecide <opción> · ${L('resuelve', 'resolve', 'resolve')}`,
    `${prefix}frontierrun · ${L('abandona', 'abandona', 'leave')}`
], '⚔')}${volver}`
    if (['resonancia', 'segunda-resonancia'].includes(q)) return `${frontierTitulo(L('SEGUNDA RESONANCIA', 'SEGUNDA RESSONÂNCIA', 'SECOND RESONANCE'), L('El Jardín recuerda a quien entra.', 'O Jardim lembra de quem entra.', 'The Garden remembers who walks in.'), '✦')}

${frontierPanel(L('PREPARAR EQUIPO', 'PREPARAR TIME', 'PREP THE TEAM'), [
    `${prefix}resonance · ${L('consulta estado', 'veja o estado', 'check status')}`,
    `${prefix}startresonance · ${L('abre evento', 'abre o evento', 'open the event')}`,
    `${prefix}joinresonance · ${L('entra al grupo', 'entra no grupo', 'join the group')}`
], '◈')}

${frontierPanel(L('DURANTE EL EVENTO', 'DURANTE O EVENTO', 'DURING THE EVENT'), [
    `${prefix}attackresonance · ${L('golpe', 'golpe', 'hit')}`,
    `${prefix}artresonance · ${L('usa Arte', 'usa Arte', 'use Art')}`,
    `${prefix}fruitresonance · ${L('usa fruta', 'usa fruta', 'use fruit')}`,
    `${prefix}decideresonance <opción> · ${L('decide', 'decide', 'decide')}`,
    `${prefix}runresonance · ${L('abandona', 'abandona', 'leave')}`
], '⚔')}${volver}`
    if (['archivo', 'mundo', 'temporada'].includes(q)) return `${frontierTitulo(L('ARCHIVO DE LA SEÑAL', 'ARQUIVO DO SINAL', 'SIGNAL ARCHIVE'), L('Hay datos que se descubren jugando.', 'Tem dado que só aparece jogando.', 'Some data only shows up by playing.'), '⌁')}

${frontierPanel(L('REGISTROS PERSONALES', 'REGISTROS PESSOAIS', 'PERSONAL LOGS'), [
    `${prefix}clues · ${L('señales obtenidas', 'sinais obtidos', 'signals found')}`,
    `${prefix}stages · ${L('rutas únicas', 'rotas únicas', 'unique routes')}`,
    `${prefix}track · ${L('señal contextual', 'sinal contextual', 'contextual signal')}`
], '◌')}

${frontierPanel(L('REGISTROS DEL MUNDO', 'REGISTROS DO MUNDO', 'WORLD LOGS'), [
    `${prefix}season · ${L('estado actual', 'estado atual', 'current status')}`,
    `${prefix}frontierworld · ${L('actividad global', 'atividade global', 'global activity')}`,
    `${prefix}frontierrank · ${L('prestigio', 'prestígio', 'prestige')}`
], '⚑')}${volver}`
    return `${frontierTitulo(L('RUTA NO IDENTIFICADA', 'ROTA NÃO IDENTIFICADA', 'UNKNOWN ROUTE'), L(`No existe «${categoria}».`, `Não existe «${categoria}».`, `«${categoria}» does not exist.`), '⚠')}

${frontierPanel(L('RUTAS DISPONIBLES', 'ROTAS DISPONÍVEIS', 'AVAILABLE ROUTES'), [
    `${prefix}frontera explorar`,
    `${prefix}frontera combate`,
    `${prefix}frontera progreso`,
    `${prefix}frontera comunidad`,
    `${prefix}frontera desafios`,
    `${prefix}frontera archivo`
], '🧭')}`
}

function frontierAyudaMovil(prefix, categoria = '', lang = 'es') {
    const L = (es, pt, en) => tr(lang, es, pt, en)
    const q = frontierNormalizar(categoria).replace(/\s+/g, '-')
    if (!q || ['frontier', 'mundo'].includes(q)) return frontierGuiaMovil(prefix, '', lang)
    if (['combate', 'equipo', 'explorar', 'progreso', 'guardian', 'guardianes', 'resonancia'].includes(q)) return frontierGuiaMovil(prefix, q, lang)
    if (q === 'social') return `${frontierTitulo(L('AYUDA SOCIAL', 'AJUDA SOCIAL', 'SOCIAL HELP'), L('Intercambiá sin perder el rumbo.', 'Troca sem perder o rumo.', 'Trade without losing the plot.'), '◌')}

${frontierPanel(L('COMUNIDAD Y COMERCIO', 'COMUNIDADE E COMÉRCIO', 'COMMUNITY AND TRADE'), [
    `${prefix}guild · ${L('crea o une un gremio', 'cria ou entra numa guilda', 'create or join a guild')}`,
    `${prefix}market · ${L('ventas de jugadores', 'vendas de jogadores', 'player listings')}`,
    `${prefix}sell · ${L('publica un objeto', 'publica um item', 'list an item')}`,
    `${prefix}trade @usuario <monto> · ${L('oferta', 'oferta', 'offer')}`,
    `${prefix}pay @usuario <monto> · ${L('transfiere', 'transfere', 'transfer')}`,
    `${prefix}bountytop · ranking`
], '⌁')}

_${L('Para el resto', 'Pro resto', 'For the rest')}: ${prefix}wolfric`
    return `${frontierTitulo(L('AYUDA', 'AJUDA', 'HELP'), L('Elegí una ruta corta.', 'Escolhe uma rota curta.', 'Pick a short route.'), '◈')}

${frontierPanel(L('CONSULTAS', 'CONSULTAS', 'LOOKUPS'), [
    `${prefix}frontera · ${L('índice del mundo', 'índice do mundo', 'world index')}`,
    `${prefix}ayuda combate · ${L('acciones', 'ações', 'actions')}`,
    `${prefix}ayuda equipo · ${L('equipamiento', 'equipamento', 'gear')}`,
    `${prefix}ayuda social · ${L('comercio', 'comércio', 'trade')}`,
    `${prefix}wolfric · ${L('sistemas clásicos', 'sistemas clássicos', 'classic systems')}`
], '✦')}`
}

function wolfricTitulo(titulo, subtitulo = '', icono = '◌') {
    // Header del menú clásico (.wolfric) SIN la franja de temporada / update
    return `» ˚₊*– ͟͞ 𝖂𝖔𝖑𝖋𝖗𝖎𝖈-🜲\n——————————————>\n╭━━⪩ *${titulo}* ⪨━━\n${subtitulo ? `> ❏ • ${subtitulo}\n` : ''}╰━━─「${icono}」─━━━━━━━━`
}

function menuAdminGrupo(prefix, lang = 'es') {
    if (lang === 'pt') {
        return `${wolfricTitulo('PAINEL DE ADMINISTRAÇÃO', 'Apenas admins do grupo.', '🛡️')}

${frontierPanel('MODERAÇÃO', [
    `${prefix}kick @usuario · remover`,
    `${prefix}ban @usuario · remover`,
    `${prefix}promote @usuario · dar admin`,
    `${prefix}demote @usuario · tirar admin`,
    `${prefix}tagall [texto] · mencionar todos`,
    `${prefix}hidetag [texto] · menção oculta`,
    `${prefix}open · abrir grupo`,
    `${prefix}close · fechar grupo`,
    `${prefix}warn @usuario · advertir`,
    `${prefix}warns @usuario · ver advertências`,
    `${prefix}unwarn @usuario · tirar advertência`,
    `${prefix}antilink on/off · apagar links + warn`,
    `${prefix}antispam on/off · anti flood`,
    `${prefix}welcome on/off · boas-vindas`,
    `${prefix}setwelcome texto · texto (@user)`,
    `${prefix}goodbye on/off · despedida`,
    `${prefix}setgoodbye texto · texto de saída`,
    `${prefix}grupo · ver proteções`,
    `${prefix}on/off · ligar ou desligar o bot só neste grupo`,
    `${prefix}desactivar/activar <cmd ou categoria> · desligar só uma parte`,
    `${prefix}desactivar rpg · desliga TODO o jogo aqui`,
    `${prefix}desactivados · ver o que está desligado aqui`,
    `${prefix}antiraid on/off · alerta de entradas em massa`,
    `${prefix}antipeleas on/off · IA detecta brigas`,
    `${prefix}iachat on/off · o bot conversa como um membro (IA)`,
    `${prefix}torneo crear|unirse|cerrar|reportar|estado · modo torneio`
], '⚔')}

${frontierPanel('INFO', [
    `${prefix}admin · este menu`,
    `${prefix}groupinfo · info do grupo`
], '⌁')}`
    }
    if (lang === 'en') {
        return `${wolfricTitulo('ADMIN PANEL', 'Group admins only.', '🛡️')}

${frontierPanel('MODERATION', [
    `${prefix}kick @user · kick`,
    `${prefix}ban @user · kick`,
    `${prefix}promote @user · give admin`,
    `${prefix}demote @user · remove admin`,
    `${prefix}tagall [text] · mention everyone`,
    `${prefix}hidetag [text] · hidden mention`,
    `${prefix}open · open group`,
    `${prefix}close · lock group`,
    `${prefix}warn @user · warn`,
    `${prefix}warns @user · see warnings`,
    `${prefix}unwarn @user · remove a warning`,
    `${prefix}antilink on/off · delete links + warn (15 = ban)`,
    `${prefix}antispam on/off · anti flood`,
    `${prefix}welcome on/off · welcome`,
    `${prefix}setwelcome text · text (@user)`,
    `${prefix}goodbye on/off · goodbye`,
    `${prefix}setgoodbye text · leave text`,
    `${prefix}grupo · see protections`,
    `${prefix}on/off · turn the bot on or off only in this group`,
    `${prefix}desactivar/activar <cmd or category> · turn off just one part`,
    `${prefix}desactivar rpg · turns OFF the whole game here, leaves group/media/AI`,
    `${prefix}desactivados · see what is off here`,
    `${prefix}antiraid on/off · mass-join alert`,
    `${prefix}antipeleas on/off · AI spots fights and locks the group a bit (no real strike)`,
    `${prefix}iachat on/off · the bot chats like a member (AI)`,
    `${prefix}torneo crear|unirse|cerrar|reportar|estado · tournament mode`
], '⚔')}

${frontierPanel('INFO', [
    `${prefix}admin · this menu`,
    `${prefix}groupinfo · group info`
], '⌁')}`
    }
    return `${wolfricTitulo('PANEL DE ADMINISTRACIÓN', 'Solo admins del grupo.', '🛡️')}

${frontierPanel('MODERACIÓN', [
    `${prefix}kick @usuario · expulsar`,
    `${prefix}ban @usuario · expulsar`,
    `${prefix}promote @usuario · dar admin`,
    `${prefix}demote @usuario · quitar admin`,
    `${prefix}tagall [texto] · mencionar a todos`,
    `${prefix}hidetag [texto] · mencionar oculto`,
    `${prefix}open · abrir grupo`,
    `${prefix}close · cerrar grupo`,
    `${prefix}warn @usuario · advertir`,
    `${prefix}warns @usuario · ver advertencias`,
    `${prefix}unwarn @usuario · quitar advertencia`,
    `${prefix}antilink on/off · borrar links + warn (15 = ban)`,
    `${prefix}antispam on/off · anti flood`,
    `${prefix}welcome on/off · bienvenida`,
    `${prefix}setwelcome texto · texto (@user)`,
    `${prefix}goodbye on/off · despedida`,
    `${prefix}setgoodbye texto · texto salida`,
    `${prefix}grupo · ver protecciones`,
    `${prefix}on/off · encender o apagar el bot solo en este grupo`,
    `${prefix}desactivar/activar <cmd o categoría> · apagar solo una parte`,
    `${prefix}desactivar rpg · apaga TODO el juego acá, deja solo grupo/media/IA`,
    `${prefix}desactivados · ver qué está apagado acá`,
    `${prefix}antiraid on/off · alerta por entradas masivas sospechosas`,
    `${prefix}antipeleas on/off · IA detecta peleas y cierra el grupo un rato (sin strike real)`,
    `${prefix}iachat on/off · el bot charla como uno más (IA)`,
    `${prefix}torneo crear|unirse|cerrar|reportar|estado · modo torneo`
], '⚔')}

${frontierPanel('INFO', [
    `${prefix}admin · este menú`,
    `${prefix}groupinfo · info del grupo`
], '⌁')}`
}

function menuOwnerBot(prefix, lang = 'es') {
    if (lang === 'pt') {
        return `${wolfricTitulo('PAINEL DO DONO', 'Personalização e controle global.', '👑')}

${frontierPanel('CONTROLE', [
    `${prefix}on · ligar bot`,
    `${prefix}off · desligar bot`,
    `${prefix}private · só o dono`,
    `${prefix}public · todos`
], '⚙')}

${frontierPanel('PERSONALIZAR', [
    `${prefix}setbotname <nome> · nome interno`,
    `${prefix}setbotemoji <emoji> · emoji do bot`,
    `${prefix}setwelcome <texto> · recado extra de status`,
    `${prefix}setpp · foto de perfil (responda a uma imagem)`,
    `${prefix}setnamewa <nome> · nome do WhatsApp`,
    `${prefix}setcanal <link> [nome] · canal WA`,
    `${prefix}antilink on/off · anti-links do grupo`,
    `${prefix}welcome on/off · boas-vindas`,
    `${prefix}backup · backup economia (owner)`,
    `${prefix}botinfo · ver config atual`,
    `${prefix}setprefix <. ! # /> · mudar o prefixo do bot`,
    `${prefix}setgrupoavisos [off] · grupo para avisos automáticos`,
    `${prefix}setranking <dia 0-6> <hora> · ranking semanal automático`,
    `${prefix}setimpuestomercado <0-50> · % destruído no mercado`,
    `${prefix}programarevento nome de até xp|drop x2 · evento temporário`
], '✦')}

${frontierPanel('ROOT / OVERDRIVE', [
    `${prefix}admin_overdrive_on · modo root`,
    `${prefix}admin_overdrive_off · sair do root`,
    `${prefix}setasset · editar recursos`,
    `${prefix}setstats · editar stats`
], '🔧')}`
    }
    if (lang === 'en') {
        return `${wolfricTitulo('OWNER PANEL', 'Personalization and global control.', '👑')}

${frontierPanel('CONTROL', [
    `${prefix}on · turn bot on`,
    `${prefix}off · turn bot off`,
    `${prefix}private · owner only`,
    `${prefix}public · everyone`
], '⚙')}

${frontierPanel('CUSTOMIZE', [
    `${prefix}setbotname <name> · internal name`,
    `${prefix}setbotemoji <emoji> · bot emoji`,
    `${prefix}setwelcome <text> · extra status line`,
    `${prefix}setpp · profile photo (reply to an image)`,
    `${prefix}setnamewa <name> · WhatsApp name`,
    `${prefix}setcanal <link> [name] · WA channel`,
    `${prefix}antilink on/off · group anti-links`,
    `${prefix}welcome on/off · welcome (owner)`,
    `${prefix}backup · economy backup (owner)`,
    `${prefix}botinfo · see current config`,
    `${prefix}setprefix <. ! # /> · change the bot prefix`,
    `${prefix}setgrupoavisos [off] · group for automatic alerts`,
    `${prefix}setranking <day 0-6> <hour> · automatic weekly ranking`,
    `${prefix}setimpuestomercado <0-50> · % burned on the market`,
    `${prefix}programarevento name from to xp|drop x2 · timed event`
], '✦')}

${frontierPanel('ROOT / OVERDRIVE', [
    `${prefix}admin_overdrive_on · root mode`,
    `${prefix}admin_overdrive_off · leave root`,
    `${prefix}setasset · edit resources`,
    `${prefix}setstats · edit stats`
], '🔧')}`
    }
    return `${wolfricTitulo('PANEL DEL DUEÑO', 'Personalización y control global.', '👑')}

${frontierPanel('CONTROL', [
    `${prefix}on · encender bot`,
    `${prefix}off · apagar bot`,
    `${prefix}private · solo dueño`,
    `${prefix}public · todos`
], '⚙')}

${frontierPanel('PERSONALIZAR', [
    `${prefix}setbotname <nombre> · nombre interno`,
    `${prefix}setbotemoji <emoji> · emoji del bot`,
    `${prefix}setwelcome <texto> · mensaje extra de estado`,
    `${prefix}setpp · foto de perfil (responde a imagen)`,
    `${prefix}setnamewa <nombre> · nombre de WhatsApp`,
    `${prefix}setcanal <link> [nombre] · canal WA`,
    `${prefix}antilink on/off · anti-links del grupo`,
    `${prefix}welcome on/off · bienvenida (owner)`,
    `${prefix}backup · backup economia (owner)`,
    `${prefix}botinfo · ver config actual`,
    `${prefix}setprefix <. ! # /> · cambiar el prefijo del bot`,
    `${prefix}setgrupoavisos [off] · grupo para avisos automáticos`,
    `${prefix}setranking <día 0-6> <hora> · ranking semanal automático`,
    `${prefix}setimpuestomercado <0-50> · % que se destruye en el mercado`,
    `${prefix}programarevento nombre desde hasta xp|drop x2 · evento temporal`
], '✦')}

${frontierPanel('ROOT / OVERDRIVE', [
    `${prefix}admin_overdrive_on · modo root`,
    `${prefix}admin_overdrive_off · salir root`,
    `${prefix}setasset · editar recursos`,
    `${prefix}setstats · editar stats`
], '🔧')}`
}


function wolfricMenuMovilPt(prefix, categoria = '') {
    const q = frontierNormalizar(categoria).replace(/\s+/g, '-')
    const volver = `\n_← Voltar: ${prefix}wolfric`
    if (!q || ['inicio', 'menu', 'indice'].includes(q)) return `${wolfricTitulo('PROTOCOLO CLÁSSICO', 'O RPG original, organizado por rotas.', '◌')}

${frontierPanel('SEÇÕES', [
    `${prefix}wolfric player · stats e economia`,
    `${prefix}wolfric fruits · gacha e estilos`,
    `${prefix}wolfric pvp · duelos e equipes`,
    `${prefix}wolfric activity · caça e dungeon`,
    `${prefix}wolfric trade · itens e market`,
    `${prefix}wolfric world · guilds e seas`,
    `${prefix}wolfric media · downloads e figurinhas`,
    `${prefix}wolfric interactivo · ações com outros jogadores`,
    `${prefix}wolfric ia · converse com a IA (Gemini)`
], '✦')}

${frontierPanel('NOVO MUNDO', [
    `${prefix}frontier · Wolfric Frontier`
], '🧭')}

📢 *Canal oficial:* ${botConfig.channelUrl || 'https://whatsapp.com/channel/0029VbDSzOv8KMqcStjGog1T'}`
    if (['jugador', 'economia', 'player', 'economy'].includes(q)) return `${wolfricTitulo('JOGADOR E ECONOMIA', 'Gerencie seu progresso básico.', '◌')}

${frontierPanel('PERSONAGEM', [
    `${prefix}stats [@usuario] · atributos`,
    `${prefix}statsup <stat> <qtd> · melhoria`,
    `${prefix}bounty [@usuario] · recompensa`,
    `${prefix}bountytop · ranking`
], '✦')}

${frontierPanel('RECURSOS', [
    `${prefix}balance · moedas`,
    `${prefix}daily · recompensa diária`,
    `${prefix}work · trabalhar`,
    `${prefix}train · treinar (EXP/HP)`,
    `${prefix}casino <valor> · slots`,
    `${prefix}rob @usuario · tentar roubar`,
    `${prefix}inventory · inventário`
], '⌁')}${volver}`
    if (['frutas', 'fruta', 'estilos', 'fruits', 'styles'].includes(q)) return `${wolfricTitulo('FRUTAS E ESTILOS', 'Defina sua forma de lutar.', '🍎')}

${frontierPanel('FRUTAS', [
    `${prefix}fruitgacha · conseguir uma`,
    `${prefix}fruitfree · tentativa diária`,
    `${prefix}fruits · catálogo`,
    `${prefix}myfruits · coleção`,
    `${prefix}equipfruit <nome> · equipar`,
    `${prefix}skillinfo <fruta> · habilidades`
], '✦')}

${frontierPanel('ESTILOS', [
    `${prefix}styles · catálogo`,
    `${prefix}buystyle <nome> · comprar`,
    `${prefix}equipstyle <nome> · equipar`
], '⚔')}${volver}`
    if (['pvp', 'duelo', 'duelos'].includes(q)) return `${wolfricTitulo('COMBATE CLÁSSICO', 'Sua carga também vale no PvP.', '⚔')}

${frontierPanel('DUELO 1 VS 1', [
    `${prefix}duel @usuario · desafiar`,
    `${prefix}acceptduel · aceitar`,
    `${prefix}attack · golpe`,
    `${prefix}useskill · fruta`,
    `${prefix}arte · Arte`,
    `${prefix}defender · escudo`,
    `${prefix}forfeit · desistir`
], '✦')}

${frontierPanel('DUELO 2 VS 2', [
    `${prefix}duel2v2 · criar equipe`,
    `${prefix}acceptduel2v2 · aceitar`,
    `${prefix}atacar2v2 / ${prefix}arte2v2`,
    `${prefix}habilidad2v2 / ${prefix}defender2v2`
], '⚔')}${volver}`
    if (['actividad', 'coop', 'cooperativo', 'activity'].includes(q)) return `${wolfricTitulo('ATIVIDADE COOPERATIVA', 'Os encontros em grupo rendem mais.', '⚑')}

${frontierPanel('CAÇA E MASMORRA', [
    `${prefix}hunt · monstro do chat`,
    `${prefix}dungeon · abrir expedição`,
    `${prefix}join · entrar no grupo`,
    `${prefix}dungeonattack · golpe`,
    `${prefix}dungeonskill · habilidade`
], '✦')}

${frontierPanel('EVENTO', [
    `${prefix}event · ver seu progresso`,
    `${prefix}roulette · prêmio aleatório`
], '⌁')}${volver}`
    if (['comercio', 'mercado', 'items', 'objetos', 'trade', 'shop'].includes(q)) return `${wolfricTitulo('COMÉRCIO E ITENS', 'Cada recurso tem uma rota.', '⌁')}

${frontierPanel('CONSUMÍVEIS', [
    `${prefix}shop · catálogo`,
    `${prefix}buyitem <número> · comprar`,
    `${prefix}use <nome> · usar`,
    `${prefix}buyer · preços rápidos`,
    `${prefix}quicksell <tipo> <nome> · vender`
], '✦')}

${frontierPanel('MERCADO', [
    `${prefix}sell <tipo> <nome> <preço>`,
    `${prefix}market · publicações`,
    `${prefix}marketbuy <id> · comprar`,
    `${prefix}trade @usuario <valor> · oferta`
], '◌')}${volver}`
    if (['mundo', 'social', 'gremio', 'world'].includes(q)) return `${wolfricTitulo('MUNDO CLÁSSICO', 'Progresso, guilda e território.', '🧭')}

${frontierPanel('COMUNIDADE', [
    `${prefix}titles · títulos`,
    `${prefix}achievements · histórico`,
    `${prefix}quests · objetivos`,
    `${prefix}guild · guildas`
], '◌')}

${frontierPanel('MARES E BOSS', [
    `${prefix}seas · rotas marítimas`,
    `${prefix}travel <1/2/3> · navegar`,
    `${prefix}island <1/2/boss> · destino`,
    `${prefix}attackboss / ${prefix}skillboss`
], '⚑')}${volver}`
    if (['interactivo', 'interaccion', 'interação', 'acoes', 'ações'].includes(q)) return `${wolfricTitulo('INTERATIVO', 'Ações para fazer com outro jogador.', '💬')}

${frontierPanel('CARINHOSAS', [
    `${prefix}hug <@user> · abraço`,
    `${prefix}kiss <@user> · beijo`,
    `${prefix}pet <@user> · carinho`,
    `${prefix}cuddle <@user> · aconchego`,
    `${prefix}handhold <@user> · dar as mãos`,
    `${prefix}feed <@user> · dar comida`,
    `${prefix}dance <@user> · dançar`,
    `${prefix}cry <@user> · chorar no ombro`
], '♡')}

${frontierPanel('ENGRAÇADAS / OUSADAS', [
    `${prefix}slap <@user> · tapa`,
    `${prefix}punch <@user> · soco`,
    `${prefix}bite <@user> · mordida`,
    `${prefix}poke <@user> · cutucada`,
    `${prefix}stare <@user> · olhar fixo`,
    `${prefix}tickle <@user> · cócegas`,
    `${prefix}wave <@user> · aceno`,
    `${prefix}highfive <@user> · toque de mãos`,
    `${prefix}stab <@user> · facada (de brincadeira)`,
    `${prefix}ship <@user1> <@user2> · shippar`,
    `${prefix}gay <@user opcional>`,
    `${prefix}cumplido <@user> · elogio aleatório`,
    `${prefix}insulto <@user> · insulto de brincadeira`,
    `${prefix}coqueteo <@user> · cantada aleatória`
], '✦')}

${frontierPanel('MINIJOGOS', [
    `${prefix}verdad · pergunta aleatória`,
    `${prefix}reto · desafio aleatório`,
    `${prefix}ttt @rival · jogo da velha`,
    `${prefix}ahorcado · adivinhe a palavra`,
    `${prefix}akinator · adivinha personagem`
], '🎲')}${volver}`
    if (['media', 'descargas', 'utilidad', 'stickers'].includes(q)) return `${wolfricTitulo('MÍDIA E UTILIDADE', 'Downloads e ferramentas rápidas.', '🎵')}

${frontierPanel('DOWNLOADS', [
    `${prefix}play <nome ou link> · áudio`,
    `${prefix}ytmp3 <nome ou link> · áudio`,
    `${prefix}ytmp4 <nome ou link> · vídeo`,
    `${prefix}tiktok <link> · vídeo TikTok`,
    `${prefix}ig <link> · vídeo/reel Instagram`,
    `${prefix}fb <link> · vídeo Facebook`,
    `${prefix}kwai <link> · vídeo Kwai`
], '▶')}

${frontierPanel('FIGURINHAS', [
    `${prefix}sticker / ${prefix}s · criar figurinha`,
    `${prefix}take <pack>|<autor> · reempacotar`,
    `${prefix}toimg · figurinha para imagem`,
    `${prefix}setstickerpack <nome> · (owner)`,
    `${prefix}setstickerauthor <nome> · (owner)`
], '✦')}

${frontierPanel('EXTRA', [
    `${prefix}8ball <pergunta> · bola 8`,
    `${prefix}rate [@usuario] · nota aleatória`,
    `${prefix}clima <cidade> · previsão`,
    `${prefix}tts <texto> · texto em voz`,
    `${prefix}imaginar <descrição> · imagem por IA`,
    `${prefix}letra <música> · buscar letra`,
    `${prefix}idioma · escolher español, português ou english`
], '⌁')}${volver}`
    if (['ia', 'ai', 'gemini'].includes(q)) return `${wolfricTitulo('WOLFRIC IA', 'Converse com a IA integrada ao bot (Gemini).', '🧠')}

${frontierPanel('COMANDOS', [
    `${prefix}ia <pergunta> · consulta avulsa`,
    `${prefix}iachat on/off · modo chat (admin, por grupo)`,
    `${prefix}describe [pergunta] · analisa uma imagem`,
    `${prefix}traducir <idioma> <texto> · ou responda a uma mensagem`,
    `${prefix}resumen [quantidade] · resume as últimas mensagens do grupo`
], '✦')}

${frontierPanel('COMO FUNCIONA', [
    `${prefix}ia responde uma vez e não lembra o que veio antes.`,
    `${prefix}iachat on faz o bot responder a TUDO no grupo, como um membro a mais, com memória curta.`,
    `O owner precisa configurar GEMINI_API_KEY. Dá para conferir com ${prefix}botinfo.`
], '⌁')}${volver}`
    return `${wolfricTitulo('SEÇÃO NÃO ENCONTRADA', `Não existe «${categoria}».`, '⚠')}

${frontierPanel('SEÇÕES', [
    `${prefix}wolfric player`,
    `${prefix}wolfric fruits`,
    `${prefix}wolfric pvp`,
    `${prefix}wolfric activity`,
    `${prefix}wolfric trade`,
    `${prefix}wolfric world`,
    `${prefix}wolfric media`,
    `${prefix}wolfric interactivo`,
    `${prefix}wolfric ia`
], '◌')}`
}
function wolfricMenuMovil(prefix, categoria = '', lang = 'es') {
    if (lang === 'pt') return wolfricMenuMovilPt(prefix, categoria)
    if (lang === 'en') return wolfricMenuMovilEn(prefix, categoria)
    const q = frontierNormalizar(categoria).replace(/\s+/g, '-')
    const volver = `\n_← Volver: ${prefix}wolfric`
    if (!q || ['inicio', 'menu', 'indice', 'start'].includes(q)) return `${wolfricTitulo('PROTOCOLO CLÁSICO', 'El RPG original, ordenado por rutas.', '◌')}

${frontierPanel('SECCIONES', [
    `${prefix}wolfric player · stats y economía`,
    `${prefix}wolfric fruits · gacha y estilos`,
    `${prefix}wolfric pvp · duelos y equipos`,
    `${prefix}wolfric activity · caza y dungeon`,
    `${prefix}wolfric trade · ítems y market`,
    `${prefix}wolfric world · guilds y seas`,
    `${prefix}wolfric media · descargas y stickers`,
    `${prefix}wolfric interactivo · acciones con otros jugadores`,
    `${prefix}wolfric ia · charlá con la IA (Gemini)`
], '✦')}

${frontierPanel('NUEVO MUNDO', [
    `${prefix}frontier · Wolfric Frontier`
], '🧭')}

📢 *Canal oficial:* ${botConfig.channelUrl || 'https://whatsapp.com/channel/0029VbDSzOv8KMqcStjGog1T'}`
    if (['jugador', 'economia', 'player', 'economy'].includes(q)) return `${wolfricTitulo('JUGADOR Y ECONOMÍA', 'Gestioná tu progreso básico.', '◌')}

${frontierPanel('PERSONAJE', [
    `${prefix}stats [@usuario] · atributos`,
    `${prefix}statsup <stat> <cant> · mejora`,
    `${prefix}bounty [@usuario] · recompensa`,
    `${prefix}bountytop · ranking`
], '✦')}

${frontierPanel('RECURSOS', [
    `${prefix}balance · monedas`,
    `${prefix}daily · recompensa diaria`,
    `${prefix}work · trabaja`,
    `${prefix}train · entrena (EXP/HP)`,
    `${prefix}casino <monto> · slots`,
    `${prefix}rob @usuario · intenta robar`,
    `${prefix}inventory · inventario`
], '⌁')}${volver}`
    if (['frutas', 'fruta', 'estilos', 'fruits', 'styles'].includes(q)) return `${wolfricTitulo('FRUTAS Y ESTILOS', 'Definí tu forma de combatir.', '🍎')}

${frontierPanel('FRUTAS', [
    `${prefix}fruitgacha · consigue una`,
    `${prefix}fruitfree · intento diario`,
    `${prefix}fruits · catálogo`,
    `${prefix}myfruits · colección`,
    `${prefix}equipfruit <nombre> · equipa`,
    `${prefix}skillinfo <fruta> · habilidades`
], '✦')}

${frontierPanel('ESTILOS', [
    `${prefix}styles · catálogo`,
    `${prefix}buystyle <nombre> · compra`,
    `${prefix}equipstyle <nombre> · equipa`
], '⚔')}${volver}`
    if (['pvp', 'duelo', 'duelos', 'combat'].includes(q)) return `${wolfricTitulo('COMBATE CLÁSICO', 'Tu carga también vale en PvP.', '⚔')}

${frontierPanel('DUELO 1 VS 1', [
    `${prefix}duel @usuario · desafía`,
    `${prefix}acceptduel · acepta`,
    `${prefix}attack · golpe`,
    `${prefix}useskill · fruta`,
    `${prefix}arte · Arte`,
    `${prefix}defender · escudo`,
    `${prefix}forfeit · abandona`
], '✦')}

${frontierPanel('DUELO 2 VS 2', [
    `${prefix}duel2v2 · crea equipo`,
    `${prefix}acceptduel2v2 · acepta`,
    `${prefix}atacar2v2 / ${prefix}arte2v2`,
    `${prefix}habilidad2v2 / ${prefix}defender2v2`
], '⚔')}${volver}`
    if (['actividad', 'coop', 'cooperativo', 'activity'].includes(q)) return `${wolfricTitulo('ACTIVIDAD COOPERATIVA', 'Los encuentros compartidos dan más.', '⚑')}

${frontierPanel('CAZA Y MAZMORRA', [
    `${prefix}hunt · monstruo del chat`,
    `${prefix}dungeon · abre expedición`,
    `${prefix}join · entra al grupo`,
    `${prefix}dungeonattack · golpe`,
    `${prefix}dungeonskill · habilidad`
], '✦')}

${frontierPanel('EVENTO', [
    `${prefix}event · revisa tu progreso`,
    `${prefix}roulette · premio aleatorio`
], '⌁')}${volver}`
    if (['comercio', 'mercado', 'items', 'objetos', 'trade', 'shop'].includes(q)) return `${wolfricTitulo('COMERCIO E ÍTEMS', 'Cada recurso tiene una ruta.', '⌁')}

${frontierPanel('CONSUMIBLES', [
    `${prefix}shop · catálogo`,
    `${prefix}buyitem <número> · compra`,
    `${prefix}use <nombre> · consume`,
    `${prefix}buyer · precios rápidos`,
    `${prefix}quicksell <tipo> <nombre> · vende`
], '✦')}

${frontierPanel('MERCADO', [
    `${prefix}sell <tipo> <nombre> <precio>`,
    `${prefix}market · publicaciones`,
    `${prefix}marketbuy <id> · compra`,
    `${prefix}trade @usuario <monto> · oferta`
], '◌')}${volver}`
    if (['mundo', 'social', 'gremio', 'world'].includes(q)) return `${wolfricTitulo('MUNDO CLÁSICO', 'Progreso, gremio y territorio.', '🧭')}

${frontierPanel('COMUNIDAD', [
    `${prefix}titles · títulos`,
    `${prefix}achievements · historial`,
    `${prefix}quests · objetivos`,
    `${prefix}guild · gremios`,
    `${prefix}guerra · guerra de gremios`
], '◌')}

${frontierPanel('MARES Y BOSS', [
    `${prefix}seas · rutas marítimas`,
    `${prefix}travel <1/2/3> · navega`,
    `${prefix}island <1/2/boss> · destino`,
    `${prefix}attackboss / ${prefix}skillboss`
], '⚑')}${volver}`
    if (['interactivo', 'interaccion', 'interacción', 'acciones'].includes(q)) return `${wolfricTitulo('INTERACTIVO', 'Acciones para hacerle a otro jugador.', '💬')}

${frontierPanel('CARIÑOSAS', [
    `${prefix}hug <@user> · abrazo`,
    `${prefix}kiss <@user> · beso`,
    `${prefix}pet <@user> · caricia`,
    `${prefix}cuddle <@user> · acurrucarse`,
    `${prefix}handhold <@user> · agarrar la mano`,
    `${prefix}feed <@user> · dar de comer`,
    `${prefix}dance <@user> · bailar`,
    `${prefix}cry <@user> · llorar en su hombro`
], '♡')}

${frontierPanel('DIVERTIDAS / RUDAS', [
    `${prefix}slap <@user> · cachetada`,
    `${prefix}punch <@user> · golpe`,
    `${prefix}bite <@user> · mordida`,
    `${prefix}poke <@user> · toque`,
    `${prefix}stare <@user> · mirada fija`,
    `${prefix}tickle <@user> · cosquillas`,
    `${prefix}wave <@user> · saludo`,
    `${prefix}highfive <@user> · choque de manos`,
    `${prefix}stab <@user> · apuñalada (de mentira)`,
    `${prefix}ship <@user1> <@user2> · shippear`,
    `${prefix}gay <@user opcional>`,
    `${prefix}cumplido <@user> · piropo random`,
    `${prefix}insulto <@user> · insulto de joda`,
    `${prefix}coqueteo <@user> · frase de flirteo`
], '✦')}

${frontierPanel('MINIJUEGOS', [
    `${prefix}verdad · pregunta random`,
    `${prefix}reto · reto random`,
    `${prefix}ttt @rival · ta-te-ti`,
    `${prefix}ahorcado · adiviná la palabra`,
    `${prefix}akinator · adivina el personaje`
], '🎲')}${volver}`
    if (['media', 'descargas', 'utilidad', 'stickers'].includes(q)) return `${wolfricTitulo('MEDIA Y UTILIDAD', 'Descargas y herramientas rápidas.', '🎵')}

${frontierPanel('DESCARGAS', [
    `${prefix}play <nombre o link> · audio`,
    `${prefix}ytmp3 <nombre o link> · audio`,
    `${prefix}ytmp4 <nombre o link> · video`,
    `${prefix}tiktok <link> · video TikTok`,
    `${prefix}ig <link> · video/reel Instagram`,
    `${prefix}gif <búsqueda> · gif/video corto`,
    `${prefix}fb <link> · video Facebook`,
    `${prefix}kwai <link> · video Kwai`
], '▶')}

${frontierPanel('STICKERS', [
    `${prefix}sticker / ${prefix}s · crear sticker`,
    `${prefix}take <pack>|<autor> · re-empacar sticker`,
    `${prefix}toimg · sticker a imagen`,
    `${prefix}setstickerpack <nombre> · (owner)`,
    `${prefix}setstickerauthor <nombre> · (owner)`
], '✦')}

${frontierPanel('EXTRA', [
    `${prefix}8ball <pregunta> · bola 8`,
    `${prefix}rate [@usuario] · puntaje random`,
    `${prefix}clima <ciudad> · pronóstico`,
    `${prefix}tts <texto> · texto a voz`,
    `${prefix}imaginar <descripción> · imagen por IA`,
    `${prefix}letra <canción> · buscar letra`,
    `${prefix}idioma · elegir español, português o english`
], '⌁')}${volver}`
    if (['ia', 'ai', 'gemini'].includes(q)) return `${wolfricTitulo('WOLFRIC IA', 'Charlá con la IA integrada al bot (Gemini).', '🧠')}

${frontierPanel('COMANDOS', [
    `${prefix}ia <pregunta> · consulta suelta`,
    `${prefix}iachat on/off · modo chat (admin, por grupo)`,
    `${prefix}describe [pregunta] · analiza una imagen (mandala o respondela)`,
    `${prefix}traducir <idioma> <texto> · o respondé a un mensaje`,
    `${prefix}resumen [cantidad] · resume los últimos mensajes del grupo`
], '✦')}

${frontierPanel('CÓMO FUNCIONA', [
    `${prefix}ia responde una sola vez, no recuerda nada de antes.`,
    `${prefix}iachat on hace que el bot responda a TODO lo que se hable en el grupo, como un miembro más, y sí recuerda el hilo de la charla (memoria corta).`,
    `Necesita que el owner tenga configurada GEMINI_API_KEY. Se puede chequear con ${prefix}botinfo.`
], '⌁')}${volver}`
    return `${wolfricTitulo('SECCIÓN NO ENCONTRADA', `No existe «${categoria}».`, '⚠')}

${frontierPanel('SECCIONES', [
    `${prefix}wolfric player`,
    `${prefix}wolfric fruits`,
    `${prefix}wolfric pvp`,
    `${prefix}wolfric activity`,
    `${prefix}wolfric trade`,
    `${prefix}wolfric world`,
    `${prefix}wolfric media`,
    `${prefix}wolfric interactivo`,
    `${prefix}wolfric ia`
], '◌')}`
}

function wolfricMenuMovilEn(prefix, categoria = '') {
    const q = frontierNormalizar(categoria).replace(/\s+/g, '-')
    const volver = `\n_← Back: ${prefix}wolfric`
    if (!q || ['inicio', 'menu', 'indice', 'start', 'home'].includes(q)) return `${wolfricTitulo('CLASSIC PROTOCOL', 'The original RPG, organized by route.', '◌')}

${frontierPanel('SECTIONS', [
    `${prefix}wolfric player · stats and economy`,
    `${prefix}wolfric fruits · gacha and styles`,
    `${prefix}wolfric pvp · duels and teams`,
    `${prefix}wolfric activity · hunt and dungeon`,
    `${prefix}wolfric trade · items and market`,
    `${prefix}wolfric world · guilds and seas`,
    `${prefix}wolfric media · downloads and stickers`,
    `${prefix}wolfric interactivo · actions with other players`,
    `${prefix}wolfric ia · chat with the AI (Gemini)`
], '✦')}

${frontierPanel('NEW WORLD', [
    `${prefix}frontier · Wolfric Frontier`
], '🧭')}

📢 *Official channel:* ${botConfig.channelUrl || 'https://whatsapp.com/channel/0029VbDSzOv8KMqcStjGog1T'}`
    if (['jugador', 'economia', 'player', 'economy'].includes(q)) return `${wolfricTitulo('PLAYER & ECONOMY', 'Manage your basic progress.', '◌')}

${frontierPanel('CHARACTER', [
    `${prefix}stats [@user] · attributes`,
    `${prefix}statsup <stat> <amount> · upgrade`,
    `${prefix}bounty [@user] · bounty`,
    `${prefix}bountytop · ranking`
], '✦')}

${frontierPanel('RESOURCES', [
    `${prefix}balance · coins`,
    `${prefix}daily · daily reward`,
    `${prefix}work · work`,
    `${prefix}train · train (EXP/HP)`,
    `${prefix}casino <amount> · slots`,
    `${prefix}rob @user · try to steal`,
    `${prefix}inventory · inventory`
], '⌁')}${volver}`
    if (['frutas', 'fruta', 'estilos', 'fruits', 'styles'].includes(q)) return `${wolfricTitulo('FRUITS & STYLES', 'Define your fighting style.', '🍎')}

${frontierPanel('FRUITS', [
    `${prefix}fruitgacha · get one`,
    `${prefix}fruitfree · daily attempt`,
    `${prefix}fruits · catalog`,
    `${prefix}myfruits · collection`,
    `${prefix}equipfruit <name> · equip`,
    `${prefix}skillinfo <fruit> · abilities`
], '✦')}

${frontierPanel('STYLES', [
    `${prefix}styles · catalog`,
    `${prefix}buystyle <name> · buy`,
    `${prefix}equipstyle <name> · equip`
], '⚔')}${volver}`
    if (['pvp', 'duelo', 'duelos', 'combat'].includes(q)) return `${wolfricTitulo('CLASSIC COMBAT', 'Your loadout also matters in PvP.', '⚔')}

${frontierPanel('1V1 DUEL', [
    `${prefix}duel @user · challenge`,
    `${prefix}acceptduel · accept`,
    `${prefix}attack · hit`,
    `${prefix}useskill · fruit`,
    `${prefix}arte · Art`,
    `${prefix}defender · shield`,
    `${prefix}forfeit · give up`
], '✦')}

${frontierPanel('2V2 DUEL', [
    `${prefix}duel2v2 · create team`,
    `${prefix}acceptduel2v2 · accept`,
    `${prefix}atacar2v2 / ${prefix}arte2v2`,
    `${prefix}habilidad2v2 / ${prefix}defender2v2`
], '⚔')}${volver}`
    if (['actividad', 'coop', 'cooperativo', 'activity'].includes(q)) return `${wolfricTitulo('CO-OP ACTIVITY', 'Shared encounters pay off more.', '⚑')}

${frontierPanel('HUNT & DUNGEON', [
    `${prefix}hunt · monster in the chat`,
    `${prefix}dungeon · open expedition`,
    `${prefix}join · join the party`,
    `${prefix}dungeonattack · hit`,
    `${prefix}dungeonskill · ability`
], '✦')}

${frontierPanel('EVENT', [
    `${prefix}event · check your progress`,
    `${prefix}roulette · random prize`
], '⌁')}${volver}`
    if (['comercio', 'mercado', 'items', 'objetos', 'trade', 'shop'].includes(q)) return `${wolfricTitulo('TRADE & ITEMS', 'Every resource has a route.', '⌁')}

${frontierPanel('CONSUMABLES', [
    `${prefix}shop · catalog`,
    `${prefix}buyitem <number> · buy`,
    `${prefix}use <name> · consume`,
    `${prefix}buyer · quick prices`,
    `${prefix}quicksell <type> <name> · sell`
], '✦')}

${frontierPanel('MARKET', [
    `${prefix}sell <type> <name> <price>`,
    `${prefix}market · listings`,
    `${prefix}marketbuy <id> · buy`,
    `${prefix}trade @user <amount> · offer`
], '◌')}${volver}`
    if (['mundo', 'social', 'gremio', 'world'].includes(q)) return `${wolfricTitulo('CLASSIC WORLD', 'Progress, guild and territory.', '🧭')}

${frontierPanel('COMMUNITY', [
    `${prefix}titles · titles`,
    `${prefix}achievements · history`,
    `${prefix}quests · goals`,
    `${prefix}guild · guilds`,
    `${prefix}guerra · guild war`
], '◌')}

${frontierPanel('SEAS & BOSS', [
    `${prefix}seas · sea routes`,
    `${prefix}travel <1/2/3> · sail`,
    `${prefix}island <1/2/boss> · destination`,
    `${prefix}attackboss / ${prefix}skillboss`
], '⚑')}${volver}`
    if (['interactivo', 'interaccion', 'interaction', 'acciones', 'actions'].includes(q)) return `${wolfricTitulo('INTERACTIVE', 'Actions to do to another player.', '💬')}

${frontierPanel('AFFECTIONATE', [
    `${prefix}hug <@user> · hug`,
    `${prefix}kiss <@user> · kiss`,
    `${prefix}pet <@user> · pet`,
    `${prefix}cuddle <@user> · cuddle`,
    `${prefix}handhold <@user> · hold hands`,
    `${prefix}feed <@user> · feed`,
    `${prefix}dance <@user> · dance`,
    `${prefix}cry <@user> · cry on their shoulder`
], '♡')}

${frontierPanel('FUNNY / ROUGH', [
    `${prefix}slap <@user> · slap`,
    `${prefix}punch <@user> · punch`,
    `${prefix}bite <@user> · bite`,
    `${prefix}poke <@user> · poke`,
    `${prefix}stare <@user> · stare`,
    `${prefix}tickle <@user> · tickle`,
    `${prefix}wave <@user> · wave`,
    `${prefix}highfive <@user> · high five`,
    `${prefix}stab <@user> · stab (pretend)`,
    `${prefix}ship <@user1> <@user2> · ship`,
    `${prefix}gay <@user optional>`,
    `${prefix}cumplido <@user> · random compliment`,
    `${prefix}insulto <@user> · joke insult`,
    `${prefix}coqueteo <@user> · random pickup line`
], '✦')}

${frontierPanel('MINI-GAMES', [
    `${prefix}verdad · random truth question`,
    `${prefix}reto · random dare`,
    `${prefix}ttt @rival · tic-tac-toe`,
    `${prefix}ahorcado · guess the word`,
    `${prefix}akinator · guess the character`
], '🎲')}${volver}`
    if (['media', 'descargas', 'utilidad', 'stickers', 'downloads'].includes(q)) return `${wolfricTitulo('MEDIA & UTILITY', 'Downloads and quick tools.', '🎵')}

${frontierPanel('DOWNLOADS', [
    `${prefix}play <name or link> · audio`,
    `${prefix}ytmp3 <name or link> · audio`,
    `${prefix}ytmp4 <name or link> · video`,
    `${prefix}tiktok <link> · TikTok video`,
    `${prefix}ig <link> · Instagram video/reel`,
    `${prefix}gif <search> · short gif/video`,
    `${prefix}fb <link> · Facebook video`,
    `${prefix}kwai <link> · Kwai video`
], '▶')}

${frontierPanel('STICKERS', [
    `${prefix}sticker / ${prefix}s · create sticker`,
    `${prefix}take <pack>|<author> · repack sticker`,
    `${prefix}toimg · sticker to image`,
    `${prefix}setstickerpack <name> · (owner)`,
    `${prefix}setstickerauthor <name> · (owner)`
], '✦')}

${frontierPanel('EXTRA', [
    `${prefix}8ball <question> · magic 8-ball`,
    `${prefix}rate [@user] · random score`,
    `${prefix}clima <city> · weather forecast`,
    `${prefix}tts <text> · text to speech`,
    `${prefix}imaginar <description> · AI image`,
    `${prefix}letra <song> · find lyrics`,
    `${prefix}idioma · choose Spanish, Portuguese or English`
], '⌁')}${volver}`
    if (['ia', 'ai', 'gemini'].includes(q)) return `${wolfricTitulo('WOLFRIC AI', 'Chat with the AI built into the bot (Gemini).', '🧠')}

${frontierPanel('COMMANDS', [
    `${prefix}ia <question> · one-off question`,
    `${prefix}iachat on/off · chat mode (admin, per group)`,
    `${prefix}describe [question] · analyze an image (send it or reply to it)`,
    `${prefix}traducir <language> <text> · or reply to a message`,
    `${prefix}resumen [amount] · summarize the group's last messages`
], '✦')}

${frontierPanel('HOW IT WORKS', [
    `${prefix}ia answers once, it doesn't remember anything from before.`,
    `${prefix}iachat on makes the bot reply to EVERYTHING said in the group, like another member, and it does remember the thread (short memory).`,
    `Needs the owner to have GEMINI_API_KEY configured. Check with ${prefix}botinfo.`
], '⌁')}${volver}`
    return `${wolfricTitulo('SECTION NOT FOUND', `«${categoria}» doesn't exist.`, '⚠')}

${frontierPanel('SECTIONS', [
    `${prefix}wolfric player`,
    `${prefix}wolfric fruits`,
    `${prefix}wolfric pvp`,
    `${prefix}wolfric activity`,
    `${prefix}wolfric trade`,
    `${prefix}wolfric world`,
    `${prefix}wolfric media`,
    `${prefix}wolfric interactivo`,
    `${prefix}wolfric ia`
], '◌')}`
}
function frontierDescripcionEncuentro(encuentro, lang = 'es') {
    const m = encuentro.monster
    const pt = lang === 'pt'
    return `${frontierTitulo(m.elite ? (pt ? '𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢 𝗘𝗟𝗜𝗧𝗘' : '𝗘𝗡𝗖𝗨𝗘𝗡𝗧𝗥𝗢 𝗘́𝗟𝗜𝗧𝗘') : (pt ? '𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢 𝗔𝗧𝗜𝗩𝗢' : '𝗘𝗡𝗖𝗨𝗘𝗡𝗧𝗥𝗢 𝗔𝗖𝗧𝗜𝗩𝗢'), `${m.nombre} · ${pt ? 'Nível' : 'Nivel'} ${m.nivel}`, m.elite ? '🚨' : '⚠️')}\n\n${frontierPanel(pt ? '𝗟𝗘𝗜𝗧𝗨𝗥𝗔 𝗗𝗢 𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢' : '𝗟𝗘𝗖𝗧𝗨𝗥𝗔 𝗗𝗘𝗟 𝗘𝗡𝗖𝗨𝗘𝗡𝗧𝗥𝗢', [`👹 ${pt ? 'Alvo' : 'Objetivo'}: ${m.nombre}`, `📍 ${pt ? 'Subzona' : 'Subzona'}: ${encuentro.subzona?.nombre || (pt ? 'rota não identificada' : 'ruta no identificada')}`, `❤️ HP: ${Math.max(0, m.hp)}/${m.hpMax}`, `⚔️ ${pt ? 'Dano estimado' : 'Daño estimado'}: ${m.dano}`, `${m.elite ? (pt ? '💀 Recompensa elite ativa' : '💀 Recompensa élite activa') : (pt ? '🎯 Recompensa regional' : '🎯 Recompensa regional')}`, `🎯 ${prefix}frontierattack · ${pt ? 'atacar' : 'atacar'}`, `🏃 ${prefix}run · ${pt ? 'escapar' : 'escapar'}`], '⚔️')}`
}

const COMANDOS_VALIDOS = new Set([
    'menu', 'help', 'wolfric', 'whoami', 'frontera', 'ayuda', 'registro', 'perfil', 'estado', 'inicio', 'guia', 'habilidades', 'orientacion', 'pordonde',
    'mapa', 'regiones', 'ir', 'equipo', 'forjar', 'equipararma', 'artes', 'aprenderarte', 'equipararte',
    'pistas', 'escenarios', 'rastrear', 'guardianes', 'soberano', 'subzonas', 'elites', 'usarfrontera', 'iniciarfrontera', 'unirsefrontera', 'habilidadfrontera', 'frutafrontera', 'decidirfrontera', 'huirfrontera', 'atacarfrontera', 'huir', 'combate', 'loadout', 'arte2v2', 'defender2v2',
    'on', 'off', 'private', 'public', 'desactivar', 'activar', 'desactivados',
    'admin', 'owner', 'hidetag', 'warn', 'warns', 'unwarn', 'groupinfo',
    'setbotname', 'setbotemoji', 'setwelcome', 'botinfo', 'setpp', 'setnamewa', 'setcanal', 'canal', 'backup',  'welcome',  'antilink', 'grupo',  'setgoodbye',  'goodbye',  'antispam',  
    'botones',
    'kick', 'ban', 'promote', 'demote', 'tagall', 'open', 'close',
    'hug', 'kiss', 'punch', 'peek', 'comfort', 'thinkhard', 'curious', 'trip', 'angry', 'bleh', 'bored', 'clap', 'coffee', 'cold', 'sing', 'scream', 'push', 'nope', 'jump', 'heat', 'gaming', 'draw', 'call', 'dramatic', 'laugh', 'pout', 'run', 'sad', 'scared', 'shy', 'sleep', 'think', 'walk', 'eat', 'wink', 'happy', 'blush', 'bath', 'smug', 'smile', 'cringe', 'bonk', 'aburrido', 'cafe', 'drama', 'feliz', 'timido', 'triste', 'correr', 'comer', 'pet', 'dance', 'ship', 'gay', 'dice',
    'slap', 'bite', 'cuddle', 'highfive', 'poke', 'stare', 'tickle', 'wave', 'feed', 'handhold', 'cry', 'stab',
    'balance', 'daily', 'work', 'rob', 'pay', 'inventory', 'inventario',
    '8ball', 'rate',
    'sticker', 's', 'toimg', 'take', 'setstickerpack', 'setstickerauthor',
    'play', 'ytmp3', 'ytmp4', 'tiktok', 'tt', 'ig', 'instagram', 'fb', 'facebook', 'kwai', 'kawai',
    'stats', 'statsup', 'bounty', 'casino', 'train', 'entrenar', 'setreglas', 'blacklist', 'recordar', 'reglas', 'ranking', 'reclamarmision', 'misiondia', 'apostar', 'heal', 'bountytop', 'cazar',
    'fruitgacha', 'fruitfree', 'fruits', 'misfrutas', 'equiparfruta', 'skillinfo',
    'estilos', 'comprarestilo', 'equiparestilo',
    'tienda', 'compraritem', 'usar', 'item',
    'duel', 'acceptduel', 'attack', 'atacar', 'useskill', 'habilidad', 'ultimate', 'arte', 'usararte', 'defender', 'despertar', 'forfeit',
    'duel2v2', 'acceptduel2v2', 'atacar2v2', 'habilidad2v2', 'ultimate2v2', 'item2v2', 'forfeit2v2',
    'mazmorra', 'unirme', 'mazmatacar', 'mazmhabilidad',
    'vender', 'mercado', 'comprarmercado', 'cancelarventa',
    'comprador', 'venderrapido',
    'ruleta', 'casino', 'train', 'entrenar', 'setreglas', 'blacklist', 'recordar', 'reglas', 'ranking', 'reclamarmision', 'misiondia', 'apostar', 'heal', 'evento', 'crearperfil',
    'trade', 'accepttrade', 'canceltrade',
    'admin_overdrive_on', 'overdrive_on', 'admin_overdrive_off', 'overdrive_off',
    'admin_set_asset', 'setasset', 'admin_set_stats', 'setstats', 'admin_event_control', 'eventcontrol', 'admin_frontier_status', 'admin_frontier_season', 'admin_frontier_reset',
    'titles', 'titleequip', 'titlelist', 'granttitle', 'logros', 'logro', 'npc', 'hablarnpc', 'reputacion', 'misionesfrontier', 'aceptarmision', 'entregarmision', 'recetas', 'fabricar', 'temporada', 'mundofrontier', 'clasificacionfrontier', 'resonancia', 'iniciaresonancia', 'unirresonancia', 'atacarresonancia', 'arteresonancia', 'frutaresonancia', 'decidirresonancia', 'huirresonancia',
    'guild', 'mares', 'viajar', 'isla', 'explorar', 'atacarbossisla', 'volverislaprincipal', 'misiones', 'mision',
    'spawnboss', 'spawn_boss', 'attackboss', 'skillboss',
    'micodigo', 'usarcodigo', 'reportar', 'torneo', 'programarevento', 'eventosactivos', 'setgrupoavisos', 'setranking', 'setimpuestomercado', 'setprefix', 'sockets', 'bots', 'code', 'qr', 'self', 'setbanner', 'setmenubanner', 'join', 'unir', 'seticon', 'setbotcurrency', 'setbotlink', 'setlink', 'logout', 'reload', 'setstatus', 'setpfp', 'setimage', 'leave', 'ia', 'iachat', 'antiraid', 'antipeleas', 'antidelete', 'viewonce', 'anticall', 'cazat', 'truth', 'verdad', 'dare', 'reto', 'compliment', 'cumplido', 'insult', 'insulto', 'flirt', 'coqueteo', 'weather', 'clima', 'tts', 'imagine', 'imaginar', 'lyrics', 'letra', 'ttt', 'tatetiti', 'ahorcado', 'hangman', 'akinator', 'aki', 'describe', 'describir', 'traducir', 'resumen',
    'idioma', 'language', 'lang', 'lingua', 'linguagem', 'idioma_es', 'idioma_pt', 'idioma_en',
    'sockets', 'bots', 'code', 'qr', 'self', 'setbanner', 'join', 'unir', 'leave', 'logout', 'reload', 'setstatus', 'setpfp', 'setimage', 'seticon', 'setbotcurrency', 'setbotlink', 'setlink',
    'gif', 'guerra', 'guerragremios',
    'rank', 'remind', 'curar', 'misionesdia',
    '42', 'sudo', 'autodestruir', 'goku', 'powerlevel', 'matrix', 'touchgrass', 'banana', 'respirar',
    ...TITULOS.map(t => t.comando)
])

// Comandos que funcionan SIN haber usado .crearperfil todavía (utilidades del bot y lo social genérico).
// Todo lo demás (economía, frutas, combate, mazmorras, mercado, gremios, etc.) requiere perfil creado.
const COMANDOS_SIN_REGISTRO = new Set([
    'menu', 'help', 'wolfric', 'whoami', 'frontera', 'ayuda', 'registro', 'perfil', 'estado', 'mapa', 'regiones', 'guardianes', 'soberano', 'crearperfil',
    'on', 'off', 'private', 'public', 'desactivar', 'activar', 'desactivados',
    'admin', 'owner', 'hidetag', 'warn', 'warns', 'unwarn', 'groupinfo',
    'setbotname', 'setbotemoji', 'setwelcome', 'botinfo', 'setpp', 'setnamewa', 'setcanal', 'canal', 'backup',  'welcome',  'antilink', 'grupo',  'setgoodbye',  'goodbye',  'antispam',  
    'botones',
    'kick', 'ban', 'promote', 'demote', 'tagall', 'open', 'close',
    'hug', 'kiss', 'punch', 'peek', 'comfort', 'thinkhard', 'curious', 'trip', 'angry', 'bleh', 'bored', 'clap', 'coffee', 'cold', 'sing', 'scream', 'push', 'nope', 'jump', 'heat', 'gaming', 'draw', 'call', 'dramatic', 'laugh', 'pout', 'run', 'sad', 'scared', 'shy', 'sleep', 'think', 'walk', 'eat', 'wink', 'happy', 'blush', 'bath', 'smug', 'smile', 'cringe', 'bonk', 'aburrido', 'cafe', 'drama', 'feliz', 'timido', 'triste', 'correr', 'comer', 'pet', 'dance', 'ship', 'gay', 'dice', '8ball', 'rate', 'gif',
    'truth', 'verdad', 'dare', 'reto', 'compliment', 'cumplido', 'insult', 'insulto', 'flirt', 'coqueteo', 'weather', 'clima', 'tts', 'imagine', 'imaginar', 'lyrics', 'letra', 'ttt', 'tatetiti', 'ahorcado', 'hangman', 'akinator', 'aki',
    'slap', 'bite', 'cuddle', 'highfive', 'poke', 'stare', 'tickle', 'wave', 'feed', 'handhold', 'cry', 'stab',
    'sticker', 's', 'toimg', 'take', 'setstickerpack', 'setstickerauthor',
    'play', 'ytmp3', 'ytmp4', 'tiktok', 'tt', 'ig', 'instagram', 'fb', 'facebook', 'kwai', 'kawai', 'spotify', 'sp', 'mediafire', 'mf', 'reel', 'cazat',
    'idioma', 'language', 'lang', 'lingua', 'linguagem', 'idioma_es', 'idioma_pt', 'idioma_en',
    '42', 'sudo', 'autodestruir', 'goku', 'powerlevel', 'matrix', 'touchgrass', 'banana', 'respirar'
])

// Actividades "de tierra": necesitás estar en la Isla Principal (no de viaje por el mar) para hacerlas
const COMANDOS_REQUIEREN_TIERRA = new Set([
    'duel', 'acceptduel', 'attack', 'atacar', 'useskill', 'habilidad', 'ultimate', 'forfeit',
    'duel2v2', 'acceptduel2v2', 'atacar2v2', 'habilidad2v2', 'ultimate2v2', 'item2v2', 'forfeit2v2',
    'mazmorra', 'unirme', 'mazmatacar', 'mazmhabilidad',
    'iniciarfrontera', 'unirsefrontera', 'atacarfrontera', 'habilidadfrontera', 'frutafrontera', 'usarfrontera', 'huirfrontera', 'arte', 'usararte', 'defender', 'arte2v2', 'defender2v2', 'iniciaresonancia', 'unirresonancia', 'atacarresonancia', 'arteresonancia', 'frutaresonancia', 'huirresonancia'
])

// ========== WOLFRIC PROTOCOL: GREMIOS ==========
const gremios = new Map() // nombre -> { creador, miembros: [jid] }
const GREMIOS_FILE = './gremios.json'
function guardarGremios() {
    try {
        fs.writeFileSync(GREMIOS_FILE, JSON.stringify(Object.fromEntries(gremios), null, 2))
    } catch (e) { console.log('Error guardando gremios:', e) }
}
function cargarGremios() {
    try {
        if (fs.existsSync(GREMIOS_FILE)) {
            const datos = JSON.parse(fs.readFileSync(GREMIOS_FILE, 'utf8'))
            for (const [nombre, g] of Object.entries(datos)) gremios.set(nombre, g)
        }
    } catch (e) { console.log('Error cargando gremios:', e) }
}
cargarGremios()

// Advertencias de grupo (admin): chatId -> { jid -> count }
const advertencias = new Map()

// Marca temporada Frontier (NO borra progreso)
const FRONTIER_TEMPORADA_REINICIO_MARCA = './frontier_temporada_02_reinicio.json'
const FRONTIER_TEMPORADA_NOMBRE = 'Temporada 02 · El Umbral'
function frontierReiniciarTemporadaSiCorresponde() {
    if (fs.existsSync(FRONTIER_TEMPORADA_REINICIO_MARCA)) return false
    try {
        fs.writeFileSync(FRONTIER_TEMPORADA_REINICIO_MARCA, JSON.stringify({ temporada: FRONTIER_TEMPORADA_NOMBRE, fecha: new Date().toISOString(), sinReset: true }, null, 2))
    } catch (e) {}
    return true
}
frontierReiniciarTemporadaSiCorresponde()

function gremioDe(jid) {
    for (const [nombre, g] of gremios.entries()) {
        if (g.miembros.some(m => normalizarJidGlobal(m) === normalizarJidGlobal(jid))) return nombre
    }
    return null
}
function normalizarJidGlobal(jid) { return (jid || '').split('@')[0].split(':')[0] }

// ========== WOLFRIC PROTOCOL: GUERRA DE GREMIOS ==========
const guerrasGremios = new Map() // id -> { gremioA, gremioB, puntosA, puntosB, contribuciones:{jid:pts}, inicio, fin, chatId, finalizada, ganadora }
const GUERRAS_FILE = './guerra_gremios.json'
const GUERRA_DURACION_MS = 24 * 60 * 60 * 1000 // 24 horas por guerra
const GUERRA_COOLDOWN_MS = 2 * 60 * 60 * 1000  // 2h de enfriamiento tras terminar una guerra antes de poder declarar otra
function guardarGuerras() {
    try { fs.writeFileSync(GUERRAS_FILE, JSON.stringify(Object.fromEntries(guerrasGremios), null, 2)) } catch (e) { console.log('Error guardando guerras:', e) }
}
function cargarGuerras() {
    try {
        if (fs.existsSync(GUERRAS_FILE)) {
            const datos = JSON.parse(fs.readFileSync(GUERRAS_FILE, 'utf8'))
            for (const [id, g] of Object.entries(datos)) guerrasGremios.set(id, g)
        }
    } catch (e) { console.log('Error cargando guerras:', e) }
}
cargarGuerras()

// Devuelve la guerra activa (sin terminar y dentro de tiempo) de un gremio, si tiene alguna
function guerraActivaDeGremio(nombreGremio) {
    const ahora = Date.now()
    for (const g of guerrasGremios.values()) {
        if (g.finalizada) continue
        if (g.fin < ahora) continue
        if (g.gremioA === nombreGremio || g.gremioB === nombreGremio) return g
    }
    return null
}

// Suma puntos de guerra al gremio del jugador, si su gremio está en guerra activa. No hace nada si no aplica.
function sumarPuntosGuerra(jid, puntos) {
    try {
        const nombreGremio = gremioDe(jid)
        if (!nombreGremio) return
        const guerra = guerraActivaDeGremio(nombreGremio)
        if (!guerra) return
        if (guerra.gremioA === nombreGremio) guerra.puntosA += puntos
        else guerra.puntosB += puntos
        const key = normalizarJidGlobal(jid)
        guerra.contribuciones[key] = (guerra.contribuciones[key] || 0) + puntos
        guardarGuerras()
    } catch (e) {}
}

// Revisa si una guerra ya venció su duración y la cierra, repartiendo el premio al gremio ganador
async function finalizarGuerraSiCorresponde(sock, guerra) {
    if (guerra.finalizada || Date.now() < guerra.fin) return false
    guerra.finalizada = true
    const empate = guerra.puntosA === guerra.puntosB
    guerra.ganadora = empate ? null : (guerra.puntosA > guerra.puntosB ? guerra.gremioA : guerra.gremioB)
    if (guerra.ganadora && gremios.has(guerra.ganadora)) {
        const g = gremios.get(guerra.ganadora)
        g.guerrasGanadas = (g.guerrasGanadas || 0) + 1
        for (const jid of g.miembros) {
            const u = getUsuario(jid)
            u.coins += 1000
            u.lifetimeCoinsEarned += 1000
        }
        guardarGremios()
        guardarEconomia()
    }
    guardarGuerras()
    if (sock && guerra.chatId) {
        const langGuerra = getGrupoCfg(guerra.chatId).idioma || 'es'
        const texto = empate
            ? tr(langGuerra, `⚔️ *GUERRA DE GREMIOS FINALIZADA*\n\n🔰 ${guerra.gremioA} (${guerra.puntosA}) vs 🔰 ${guerra.gremioB} (${guerra.puntosB})\n\n🤝 ¡Empate! Nadie se lleva el premio esta vez.`,
                `⚔️ *GUERRA DE GUILDAS FINALIZADA*\n\n🔰 ${guerra.gremioA} (${guerra.puntosA}) vs 🔰 ${guerra.gremioB} (${guerra.puntosB})\n\n🤝 Empate! Ninguém leva o prêmio dessa vez.`,
                `⚔️ *GUILD WAR ENDED*\n\n🔰 ${guerra.gremioA} (${guerra.puntosA}) vs 🔰 ${guerra.gremioB} (${guerra.puntosB})\n\n🤝 It's a tie! Nobody takes the prize this time.`)
            : tr(langGuerra, `⚔️ *GUERRA DE GREMIOS FINALIZADA*\n\n🔰 ${guerra.gremioA} (${guerra.puntosA}) vs 🔰 ${guerra.gremioB} (${guerra.puntosB})\n\n🏆 ¡Ganó *${guerra.ganadora}*! Cada miembro recibió +1000 monedas.`,
                `⚔️ *GUERRA DE GUILDAS FINALIZADA*\n\n🔰 ${guerra.gremioA} (${guerra.puntosA}) vs 🔰 ${guerra.gremioB} (${guerra.puntosB})\n\n🏆 *${guerra.ganadora}* venceu! Cada membro recebeu +1000 moedas.`,
                `⚔️ *GUILD WAR ENDED*\n\n🔰 ${guerra.gremioA} (${guerra.puntosA}) vs 🔰 ${guerra.gremioB} (${guerra.puntosB})\n\n🏆 *${guerra.ganadora}* won! Each member received +1000 coins.`)
        try {
            await enviarConGif(sock, guerra.chatId, texto, empate ? 'draw tie stalemate' : 'victory celebration crowd')
        } catch (e) {}
    }
    return true
}

// ========== WOLFRIC PROTOCOL: BOSS GLOBAL ==========
const bosses = new Map() // chatId -> { hp, maxHp, participantes: Map(jid->daño), spawnedAt, nombre }
const BOSS_HP_BASE = 10000
const BOSS_NOMBRE = 'Abyssal Overlord'
// Configurables en tiempo real vía .admin_event_control (GDD V4.2 §3.3 / V4.0 §6.1)
let bossSpawnChancePct = 5        // % de chance de auto-spawn por mensaje en un grupo
let bossCooldownMs = 24 * 60 * 60 * 1000 // enfriamiento entre spawns automáticos por grupo
const ultimoBossPorGrupo = new Map() // chatId -> timestamp del último boss (para el cooldown)

// ========== MINI SISTEMA DE FARMING: MONSTRUOS SALVAJES ==========
// Bichos menores de la red que aparecen de a poco en el chat — se cazan con .cazar y dan monedas rápidas.
const monstruosActivos = new Map() // chatId -> { nombre, spawnedAt }
const ultimoMonstruoPorGrupo = new Map() // chatId -> timestamp del último spawn/caza (cooldown para no saturar el chat)
const MONSTRUO_SPAWN_CHANCE_PCT = 6          // % de chance por mensaje de que aparezca uno
const MONSTRUO_COOLDOWN_MS = 4 * 60 * 1000   // mínimo 4 minutos entre apariciones por grupo
const MONSTRUO_RECOMPENSA = 80
const MONSTRUO_EXPIRA_MS = 5 * 60 * 1000     // si nadie lo caza en 5 min, escapa
const NOMBRES_MONSTRUOS = [
    '🐺 Glitch Salvaje', '🤖 Dron de Vigilancia corrupto', '🦂 Fragmento de Virus',
    '🐍 Bot Rastreador', '🕷️ Spam-bot rabioso', '🦇 Sombra de Datos', '🐀 Rata de Servidor',
    '👾 Anomalía Menor', '🦍 Proceso Zombie', '🦅 Halcón de Firewall'
]

// ========== WOLFRIC PROTOCOL: MAZMORRAS (5 niveles, hasta 3 jugadores) ==========
const mazmorrasActivas = new Map() // chatId -> { estado, participantes, hpJugadores, caidos:Set, nivel, monstruoHp, monstruoHpMax, monstruoNombre, timestamp }
const ultimaMazmorraPorGrupo = new Map() // chatId -> timestamp de fin de la última (cooldown)
const MAZMORRA_COOLDOWN_MS = 3 * 60 * 1000
function maxJugadoresMazmorra() { return eventoAmigoActivo() ? 5 : 3 }
const MAZMORRA_JOIN_MS = 45 * 1000
const NOMBRES_MAZMORRA = ['Centinela Corrupto', 'Golem de Datos', 'Espectro de Red', 'Devorador de Paquetes', 'Guardián del Núcleo']

function spawnMonstruoMazmorra(nivel, numJugadores) {
    const hp = Math.floor((150 * nivel) * (1 + 0.35 * (numJugadores - 1)))
    return { hp, hpMax: hp, nombre: `${NOMBRES_MAZMORRA[nivel - 1]} (Nvl. ${nivel})` }
}

function spawnearBoss(chatId, miembrosGrupo = 0) {
    const hp = BOSS_HP_BASE + (miembrosGrupo * 1000)
    bosses.set(chatId, { hp, maxHp: hp, participantes: new Map(), spawnedAt: Date.now(), nombre: BOSS_NOMBRE })

    // El boss ataca cada 5 minutos a quien más daño le hizo (MVP) y a todos los que atacaron recientemente
    const intervalo = setInterval(() => {
        const boss = bosses.get(chatId)
        if (!boss || boss.hp <= 0) { clearInterval(intervalo); return }
        // (El daño de área se resuelve dentro del handler de mensajes al usar .attackboss, aquí solo mantenemos el ciclo vivo)
    }, 5 * 60 * 1000)

    // El boss huye si no lo matan en 45 minutos
    setTimeout(() => {
        const boss = bosses.get(chatId)
        if (boss && boss.hp > 0) {
            bosses.delete(chatId)
            clearInterval(intervalo)
        }
    }, 45 * 60 * 1000)

    return bosses.get(chatId)
}

// ========== ANTI-BANEO ==========
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function delayAleatorio(minSeg = 1, maxSeg = 10) {
    return Math.floor(Math.random() * (maxSeg - minSeg + 1) + minSeg) * 1000
}

// --- 1) Calentamiento: al iniciar, el bot responde más lento los primeros minutos ---
// Las cuentas recién vinculadas o recién reiniciadas son más vigiladas por WhatsApp.
const INICIO_BOT = Date.now()
const MINUTOS_CALENTAMIENTO = 15
function enCalentamiento() {
    return (Date.now() - INICIO_BOT) < MINUTOS_CALENTAMIENTO * 60 * 1000
}

// --- 2) Rate limit por usuario: evita que alguien spamee comandos y active detección de bot ---
const historialUsuario = new Map() // jid -> [timestamps]
const LIMITE_COMANDOS = 8       // máximo de comandos...
const VENTANA_MS = 60 * 1000    // ...por minuto
function usuarioExcedioLimite(jid) {
    const ahora = Date.now()
    const historial = (historialUsuario.get(jid) || []).filter(t => ahora - t < VENTANA_MS)
    historial.push(ahora)
    historialUsuario.set(jid, historial)
    return historial.length > LIMITE_COMANDOS
}

// --- 3) Cooldown específico para acciones "ruidosas" (menciones masivas, cambios de grupo) ---
const ultimaAccionRuidosa = new Map() // jid del grupo -> timestamp
const COOLDOWN_RUIDOSO_MS = 30 * 1000
function accionRuidosaEnCooldown(jid) {
    const ahora = Date.now()
    const ultima = ultimaAccionRuidosa.get(jid) || 0
    if (ahora - ultima < COOLDOWN_RUIDOSO_MS) return true
    ultimaAccionRuidosa.set(jid, ahora)
    return false
}

// --- 3b) Cooldown más largo específico para tagall/hidetag: mencionar a TODOS es la señal
// de spam más vigilada por WhatsApp, así que se limita más estricto que otras acciones ruidosas.
const ultimoTagall = new Map() // jid del grupo -> timestamp
const COOLDOWN_TAGALL_MS = 3 * 60 * 1000
function tagallEnCooldown(jid) {
    const ahora = Date.now()
    const ultima = ultimoTagall.get(jid) || 0
    if (ahora - ultima < COOLDOWN_TAGALL_MS) return Math.ceil((COOLDOWN_TAGALL_MS - (ahora - ultima)) / 1000)
    ultimoTagall.set(jid, ahora)
    return 0
}

// --- 4) Throttle global de envíos: ningún par de mensajes salientes del bot (a cualquier
// chat) sale más rápido que esto. Evita ráfagas cuando se manda a varios chats seguidos
// (recordatorio de misión, avisos automáticos, etc.) — un patrón de ráfaga es otra señal típica.
let ultimoEnvioGlobalTs = 0
const PISO_ENTRE_ENVIOS_MS = 350
async function esperarTurnoEnvio() {
    const ahora = Date.now()
    const espera = PISO_ENTRE_ENVIOS_MS - (ahora - ultimoEnvioGlobalTs)
    if (espera > 0) await sleep(espera + Math.floor(Math.random() * 150)) // + jitter
    ultimoEnvioGlobalTs = Date.now()
}

const FRONTIER_MEDIA = Object.freeze({
    transito: 'transito_frontera.jpg',
    descubrimiento: 'descubrimiento_senal.jpg',
    desafio: 'desafio_guardian.jpg',
    victoria: 'victoria_sello.jpg'
})

function frontierRutaMedia(tipo) {
    const archivo = FRONTIER_MEDIA[tipo]
    if (!archivo) return null
    const candidatas = [
        path.join(process.cwd(), 'frontier_media', archivo),
        typeof __dirname !== 'undefined' ? path.join(__dirname, 'frontier_media', archivo) : null
    ].filter(Boolean)
    return candidatas.find(ruta => fs.existsSync(ruta)) || null
}

async function sendFrontierEvento(sock, jid, tipo, texto, options = {}) {
    const ruta = frontierRutaMedia(tipo)
    if (!ruta) return sendReply(sock, jid, { text: texto }, options)
    return sendReply(sock, jid, { image: fs.readFileSync(ruta), caption: texto }, options)
}

// ========== WOLFRIC PROTOCOL: CACHÉ DE METADATA DE GRUPO ==========
// sock.groupMetadata() es un pedido de red a WhatsApp — pedirlo en CADA mensaje de un grupo
// (solo para saber si alguien es admin) es innecesario y suma carga/latencia sin falta.
// Se cachea 5 minutos por grupo; si algo cambia (alguien se hace admin, etc.) tarda como mucho
// eso en reflejarse, que es un trade-off totalmente razonable para este uso.
const cacheGroupMetadata = new Map() // jid -> { data, ts }
const GROUP_METADATA_TTL_MS = 5 * 60 * 1000
async function obtenerGroupMetadataCache(sock, jid) {
    const cacheado = cacheGroupMetadata.get(jid)
    if (cacheado && (Date.now() - cacheado.ts) < GROUP_METADATA_TTL_MS) return cacheado.data
    const data = await sock.groupMetadata(jid)
    cacheGroupMetadata.set(jid, { data, ts: Date.now() })
    return data
}
// Para cuando algo SÍ necesita el dato fresco al toque (justo después de promover/expulsar a alguien, etc.)
function invalidarGroupMetadataCache(jid) {
    cacheGroupMetadata.delete(jid)
}

// ========== WOLFRIC PROTOCOL: MINIJUEGOS Y FRASES SOCIALES ==========
const juegosTTT = new Map()      // chatId -> { tablero, turno, jugadores, simbolos }
const juegosAhorcado = new Map() // chatId -> { palabra, adivinadas, intentosRestantes }

// ========== WOLFRIC PROTOCOL: AKINATOR ==========
// Implementación propia del protocolo público de akinator.com (session/signature/step/progression),
// el mismo que usan varias libs open-source en distintos lenguajes. No es una API oficial documentada,
// así que si en algún momento Akinator cambia su web, esto puede necesitar un ajuste.
const juegosAkinator = new Map() // chatId -> { cookies, base, session, signature, step, progression, pregunta }
const AKI_UA = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36'
const AKI_LANGS = { es: 'es', pt: 'pt', en: 'en' }

function akiCookieString(cookies) {
    return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}
function akiGuardarCookies(cookies, res) {
    let crudas = []
    if (typeof res.headers.getSetCookie === 'function') crudas = res.headers.getSetCookie()
    else res.headers.forEach((val, key) => { if (key.toLowerCase() === 'set-cookie') crudas.push(...val.split(/,(?=\s*[a-zA-Z0-9_-]+=)/)) })
    for (const c of crudas) {
        const [par] = c.split(';')
        const [k, ...v] = par.split('=')
        if (k && v.length) cookies.set(k.trim(), v.join('=').trim())
    }
}
async function akiGet(base, cookies, url) {
    const res = await fetch(url, { headers: { 'User-Agent': AKI_UA, Cookie: akiCookieString(cookies) } })
    akiGuardarCookies(cookies, res)
    return await res.text()
}
async function akiPost(base, cookies, url, data) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'User-Agent': AKI_UA, Cookie: akiCookieString(cookies),
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest', Origin: base, Referer: `${base}/game`
        },
        body: new URLSearchParams(data).toString()
    })
    akiGuardarCookies(cookies, res)
    const texto = await res.text()
    try { return JSON.parse(texto) } catch (e) { return texto }
}
function akiParseWs(texto) {
    const limpio = String(texto || '').replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, '')
    try { return JSON.parse(limpio) } catch (_) {}
    try { return JSON.parse(texto) } catch (_) { return null }
}
async function akiWs(base, cookies, ruta, params) {
    const qs = new URLSearchParams(params).toString()
    const url = `${base}/ws/${ruta}?${qs}`
    const res = await fetch(url, {
        headers: {
            'User-Agent': AKI_UA,
            Cookie: akiCookieString(cookies),
            Referer: `${base}/`,
            Accept: 'application/json,text/javascript,*/*'
        }
    })
    akiGuardarCookies(cookies, res)
    const texto = await res.text()
    const data = akiParseWs(texto)
    if (!data) throw new Error('akinator ws inválido')
    return data
}
async function akiIniciarOficial(idioma) {
    const base = `https://${AKI_LANGS[idioma] || 'es'}.akinator.com`
    const cookies = new Map()
    let frontaddr = 'game_session'
    try {
        const home = await akiGet(base, cookies, base)
        const fm = String(home).match(/frontaddr\s*=\s*['"]([^'"]+)['"]/)
        if (fm) frontaddr = fm[1]
    } catch (_) {}
    const data = await akiWs(base, cookies, 'new_session', {
        callback: '',
        partner: '1',
        player: 'website-desktop',
        uid_ext_session: '',
        frontaddr,
        constraint: "ETAT<>'AVOIR_ENVI'",
        soft_constraint: '',
        question_filter: '',
        childMod: 'true'
    })
    const params = data?.parameters
    const ident = params?.identification
    const step = params?.step_information
    if (!ident?.session || !ident?.signature || !step?.question) throw new Error('No se pudo iniciar Akinator ahora mismo.')
    return {
        modo: 'oficial', base, cookies,
        session: String(ident.session),
        signature: String(ident.signature),
        step: String(step.step || '0'),
        progression: String(step.progression || '0'),
        pregunta: String(step.question)
    }
}
async function akiIniciarGemini(idioma) {
    if (!GEMINI_API_KEY) throw new Error('Akinator no disponible')
    const langHint = idioma === 'pt' ? 'português' : idioma === 'en' ? 'English' : 'español'
    const system = `Jugás un Akinator familiar en ${langHint}. El usuario piensa un personaje de dibujos, juegos, libros o historia. Hacés UNA sola pregunta de sí/no por turno. Nada de contenido para adultos.`
    const pregunta = String(await preguntarGemini('Empezá. Primera pregunta solamente.', { systemPrompt: system })).trim()
    if (!pregunta) throw new Error('Akinator no disponible')
    return { modo: 'gemini', historial: [{ role: 'user', text: 'empezar' }, { role: 'model', text: pregunta }], pregunta, step: '0', progression: '0' }
}
async function akiIniciar(idioma) {
    try { return await akiIniciarOficial(idioma) } catch (e1) {
        console.log('Akinator oficial falló, uso respaldo:', e1 && e1.message ? e1.message : e1)
        return await akiIniciarGemini(idioma)
    }
}
async function akiResponder(juego, respuesta) {
    if (juego.modo === 'gemini') {
        const mapa = { 0: 'sí', 1: 'no', 2: 'no sé', 3: 'probable', 4: 'improbable' }
        const ans = mapa[respuesta] || 'no sé'
        const system = 'Seguís el Akinator familiar. Si ya sabés el personaje, respondé exactamente: GUESS: nombre | descripción corta. Si no, solo la siguiente pregunta de sí/no.'
        const out = String(await preguntarGemini(ans, { systemPrompt: system, historial: juego.historial || [] })).trim()
        juego.historial = (juego.historial || []).concat([{ role: 'user', text: ans }, { role: 'model', text: out }])
        const guess = out.match(/GUESS:\s*([^|]+)\|\s*(.*)/i) || out.match(/GUESS:\s*(.+)/i)
        if (guess) return { ganado: true, nombre: guess[1].trim(), descripcion: (guess[2] || '').trim(), foto: null }
        juego.pregunta = out
        juego.step = String(Number(juego.step || 0) + 1)
        return { ganado: false, pregunta: juego.pregunta, progreso: Math.min(99, Number(juego.step) * 5) }
    }
    const data = await akiWs(juego.base, juego.cookies, 'answer', {
        callback: '',
        session: juego.session,
        signature: juego.signature,
        step: juego.step,
        answer: String(respuesta),
        question_filter: '',
        childMod: 'true'
    })
    const params = data?.parameters || data
    if (params.id_proposition || params.name_proposition) {
        return { ganado: true, nombre: params.name_proposition, descripcion: params.description_proposition, foto: params.photo }
    }
    if (params.step !== undefined) juego.step = String(params.step)
    if (params.progression !== undefined) juego.progression = String(params.progression)
    if (params.question) juego.pregunta = String(params.question)
    return { ganado: false, pregunta: juego.pregunta, progreso: Math.round(parseFloat(juego.progression || '0')) }
}

function dibujarTTT(tablero) {
    const c = tablero.map((v, i) => v || (i + 1))
    return `${c[0]} │ ${c[1]} │ ${c[2]}\n──┼───┼──\n${c[3]} │ ${c[4]} │ ${c[5]}\n──┼───┼──\n${c[6]} │ ${c[7]} │ ${c[8]}`
}
function revisarGanadorTTT(t) {
    const lineas = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]
    return lineas.some(([a, b, c]) => t[a] && t[a] === t[b] && t[a] === t[c])
}

const PREGUNTAS_VERDAD = {
    es: [
        '¿Cuál es tu mayor miedo?', '¿A quién del grupo admirás más?', '¿Cuál fue tu mentira más grande?',
        '¿Qué es lo más vergonzoso que hiciste este año?', '¿Tenés algún crush acá?', '¿Cuál es tu mayor arrepentimiento?',
        '¿Qué es lo que más te gusta de vos mismo?', '¿Alguna vez copiaste en un examen?'
    ],
    pt: [
        'Qual é o seu maior medo?', 'Quem do grupo você mais admira?', 'Qual foi sua maior mentira?',
        'Qual foi a coisa mais vergonhosa que você fez esse ano?', 'Você tem crush em alguém aqui?', 'Qual é o seu maior arrependimento?',
        'O que você mais gosta em você mesmo?', 'Você já colou em uma prova?'
    ],
    en: [
        "What's your biggest fear?", 'Who in the group do you admire most?', "What's the biggest lie you've told?",
        "What's the most embarrassing thing you did this year?", 'Do you have a crush here?', "What's your biggest regret?",
        'What do you like most about yourself?', 'Have you ever cheated on a test?'
    ]
}
const RETOS_DARE = {
    es: [
        'Mandá un audio cantando algo random.', 'Escribí tu próximo mensaje solo con emojis.',
        'Contá el chiste más malo que sepas.', 'Mandá una foto de lo primero que veas al levantar la vista.',
        'Escribí "los amo a todos" en el grupo.', 'Imitá a otro miembro del grupo en un mensaje.'
    ],
    pt: [
        'Manda um áudio cantando algo aleatório.', 'Escreva sua próxima mensagem só com emojis.',
        'Conte a piada mais ruim que você conhece.', 'Manda uma foto da primeira coisa que você vê ao levantar o olhar.',
        'Escreva "eu amo todo mundo aqui" no grupo.', 'Imite outro membro do grupo numa mensagem.'
    ],
    en: [
        'Send a voice note singing something random.', 'Type your next message using only emojis.',
        'Tell the worst joke you know.', 'Send a photo of the first thing you see when you look up.',
        'Type "I love everyone here" in the group.', 'Imitate another group member in a message.'
    ]
}
const CUMPLIDOS = {
    es: ['{user} tiene una energía que ilumina el grupo. ✨', '{user} es de las mejores personas que hay acá. 💖', 'El día mejora cuando {user} escribe algo. 🌟', '{user} tiene un gusto increíble para todo.'],
    pt: ['{user} tem uma energia que ilumina o grupo. ✨', '{user} é uma das melhores pessoas daqui. 💖', 'O dia melhora quando {user} escreve algo. 🌟', '{user} tem um gosto incrível pra tudo.'],
    en: ['{user} has an energy that lights up the group. ✨', "{user} is one of the best people here. 💖", 'The day gets better when {user} says something. 🌟', '{user} has amazing taste in everything.']
}
const INSULTOS_JOCOSOS = {
    es: ['{user}, tenés menos rango que un NPC. 😹', '{user} juega peor que un bot en modo fácil. 😹', 'Con ese nivel, {user} debería volver al tutorial. 😹', '{user}, ni el gacha te quiere. 😹'],
    pt: ['{user}, você tem menos status que um NPC. 😹', '{user} joga pior que um bot no modo fácil. 😹', 'Com esse nível, {user} deveria voltar pro tutorial. 😹', '{user}, nem a gacha te quer. 😹'],
    en: ["{user}, you have less rank than an NPC. 😹", '{user} plays worse than an easy-mode bot. 😹', "With that level, {user} should go back to the tutorial. 😹", "{user}, not even the gacha wants you. 😹"]
}
const FRASES_FLIRT = {
    es: ['{user}, ¿sos wifi? porque siento conexión. 😏', 'Si fueras un ítem del gacha, serías legendario, {user}. 😏', '{user}, tu perfil tiene más brillo que cualquier título del juego. 😏'],
    pt: ['{user}, você é wifi? porque eu senti uma conexão. 😏', 'Se você fosse um item da gacha, seria lendário, {user}. 😏', '{user}, seu perfil brilha mais que qualquer título do jogo. 😏'],
    en: ["{user}, are you wifi? because I'm feeling a connection. 😏", "If you were a gacha item, you'd be legendary, {user}. 😏", "{user}, your profile shines brighter than any title in the game. 😏"]
}
const PALABRAS_AHORCADO = {
    es: ['gremio', 'duelo', 'mazmorra', 'boss', 'fruta', 'gacha', 'monstruo', 'guerra', 'racha', 'protocolo'],
    pt: ['guilda', 'duelo', 'masmorra', 'chefe', 'fruta', 'gacha', 'monstro', 'guerra', 'sequencia', 'protocolo'],
    en: ['guild', 'duel', 'dungeon', 'boss', 'fruit', 'gacha', 'monster', 'war', 'streak', 'protocol']
}

// ========== WOLFRIC PROTOCOL: ANTIDELETE / VIEWONCE ==========
// Cache transitorio de mensajes por grupo (solo se llena si el grupo tiene .antidelete on).
// Se limpia solo a los 15 minutos, así no crece sin límite ni junta info vieja innecesaria.
const cacheAntidelete = new Map() // `${chatId}:${msgId}` -> { sender, texto, mediaBuffer, mediaTipo, ts }
const ANTIDELETE_TTL_MS = 15 * 60 * 1000
setInterval(() => {
    const ahora = Date.now()
    for (const [k, v] of cacheAntidelete.entries()) if (ahora - v.ts > ANTIDELETE_TTL_MS) cacheAntidelete.delete(k)
}, 5 * 60 * 1000)

// ========== WOLFRIC PROTOCOL: GIFS (GIPHY) ==========
// Tenor fue discontinuada por Google (cerró del todo el 30/06/2026), así que usamos GIPHY en su lugar.
// Key gratis en https://developers.giphy.com — "Create an App" → API (no SDK).
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || ''
const gifCache = new Map() // query -> { url, ts }
const GIF_CACHE_MS = 6 * 60 * 60 * 1000 // 6 horas, para no gastar cuota pidiendo lo mismo todo el rato

async function buscarGif(query) {
    if (!GIPHY_API_KEY) return null
    if (typeof fetch !== 'function') return null // Node muy viejo sin fetch global (actualizá a Node 18+)
    // Todos los gifs del bot son de temática anime, sin importar de dónde venga la búsqueda.
    const queryAnime = /\banime\b/i.test(query) ? query : `anime ${query}`
    const cacheado = gifCache.get(queryAnime)
    if (cacheado && (Date.now() - cacheado.ts) < GIF_CACHE_MS) return cacheado.url
    try {
        const limit = 15
        const url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(queryAnime)}&limit=${limit}&rating=pg-13&lang=es`
        const res = await fetch(url)
        if (!res.ok) return null
        const data = await res.json()
        const resultados = (data.data || []).map(g => g?.images?.original?.mp4 || g?.images?.downsized_medium?.mp4 || g?.images?.fixed_height?.mp4).filter(Boolean)
        if (!resultados.length) return null
        const elegido = resultados[Math.floor(Math.random() * resultados.length)]
        gifCache.set(queryAnime, { url: elegido, ts: Date.now() })
        return elegido
    } catch (e) {
        console.log('[WOLFRIC] Error buscando gif en GIPHY:', e.message || e)
        return null
    }
}

// Manda un gif (como video en loop, sin sonido — así lo muestra WhatsApp) buscado por palabra clave.
// Si GIPHY no está configurado o falla, no manda nada y no corta el flujo del comando que lo llamó.
async function enviarGif(sock, jid, query, caption = '', options = {}) {
    try {
        const gifUrl = await buscarGif(query)
        if (!gifUrl) return false
        await esperarTurnoEnvio()
        await sock.sendMessage(jid, { video: { url: gifUrl }, gifPlayback: true, caption }, options)
        return true
    } catch (e) {
        console.log('[WOLFRIC] Error enviando gif:', e.message || e)
        return false
    }
}

// Manda el texto de una respuesta CON el gif adentro del mismo mensaje (el gif como video en loop y
// el texto como caption), en vez de dos mensajes separados. Si no hay gif disponible (sin key o sin
// resultados), cae automáticamente a un mensaje de texto normal — nunca corta el flujo del comando.
// mentions es un array opcional de jids a etiquetar; quotedOpts es el options normal (ej: {quoted: m}).
async function enviarConGif(sock, jid, texto, gifQuery, mentions = [], quotedOpts = {}) {
    try {
        const gifUrl = gifQuery ? await buscarGif(gifQuery) : null
        if (gifUrl) {
            await esperarTurnoEnvio()
            const content = { video: { url: gifUrl }, gifPlayback: true, caption: texto }
            if (mentions && mentions.length) content.mentions = mentions
            await sock.sendMessage(jid, content, quotedOpts)
            return true
        }
    } catch (e) {
        console.log('[WOLFRIC] Error enviando gif:', e.message || e)
    }
    const contentTexto = { text: texto }
    if (mentions && mentions.length) contentTexto.mentions = mentions
    await sendReply(sock, jid, contentTexto, quotedOpts)
    return false
}

// ========== WOLFRIC PROTOCOL: RACHA DIARIA (HITOS) ==========
// Hitos de la racha diaria (.daily consecutivo). Al llegar a cada uno se paga una sola vez.
// El de 1000 días da el título más grande del bot, pensado para jugadores realmente veteranos.
const HITOS_RACHA_DIARIA = [
    { dias: 3, coins: 150 },
    { dias: 7, coins: 400, titulo: 'Constante' },
    { dias: 14, coins: 800 },
    { dias: 30, coins: 2000, titulo: 'Fiel a Wolfric' },
    { dias: 60, coins: 4000 },
    { dias: 100, coins: 7000, titulo: 'Centenario' },
    { dias: 180, coins: 12000 },
    { dias: 365, coins: 25000, titulo: 'Guardián del Año' },
    { dias: 500, coins: 40000 },
    { dias: 1000, coins: 100000, titulo: 'Veterano Eterno' }
]

// ========== WOLFRIC PROTOCOL: RECOMPENSA VARIABLE (dopamina real: incertidumbre > monto fijo) ==========
// Se usa en cofres y cacería: la mayoría de las veces da el premio normal, pero hay
// una chance chica de que caiga un multiplicador grande. Esa incertidumbre es lo que engancha.
const TIERS_RECOMPENSA_VARIABLE = [
    { rareza: 'común', prob: 0.68, mult: 1, emoji: '' },
    { rareza: 'raro', prob: 0.20, mult: 2, emoji: '✨' },
    { rareza: 'épico', prob: 0.09, mult: 4, emoji: '💎' },
    { rareza: 'legendario', prob: 0.03, mult: 10, emoji: '🌟' }
]
function tirarRecompensaVariable(premioBase) {
    const roll = Math.random()
    let acumulado = 0
    let tier = TIERS_RECOMPENSA_VARIABLE[0]
    for (const t of TIERS_RECOMPENSA_VARIABLE) {
        acumulado += t.prob
        if (roll <= acumulado) { tier = t; break }
    }
    return { premio: Math.floor(premioBase * tier.mult), rareza: tier.rareza, esRaro: tier.mult > 1, emoji: tier.emoji }
}

// Barra visual de progreso hacia el próximo hito de racha (texto tipo [███████░░░] 70%)
function barraProgresoRacha(actual, objetivo, longitud = 12) {
    if (!objetivo || objetivo <= 0 || actual >= objetivo) return `[${'█'.repeat(longitud)}] 100%`
    const pct = Math.max(0, Math.min(1, actual / objetivo))
    const llenos = Math.round(pct * longitud)
    return `[${'█'.repeat(llenos)}${'░'.repeat(longitud - llenos)}] ${Math.floor(pct * 100)}%`
}

// Envío "humanizado": marca "escribiendo...", espera un tiempo aleatorio (más lento en calentamiento) y luego envía.
// Por defecto intenta acompañar el texto con un gif dentro del mismo mensaje (caption). Para desactivarlo
// en un comando puntual (farmeo de alta frecuencia: cazar, work, mazmorra, boss), pasar options.sinGif = true.
async function sendReply(sock, jid, content, options = {}) {
    await esperarTurnoEnvio() // respeta un piso global entre CUALQUIER par de mensajes salientes del bot
    try {
        await sock.presenceSubscribe(jid).catch(() => {})
        await sock.sendPresenceUpdate('composing', jid)
        // Se muestra "escribiendo..." mientras se prepara el envío.
        // Durante el calentamiento (primeros minutos tras iniciar/reconectar) el delay es más largo:
        // una cuenta recién vinculada que responde instantáneo a todo es la señal más obvia de bot.
        const delay = enCalentamiento() ? delayAleatorio(2, 5) : delayAleatorio(0.4, 0.9)
        await sleep(delay)
        const resultado = await sock.sendMessage(jid, content, options)
        await sock.sendPresenceUpdate('paused', jid)
        return resultado
    } catch (e) {
        // Si falla la presencia, igual intenta enviar el mensaje
        return await sock.sendMessage(jid, content, options)
    }
}

// ========== WOLFRIC PROTOCOL: EVENTO "DÍA DEL AMIGO" (7 DÍAS) ==========
// Se activa la primera vez que corre esta versión del bot y dura exactamente 7 días desde entonces
// (la fecha de inicio se guarda en disco para sobrevivir a reinicios).
const EVENTO_AMIGO_ARCHIVO = './evento_amigo.json'
const EVENTO_AMIGO_DURACION_MS = 7 * 24 * 60 * 60 * 1000
const EVENTO_AMIGO_META = 20 // partidas de 2vs2 o mazmorra (sumadas) para ganar el premio
let eventoAmigoInicio = Date.now()
try {
    if (fs.existsSync(EVENTO_AMIGO_ARCHIVO)) {
        eventoAmigoInicio = JSON.parse(fs.readFileSync(EVENTO_AMIGO_ARCHIVO, 'utf8')).inicio
    } else {
        fs.writeFileSync(EVENTO_AMIGO_ARCHIVO, JSON.stringify({ inicio: eventoAmigoInicio }))
    }
} catch (e) { console.log('No se pudo inicializar el evento Día del Amigo:', e) }

function eventoAmigoActivo() { return Date.now() - eventoAmigoInicio < EVENTO_AMIGO_DURACION_MS }
function eventoAmigoTiempoRestante() { return Math.max(0, EVENTO_AMIGO_DURACION_MS - (Date.now() - eventoAmigoInicio)) }

// Suma 1 al progreso del jugador (llamado al terminar una partida de 2vs2 o una mazmorra) y entrega el premio al llegar a la meta.
// Devuelve un texto de aviso si se otorgó el premio en este momento (o null si no pasó nada especial).
function otorgarProgresoEventoAmigo(user) {
    if (!eventoAmigoActivo() || user.eventoAmigoReclamado) return null
    user.eventoAmigoProgreso = (user.eventoAmigoProgreso || 0) + 1
    if (user.eventoAmigoProgreso < EVENTO_AMIGO_META) return null

    user.eventoAmigoReclamado = true
    otorgarFruta(user, 'Amigo', 'evento')
    user.inventory.push('Poción Neón Pequeña', 'Poción Neón Pequeña', 'Poción Neón Pequeña', 'Batería de Iones', 'Batería de Iones')
    user.exp += 40
    user.coins += 500
    user.lifetimeCoinsEarned += 500
    user.bounty += 60
    return `🎉🤝 *¡PAQUETE DEL DÍA DEL AMIGO DESBLOQUEADO!* 🤝🎉\nCompletaste ${EVENTO_AMIGO_META} partidas de 2vs2/mazmorra durante el evento.\nRecibiste: fruta exclusiva *Amigo* 🍎, 3x Poción Neón Pequeña, 2x Batería de Iones, +40 EXP, +$500 y +60 Bounty.`
}


// Registra quién usó un comando admin_, qué comando, con qué parámetros, a quién afectó y cuándo.
const ADMIN_LOG_FILE = './admin_log.json'
function registrarAccionRoot(senderJid, comando, argsTexto, objetivoJid) {
    try {
        let log = []
        if (fs.existsSync(ADMIN_LOG_FILE)) {
            try { log = JSON.parse(fs.readFileSync(ADMIN_LOG_FILE, 'utf8')) } catch (e) { log = [] }
        }
        log.push({
            fecha: new Date().toISOString(),
            admin: senderJid,
            comando,
            parametros: argsTexto,
            objetivo: objetivoJid || null
        })
        // conserva solo las últimas 2000 entradas para no crecer sin límite
        if (log.length > 2000) log = log.slice(log.length - 2000)
        fs.writeFileSync(ADMIN_LOG_FILE, JSON.stringify(log, null, 2))
    } catch (e) {
        console.log('Error escribiendo log de auditoría root:', e)
    }
}

function clockString(ms) {
    let h = Math.floor(ms / 3600000)
    let m = Math.floor(ms / 60000) % 60
    let s = Math.floor(ms / 1000) % 60
    return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':')
}


async function enviarMenuBotones(sock, jid, quoted, imageBuffer = null, lang = 'es') {
    const nombre = (typeof botConfig !== 'undefined' && botConfig.botName) ? botConfig.botName : 'Wolfric'
    const uptime = clockString(Date.now() - INICIO_BOT)
    const totalComandos = COMANDOS_VALIDOS.size
    const canalTxt = botConfig.channelUrl || 'https://whatsapp.com/channel/0029VbDSzOv8KMqcStjGog1T'
    const statsCaption = tr(lang,
        `╭─❃ 🐺 *${nombre}* ❃─╮\n\n│ 👑 Creador: Wolfric Protocol\n│ ⚙️ Prefijo: [ ${prefix} ]\n│ ⏱️ Activo: ${uptime}\n│ 📦 Comandos: ${totalComandos}\n╰─────────────╯\n\n📢 Canal: ${canalTxt}\n\n${textoUI(lang, 'menu_caption')}`,
        `╭─❃ 🐺 *${nombre}* ❃─╮\n\n│ 👑 Criador: Wolfric Protocol\n│ ⚙️ Prefixo: [ ${prefix} ]\n│ ⏱️ Ativo: ${uptime}\n│ 📦 Comandos: ${totalComandos}\n╰─────────────╯\n\n📢 Canal: ${canalTxt}\n\n${textoUI(lang, 'menu_caption')}`,
        `╭─❃ 🐺 *${nombre}* ❃─╮\n\n│ 👑 Creator: Wolfric Protocol\n│ ⚙️ Prefix: [ ${prefix} ]\n│ ⏱️ Uptime: ${uptime}\n│ 📦 Commands: ${totalComandos}\n╰─────────────╯\n\n📢 Channel: ${canalTxt}\n\n${textoUI(lang, 'menu_caption')}`)
    const caption = statsCaption
    const pt = lang === 'pt'
    const en = lang === 'en'
    const sections = [{
        title: textoUI(lang, 'categorias'),
        rows: [
            { header: '', title: pt ? 'Jogador' : en ? 'Player' : 'Jugador', description: pt ? 'stats e economia' : en ? 'stats and economy' : 'stats y economía', id: 'cat_jugador', rowId: 'cat_jugador' },
            { header: '', title: pt ? 'Frutas' : en ? 'Fruits' : 'Frutas', description: pt ? 'gacha e estilos' : en ? 'gacha and styles' : 'gacha y estilos', id: 'cat_frutas', rowId: 'cat_frutas' },
            { header: '', title: 'PvP', description: pt ? 'duelos e equipes' : en ? 'duels and teams' : 'duelos y equipos', id: 'cat_pvp', rowId: 'cat_pvp' },
            { header: '', title: pt ? 'Atividade' : en ? 'Activity' : 'Actividad', description: pt ? 'caça e masmorra' : en ? 'hunt and dungeon' : 'caza y mazmorra', id: 'cat_actividad', rowId: 'cat_actividad' },
            { header: '', title: pt ? 'Comércio' : en ? 'Trade' : 'Comercio', description: pt ? 'itens e mercado' : en ? 'items and market' : 'ítems y mercado', id: 'cat_comercio', rowId: 'cat_comercio' },
            { header: '', title: pt ? 'Mundo' : en ? 'World' : 'Mundo', description: pt ? 'guildas e mares' : en ? 'guilds and seas' : 'gremios y mares', id: 'cat_mundo', rowId: 'cat_mundo' },
            { header: '', title: 'Media', description: pt ? 'downloads e figurinhas' : en ? 'downloads and stickers' : 'descargas y stickers', id: 'cat_media', rowId: 'cat_media' },
            { header: '', title: pt ? 'Interativo' : en ? 'Interactive' : 'Interactivo', description: pt ? 'ações com jogadores' : en ? 'actions with players' : 'acciones con jugadores', id: 'cat_interactivo', rowId: 'cat_interactivo' },
            { header: '', title: 'IA', description: pt ? 'converse com o Gemini' : en ? 'chat with Gemini' : 'charlá con Gemini', id: 'cat_ia', rowId: 'cat_ia' },
            { header: '', title: pt ? 'Fronteira' : en ? 'Frontier' : 'Frontera', description: 'Wolfric Frontier', id: 'cat_frontier', rowId: 'cat_frontier' }
        ]
    }]

    // Formato del fork para GRUPOS: nativeFlow / botón con sections
    // (la lista vieja buttonText+sections SOLO funciona en privado)
    const intentos = [
        {
            image: imageBuffer || undefined,
            text: caption,
            footer: nombre,
            optionText: textoUI(lang, 'seleccionar_menu'),
            optionTitle: textoUI(lang, 'categorias'),
            nativeFlow: [{
                text: textoUI(lang, 'seleccionar_menu'),
                sections,
                icon: 'default'
            }]
        },
        {
            image: imageBuffer || undefined,
            text: caption,
            footer: nombre,
            buttons: [{ text: textoUI(lang, 'seleccionar_menu'), sections }]
        },
        // Sin imagen, por si el envío con imagen falla (link roto, buffer corrupto, etc.)
        {
            text: caption,
            footer: nombre,
            optionText: textoUI(lang, 'seleccionar_menu'),
            optionTitle: textoUI(lang, 'categorias'),
            nativeFlow: [{
                text: textoUI(lang, 'seleccionar_menu'),
                sections,
                icon: 'default'
            }]
        }
    ]
    for (const payload of intentos) {
        try {
            await sock.sendMessage(jid, payload)
            return true
        } catch (e) {
            console.log('menu nativeFlow error:', e && (e.message || e))
        }
    }
    try {
        await sock.sendMessage(jid, { text: caption + (lang === 'pt' ? '\n\nUse *.wolfric jugador* / *.wolfric frutas* / etc.' : lang === 'en' ? '\n\nUse *.wolfric player* / *.wolfric fruits* / etc.' : '\n\nUsá *.wolfric jugador* / *.wolfric frutas* / etc.') })
        return true
    } catch (_) {
        return false
    }
}

function menuCategoria(prefix, cat, lang = 'es') {
    const map = {
        jugador: 'jugador', player: 'jugador', frutas: 'frutas', fruits: 'frutas', pvp: 'pvp',
        actividad: 'actividad', activity: 'actividad',
        comercio: 'comercio', trade: 'comercio', shop: 'comercio',
        mundo: 'mundo', world: 'mundo', media: 'media', frontier: 'frontera',
        frontera: 'frontera', economia: 'jugador', economy: 'jugador', combate: 'pvp', combat: 'pvp', social: 'mundo',
        admin: 'admin', owner: 'owner', texto: 'texto', ia: 'ia', gemini: 'ia'
    }
    const q = map[cat] || cat
    if (q === 'admin') return menuAdminGrupo(prefix, lang)
    if (q === 'owner') return menuOwnerBot(prefix, lang)
    if (q === 'texto') return frontierMenuPrincipal(prefix, lang)
    if (q === 'frontera') {
        return `${wolfricTitulo(tr(lang,'NUEVO MUNDO','NOVO MUNDO','NEW WORLD'), 'Wolfric Frontier', '🧭')}\n\n${frontierPanel(tr(lang,'RUTA','ROTA','ROUTE'), [
            `${prefix}frontier · ${tr(lang,'abre las rutas','abre as rotas','open the routes')}`,
            `${prefix}map · ${tr(lang,'regiones','regiões','regions')}`,
            `${prefix}explore <región>`,
            `${prefix}register · ${tr(lang,'registrarte','registrar','sign up')}`,
            `${prefix}profile · ${tr(lang,'tu explorador','seu explorador','your explorer')}`
        ], '✦')}\n\n_${tr(lang,'Volver','Voltar','Back')}: ${prefix}menu`
    }
    if (typeof wolfricMenuMovil === 'function') return wolfricMenuMovil(prefix, q, lang)
    return null
}


async function enviarConBotones(sock, jid, texto, botones, quoted) {
    // botones: [{ text, id }]  — un solo mensaje con texto + botones
    try {
        await sock.sendMessage(jid, {
            text: texto,
            footer: (botConfig && botConfig.botName) || 'Wolfric',
            buttons: botones.map(b => ({ text: b.text, id: b.id }))
        }, quoted ? { quoted } : {})
        return true
    } catch (e) {
        try {
            await sock.sendMessage(jid, { text: texto }, quoted ? { quoted } : {})
            return true
        } catch (e2) {
            return false
        }
    }
}

async function enviarBotonesRapidos(sock, jid, quoted, lang = 'es') {
    try {
        const buttons = [
            { text: textoUI(lang, 'btn_menu'), id: 'menu' },
            { text: textoUI(lang, 'btn_perfil'), id: 'perfil' },
            { text: textoUI(lang, 'btn_balance'), id: 'balance' }
        ]
        if (botConfig.channelUrl) {
            buttons.push({
                text: '📢 ' + (botConfig.channelName || 'Canal'),
                url: botConfig.channelUrl
            })
        }
        await sock.sendMessage(jid, {
            text: textoUI(lang, 'accesos'),
            footer: 'Wolfric · botones',
            buttons
        }, quoted ? { quoted } : {})
        return true
    } catch (e) {
        console.log('enviarBotonesRapidos error:', e.message || e)
        return false
    }
}

async function enviarBotonCanal(sock, jid, quoted) {
    try {
        if (!botConfig.channelUrl) {
            await sock.sendMessage(jid, {
                text: '❌ Todavía no hay canal configurado.\nEl owner debe usar: *.setcanal https://whatsapp.com/channel/XXXX*'
            }, quoted ? { quoted } : {})
            return false
        }
        await sock.sendMessage(jid, {
            text: `📢 *${botConfig.channelName || 'Nuestro canal'}*\n\nTocá el botón para abrir el canal de WhatsApp.`,
            footer: botConfig.botName || 'Wolfric',
            buttons: [
                { text: '📢 Abrir canal', url: botConfig.channelUrl }
            ]
        }, quoted ? { quoted } : {})
        return true
    } catch (e) {
        // fallback: mandar el link como texto
        try {
            await sock.sendMessage(jid, {
                text: `📢 *Canal:*\n${botConfig.channelUrl}`
            }, quoted ? { quoted } : {})
            return true
        } catch (e2) {
            console.log('enviarBotonCanal error:', e.message || e)
            return false
        }
    }
}

function bannerWolfric() {
    const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', magenta: '\x1b[35m' }
    console.clear()
    const ancho = process.stdout.columns || 80
    if (ancho < 60) {
        // Pantalla angosta (típico de Termux en un celular en vertical): el ASCII art
        // grande queda cortado y feo, así que se usa una versión compacta.
        console.log(`${c.cyan}${c.bold}◈━━━━━━━━━━━━━━━━━━━━━━━━◈`)
        console.log(`   🐺  W O L F R I C`)
        console.log(`◈━━━━━━━━━━━━━━━━━━━━━━━━◈${c.reset}`)
        console.log(`${c.dim}  v${botConfig.botVersion} · ${botConfig.botEmoji} ${botConfig.botName}${c.reset}\n`)
        return
    }
    console.log(`${c.cyan}${c.bold}
 ██╗    ██╗ ██████╗ ██╗     ███████╗██████╗ ██╗ ██████╗
 ██║    ██║██╔═══██╗██║     ██╔════╝██╔══██╗██║██╔════╝
 ██║ █╗ ██║██║   ██║██║     █████╗  ██████╔╝██║██║
 ██║███╗██║██║   ██║██║     ██╔══╝  ██╔══██╗██║██║
 ╚███╔███╔╝╚██████╔╝███████╗██║     ██║  ██║██║╚██████╗
  ╚══╝╚══╝  ╚═════╝ ╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝ ╚═════╝
${c.reset}${c.dim}  ♥ Versión: ${botConfig.botVersion}  ·  ${botConfig.botEmoji} ${botConfig.botName}${c.reset}
`)
}
// Caja de resumen que se muestra una vez que el bot conectó bien — para ver de
// un vistazo el estado, sin tener que leer línea por línea el log de arranque.
function resumenArranqueWolfric() {
    const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m' }
    const filas = [
        ['Bot', `${botConfig.botEmoji} ${botConfig.botName} v${botConfig.botVersion}`],
        ['Prefijo', prefix],
        ['IA (Gemini)', GEMINI_API_KEY ? 'configurada ✅' : 'sin configurar ❌'],
        ['Panel web', createPanel ? `http://127.0.0.1:${PANEL_PORT_MOSTRAR}` : 'no disponible'],
        ['Node', process.version]
    ]
    const anchoEtiqueta = Math.max(...filas.map(f => f[0].length))
    const ancho = process.stdout.columns || 80
    const linea = '─'.repeat(Math.min(46, ancho - 2))
    console.log(`${c.green}${c.bold}\n╭${linea}╮${c.reset}`)
    console.log(`${c.green}${c.bold}│ ✅ WOLFRIC LISTO${c.reset}`)
    console.log(`${c.green}${linea}${c.reset}`)
    for (const [k, v] of filas) console.log(`${c.dim}  ${k.padEnd(anchoEtiqueta)} ${c.reset}${c.cyan}${v}${c.reset}`)
    console.log(`${c.green}${c.bold}╰${linea}╯${c.reset}\n`)
}
function logWolfric(tipo, msg) {
    const c = {
        reset: '\x1b[0m',
        cyan: '\x1b[36m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        red: '\x1b[31m',
        magenta: '\x1b[35m',
        white: '\x1b[37m',
        bold: '\x1b[1m'
    }
    const colores = {
        INFO: c.cyan,
        SUCCESS: c.green,
        WARN: c.yellow,
        ERROR: c.red,
        SYS: c.magenta
    }
    const col = colores[tipo] || c.white
    console.log(`${col}${c.bold}[WOLFRIC | ${tipo}]${c.reset} ${msg}`)
}

async function startBot() {
    if (!global.__wolfricBannerMostrado) {
        global.__wolfricBannerMostrado = true
        bannerWolfric()
    } else {
        logWolfric('INFO', 'Reconectando...') // sin limpiar pantalla ni redibujar el banner en cada reconexión
    }
    logWolfric('INFO', 'Iniciando componentes internos...')
    logWolfric('INFO', 'Cargando sesión y versión de Baileys...')

    const { state, saveCreds } = await useMultiFileAuthState('./sesion')
    const { version } = await fetchLatestBaileysVersion()
    logWolfric('INFO', `Baileys v${(version || []).join('.')}`)

    // Solo se pregunta UNA VEZ por proceso — startBot() se vuelve a llamar en cada
    // reconexión (incluido el reinicio de mitad de vinculación que exige WhatsApp
    // después de escanear el QR o poner el código), y antes de este fix eso hacía
    // que se volviera a preguntar QR/código ahí, colgado esperando una respuesta
    // que nunca llegaba — por eso parecía que "se reiniciaba y no vinculaba".
    let USAR_CODIGO = false
    let NUMERO_VINCULACION = ''
    if (!state.creds.registered) {
        if (!global.__wolfricVinculacionElegida) {
            global.__wolfricVinculacionElegida = await preguntarMetodoVinculacion()
        }
        const eleccion = global.__wolfricVinculacionElegida
        USAR_CODIGO = eleccion.metodo === 'code'
        NUMERO_VINCULACION = eleccion.numero
        if (USAR_CODIGO && !NUMERO_VINCULACION) {
            logWolfric('WARN', 'No se dio un número válido, se usa QR en su lugar.')
            USAR_CODIGO = false
        }
    }
    logWolfric('INFO', 'Abriendo socket de WhatsApp...')

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        // El "browser" que usás importa de verdad para vincular por código: WhatsApp valida esta combinación
        // contra una lista de dispositivos conocidos. Un nombre inventado (ej: 'Wolfric') puede hacer que el
        // código se rechace en silencio (se ve como reconexiones en loop justo después de pedirlo). Por eso
        // usamos Browsers.ubuntu(...), que es un combo reconocido — con QR esto importa mucho menos.
        browser: USAR_CODIGO ? Browsers.ubuntu('Chrome') : ['Wolfric', 'Chrome', '20.0.04'],
        markOnlineOnConnect: false
    })

    // ====== VINCULACIÓN POR CÓDIGO (sin escanear QR) ======
    // Solo se pide si aún no está registrado (primera vez, o si borraste la carpeta ./sesion)
    if (USAR_CODIGO && !state.creds.registered) {
        setTimeout(async () => {
            try {
                const codigo = await sock.requestPairingCode(NUMERO_VINCULACION)
                const bonito = codigo.includes('-') ? codigo : (codigo.match(/.{1,4}/g)?.join('-') || codigo)
                console.log('\n\x1b[33m\x1b[1m╭──────────────────────────╮')
                console.log(`│   ${bonito}   │`)
                console.log('╰──────────────────────────╯\x1b[0m\n')
                logWolfric('INFO', 'WhatsApp > Ajustes > Dispositivos vinculados > Vincular con número > ingresá ese código')
            } catch (e) {
                logWolfric('ERROR', 'Error pidiendo código de vinculación: ' + (e.message || e))
            }
        }, 3000)
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr && !USAR_CODIGO) {
            logWolfric('WARN', 'Escaneá el QR con WhatsApp > Dispositivos vinculados')
            console.log('')
            qrcode.generate(qr, { small: true })
            console.log('')
        }

        if (connection === 'connecting') {
            logWolfric('INFO', 'Actualizando conexión...')
        }

        if (connection === 'open') {
            logWolfric('SUCCESS', '¡Conectado con éxito!')
            console.log('\n© Wolfric Protocol — todos los derechos reservados. Canal: ' + (botConfig.channelUrl || 'https://whatsapp.com/channel/0029VbDSzOv8KMqcStjGog1T') + '\n')
            resumenArranqueWolfric()
            global.wolfricSock = sock // referencia para avisos automáticos (ranking, bosses) fuera del handler de mensajes
            global.__wolfricIntentosReconexion = 0 // se resetea el backoff al reconectar bien

            // Ranking semanal automático al grupo de avisos (botConfig.grupoAvisos + rankingDia/rankingHora)
            if (!global.__wolfricRankingTimer) {
                global.__wolfricRankingTimer = setInterval(() => {
                    try {
                        if (!botConfig.grupoAvisos) return
                        const ahora = new Date()
                        const yaPosteadoHoy = botConfig.rankingUltimoPost && (new Date(botConfig.rankingUltimoPost)).toDateString() === ahora.toDateString()
                        if (yaPosteadoHoy) return
                        if (ahora.getDay() !== Number(botConfig.rankingDia) || ahora.getHours() !== Number(botConfig.rankingHora)) return
                        botConfig.rankingUltimoPost = ahora.toISOString()
                        guardarBotConfig()
                        enviarAvisoGrupo(generarTextoRanking())
                    } catch (e) { console.log('[WOLFRIC] Error en ranking automático:', e.message || e) }
                }, 60 * 1000) // chequea cada minuto si ya es la hora configurada
                logWolfric('SYS', 'Ranking semanal automático activo (configurable con .setranking)')
            }

            // Chequeo automático de guerras de gremios vencidas, para cerrarlas aunque nadie use .guerra estado
            if (!global.__wolfricGuerraTimer) {
                global.__wolfricGuerraTimer = setInterval(async () => {
                    try {
                        for (const guerra of guerrasGremios.values()) {
                            if (!guerra.finalizada && Date.now() >= guerra.fin) {
                                await finalizarGuerraSiCorresponde(global.wolfricSock, guerra)
                            }
                        }
                    } catch (e) { console.log('[WOLFRIC] Error chequeando guerras de gremios:', e.message || e) }
                }, 10 * 60 * 1000) // chequea cada 10 minutos
                logWolfric('SYS', 'Chequeo automático de guerra de gremios activo')
            }

            if (createPanel && !global.__wolfricPanelStarted) {
                global.__wolfricPanelStarted = true
                try {
                    createPanel({
                        getBotOn: () => botOn,
                        setBotOn: (v) => { botOn = !!v },
                        getPrivado: () => modoPrivado,
                        setPrivado: (v) => { modoPrivado = !!v },
                        getConfig: () => botConfig,
                        setConfig: (c) => { botConfig = c; guardarBotConfig() },
                        getEconomia: () => economia,
                        getGremios: () => gremios,
                        reloadEconomia: () => cargarEconomia(),
                        getUsoStats: () => usoStats,
                        getAdminLog: () => { try { return fs.existsSync(ADMIN_LOG_FILE) ? JSON.parse(fs.readFileSync(ADMIN_LOG_FILE, 'utf8')) : [] } catch (e) { return [] } },
                        getReportes: () => reportes,
                        mutateEconomia: (j) => {
                            const q = String(j.id || '').trim().toLowerCase()
                            if (!q) return { error: 'Falta ID de jugador' }
                            const key = Object.keys(economia).find(k => k.toLowerCase().includes(q) || k.split('@')[0].toLowerCase() === q)
                            if (!key) return { error: 'Jugador no encontrado' }
                            const user = getUsuario(key)
                            if (j.action === 'coins') {
                                const amount = Number(j.amount || 0)
                                if (!amount) return { error: 'Cantidad inválida' }
                                user.coins = Math.max(0, (user.coins || 0) + amount)
                                if (amount > 0) user.lifetimeCoinsEarned = (user.lifetimeCoinsEarned || 0) + amount
                                guardarEconomia()
                                return { ok: `Coins de ${key.split('@')[0]} → ${user.coins} (${amount >= 0 ? '+' : ''}${amount})` }
                            }
                            if (j.action === 'item') {
                                const name = String(j.name || '').trim()
                                const qty = Math.max(1, Number(j.qty || 1))
                                if (!name) return { error: 'Falta nombre de ítem' }
                                if (!Array.isArray(user.inventory)) user.inventory = []
                                for (let i = 0; i < qty; i++) user.inventory.push(name)
                                guardarEconomia()
                                return { ok: `+${qty} x ${name} a ${key.split('@')[0]}` }
                            }
                            if (j.action === 'set') {
                                const field = String(j.field || '')
                                const allowed = ['coins','level','exp','bounty','gems','hp','energy']
                                if (!allowed.includes(field)) return { error: 'Campo no permitido' }
                                user[field] = Math.max(0, Number(j.value || 0))
                                guardarEconomia()
                                return { ok: `${field} de ${key.split('@')[0]} → ${user[field]}` }
                            }
                            return { error: 'Acción desconocida' }
                        },
                        log: logWolfric
                    })
                } catch (e) {
                    logWolfric('ERROR', 'No se pudo iniciar panel web: ' + (e.message || e))
                }
            }
            // Backup automatico de economia
            if (!global.__wolfricBackupTimer) {
                const horas = Math.max(1, Number(botConfig.backupHoras) || 6)
                backupEconomiaAhora()
                global.__wolfricBackupTimer = setInterval(() => backupEconomiaAhora(), horas * 60 * 60 * 1000)
                logWolfric('SYS', `Backup economia cada ${horas}h → ./backups/`)
            }
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut
            logWolfric('ERROR', 'Conexión cerrada. Código: ' + statusCode)
            if (shouldReconnect) {
                // Backoff exponencial con jitter: reconectar en loop rápido (ej. cada 5s fijo si la red
                // anda mal) es un patrón que WhatsApp puede leer como actividad sospechosa. Cada intento
                // fallido seguido espera más, hasta un tope de 2 minutos, y se resetea al conectar bien.
                global.__wolfricIntentosReconexion = (global.__wolfricIntentosReconexion || 0) + 1
                const base = Math.min(5 * Math.pow(2, global.__wolfricIntentosReconexion - 1), 120)
                const esperaSeg = base + Math.random() * 3
                logWolfric('WARN', `Reintentando en ${esperaSeg.toFixed(1)}s (intento #${global.__wolfricIntentosReconexion})...`)
                setTimeout(() => startBot(), esperaSeg * 1000)
            } else {
                logWolfric('ERROR', 'Sesión cerrada (401). Borra ./sesion y vuelve a vincular.')
            }
        }
    })


    // Bienvenida al entrar al grupo
    // Registro de entradas recientes por grupo, para detectar ráfagas (posible raid/spam de cuentas)
    const antiraidJoins = new Map() // gid -> [timestamps]
    const antiraidUltimaAlerta = new Map() // gid -> timestamp (evita re-alertar en cada entrada de la misma ráfaga)

    sock.ev.on('group-participants.update', async (update) => {
        try {
            if (!update || !update.id || !String(update.id).endsWith('@g.us')) return
            const gid = update.id
            const gcfg = getGrupoCfg(gid)
            const action = update.action
            for (const rawParticipant of (update.participants || [])) {
                // En algunas versiones/forks de Baileys, cada participante viene como
                // string ('549...@s.whatsapp.net') y en otras como objeto ({ id: '...' }).
                // Sin este chequeo, "jid" terminaba siendo un Object y rompía sendMessage
                // (el error "Received an instance of Object" que tapaba la consola).
                const jid = typeof rawParticipant === 'string' ? rawParticipant : (rawParticipant?.id || rawParticipant?.jid || '')
                if (!jid) continue
                const tag = '@' + String(jid).split('@')[0]
                if (action === 'add' && gcfg.antiraid) {
                    const ahora = Date.now()
                    const ventanaMs = gcfg.antiraidVentanaSeg * 1000
                    const historial = (antiraidJoins.get(gid) || []).filter(t0 => ahora - t0 < ventanaMs)
                    historial.push(ahora)
                    antiraidJoins.set(gid, historial)
                    const ultimaAlertaTs = antiraidUltimaAlerta.get(gid) || 0
                    if (historial.length >= gcfg.antiraidUmbral && ahora - ultimaAlertaTs > ventanaMs) {
                        antiraidUltimaAlerta.set(gid, ahora)
                        let extra = ''
                        if (gcfg.antiraidAccion === 'cerrar') {
                            try { await sock.groupRevokeInvite(gid); extra = '\n🔒 Link de invitación revocado como precaución.' } catch (e) {}
                        }
                        try {
                            await sock.sendMessage(gid, { text: tr(obtenerIdioma(from), `🚨 *Posible raid detectado*\n\n${historial.length} entradas en los últimos ${gcfg.antiraidVentanaSeg}s.${extra}\n\nAvisá a los admins y revisen quién entró recién. Ajustable con *${prefix}antiraid*.`, `🚨 *Possível raid detectado*\n\n${historial.length} entradas nos últimos ${gcfg.antiraidVentanaSeg}s.${extra}\n\nAvisa os admins e vejam quem acabou de entrar. Ajustável com *${prefix}antiraid*.`, `🚨 *Possible raid detected*\n\n${historial.length} joins in the last ${gcfg.antiraidVentanaSeg}s.${extra}\n\nTell the admins and check who just joined. Adjustable with *${prefix}antiraid*.`) })
                        } catch (e) {}
                    }
                }
                if (action === 'add' && gcfg.welcome !== false && botConfig.welcomeOn !== false) {
                    let texto = gcfg.welcomeText
                        ? gcfg.welcomeText.replace(/@user/gi, tag).replace(/\{user\}/gi, tag)
                        : (obtenerIdioma(gid, jid) === 'pt'
                            ? `🐺 *Bem-vindo(a) ao Wolfric* ${tag}\n\nEste grupo é território do Protocolo.\nEscreva *.register* para se registrar e *.menu* para ver as rotas.\n\nRespeite as regras: sem links se o anti-link estiver ativo.`
                            : `🐺 *Bienvenido/a a Wolfric* ${tag}\n\nEste grupo es territorio del Protocolo.\nEscribí *.register* para registrarte y *.menu* para ver las rutas.\n\nRespetá las reglas: sin links si el anti-link está activo.`)
                    if (botConfig.welcomeMsg && !gcfg.welcomeText) texto += `\n\n${botConfig.welcomeMsg}`
                    const buttons = [{ text: 'Menú', id: 'menu' }]
                    if (botConfig.channelUrl) buttons.push({ text: 'Canal', url: botConfig.channelUrl })
                    try {
                        await sock.sendMessage(gid, { text: texto, footer: botConfig.botName || 'Wolfric', buttons, mentions: [jid] })
                    } catch (e) {
                        await sock.sendMessage(gid, { text: texto, mentions: [jid] })
                    }
                }
                if (action === 'remove' && gcfg.goodbye) {
                    const texto = gcfg.goodbyeText
                        ? gcfg.goodbyeText.replace(/@user/gi, tag).replace(/\{user\}/gi, tag)
                        : (obtenerIdioma(gid, jid) === 'pt'
                            ? `🚪 ${tag} saiu do grupo.\nO Protocolo toma nota.`
                            : `🚪 ${tag} abandonó el grupo.\nEl Protocolo toma nota.`)
                    try { await sock.sendMessage(gid, { text: texto, mentions: [jid] }) } catch (_) {}
                }
            }
        } catch (e) {
            console.log('welcome error:', e.message || e)
        }
    })


    // Rechaza llamadas entrantes automáticamente si .anticall está activado (global, todo el bot)
    sock.ev.on('call', async (calls) => {
        if (!botConfig.anticall) return
        for (const call of calls) {
            try {
                if (call.status === 'offer') await sock.rejectCall(call.id, call.from)
            } catch (e) {}
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        let comandoOk = true
        const ctxReact = { from: null, m: null, command: null } // para poder reaccionar ✅/❌ desde el catch/finally (fuera del scope del try)
        try {
            // CRÍTICO: solo procesar mensajes NUEVOS reales. WhatsApp reenvía historial viejo
            // (type distinto a 'notify') cada vez que el bot se reconecta o resincroniza —
            // sin este filtro, el bot reprocesa comandos viejos de TODOS los chats como si
            // fueran nuevos, causando ráfagas de mensajes automáticos (esto fue lo que
            // disparó la suspensión: se reejecutaron .admin_overdrive_on viejos de ~20 chats).
            if (type !== 'notify') return

            const m = messages[0]
            if (!m.message) return
            ctxReact.m = m

            // ====== ANTIDELETE: detectar que alguien borró un mensaje (llega como protocolMessage tipo REVOKE) ======
            // Esto puede llegar más de 60s después del mensaje original, así que se chequea ANTES del filtro de antigüedad.
            if (m.message.protocolMessage && m.message.protocolMessage.type === 0) {
                try {
                    const chatId = m.key.remoteJid
                    const gcfgAd = getGrupoCfg(chatId)
                    if (gcfgAd.antidelete && chatId.endsWith('@g.us')) {
                        const keyBorrado = m.message.protocolMessage.key
                        const cacheKey = `${chatId}:${keyBorrado.id}`
                        const guardado = cacheAntidelete.get(cacheKey)
                        if (guardado) {
                            cacheAntidelete.delete(cacheKey)
                            const langAd = obtenerIdioma(chatId, null)
                            const etiqueta = tr(langAd, `🗑️ *Mensaje eliminado* de @${guardado.sender.split('@')[0]}:`, `🗑️ *Mensagem apagada* de @${guardado.sender.split('@')[0]}:`, `🗑️ *Deleted message* from @${guardado.sender.split('@')[0]}:`)
                            if (guardado.mediaBuffer) {
                                const contenidoMedia = { [guardado.mediaTipo]: guardado.mediaBuffer, caption: `${etiqueta}${guardado.texto ? '\n' + guardado.texto : ''}`, mentions: [guardado.sender] }
                                await sock.sendMessage(chatId, contenidoMedia)
                            } else if (guardado.texto) {
                                await sock.sendMessage(chatId, { text: `${etiqueta}\n${guardado.texto}`, mentions: [guardado.sender] })
                            }
                        }
                    }
                } catch (e) {}
                return
            }
            // IMPORTANTE: NO ignorar fromMe.
            // Si el número del bot y el tuyo son el mismo, tus mensajes llegan como fromMe
            // y igual deben procesarse (comandos, menú, respuestas de lista).

            // Segunda capa de seguridad: ignora cualquier mensaje con más de 60s de antigüedad
            const ahoraSeg = Math.floor(Date.now() / 1000)
            const tsMensaje = Number(m.messageTimestamp) || ahoraSeg
            if (ahoraSeg - tsMensaje > 60) return

            const from = m.key.remoteJid
            ctxReact.from = from
            // Texto normal + respuestas de botones / listas (fork itsliaaa)
            let body = m.message.conversation
                || m.message.extendedTextMessage?.text
                || m.message.imageMessage?.caption
                || ''
            const btnId = m.message.buttonsResponseMessage?.selectedButtonId
                || m.message.listResponseMessage?.singleSelectReply?.selectedRowId
                || m.message.templateButtonReplyMessage?.selectedId
                || m.message.buttonsResponseMessage?.selectedDisplayText
                || null
            if (btnId) {
                // rowId tipo "cmd_perfil" o ".perfil" o "perfil"
                const raw = String(btnId).replace(/^cmd_/, '').replace(/^\./, '')
                body = prefix + raw
            } else if (m.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
                try {
                    const j = JSON.parse(m.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)
                    if (j.id) body = prefix + String(j.id).replace(/^cmd_/, '').replace(/^\./, '')
                } catch (_) {}
            }
            // Se reconoce cualquiera de los prefijos permitidos (. ! # /), no solo el "oficial"
            // configurado — así nadie queda trabado si cambia el prefijo y no se acuerda cuál puso.
            const prefijoUsado = PREFIJOS_PERMITIDOS.find(p => body.startsWith(p)) || null
            const rawCmd = prefijoUsado ? body.slice(prefijoUsado.length).trim().split(' ')[0].toLowerCase() : ''
            let command = rawCmd.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            command = aplicarAliasComando(command)
            ctxReact.command = command
            const args = prefijoUsado ? body.slice(prefijoUsado.length).trim().split(' ').slice(1) : []
            const text = args.join(' ')
            const pushName = m.pushName || 'Alguien'
            const sender = m.key.participant || m.key.remoteJid
            const senderAlt = m.key.participantAlt || null
            if (from.endsWith('@g.us') && sender) {
                try {
                    const gcx = getGrupoCfg(from)
                    const k = String(sender)
                    gcx.msgCounts[k] = (gcx.msgCounts[k] || 0) + 1
                    gcx.lastSeen[k] = Date.now()
                    if (!gcx._lastSaveCounts || Date.now() - gcx._lastSaveCounts > 20000) {
                        gcx._lastSaveCounts = Date.now()
                        guardarGruposConfig()
                    }
                } catch (_) {}
            }
            const lang = obtenerIdioma(from, sender)
            // Quita espacios, saltos de línea y cualquier carácter invisible antes de comparar
            const normalizarJid = (jid) => (jid || '').toString().trim().replace(/[\u200B-\u200F\uFEFF]/g, '').split('@')[0].split(':')[0]

            // ====== ANTIDELETE (cachear) y VIEWONCE (revelar al instante) — solo si el grupo los tiene activados ======
            if (from.endsWith('@g.us')) {
                try {
                    const gcfgAdVo = getGrupoCfg(from)
                    const vo = m.message.viewOnceMessage?.message || m.message.viewOnceMessageV2?.message || m.message.viewOnceMessageV2Extension?.message
                    if (gcfgAdVo.viewonce && vo) {
                        const tipoVo = vo.imageMessage ? 'image' : vo.videoMessage ? 'video' : null
                        if (tipoVo) {
                            downloadMediaMessage(m, 'buffer', {}).then(async (buf) => {
                                const langVo = obtenerIdioma(from, sender)
                                const etiquetaVo = tr(langVo, `👁️ *Foto/video de una vista* de @${sender.split('@')[0]} (revelado):`, `👁️ *Foto/vídeo de visualização única* de @${sender.split('@')[0]} (revelado):`, `👁️ *View-once photo/video* from @${sender.split('@')[0]} (revealed):`)
                                await sock.sendMessage(from, { [tipoVo]: buf, caption: etiquetaVo, mentions: [sender] })
                            }).catch(() => {})
                        }
                    } else if (gcfgAdVo.antidelete && !m.key.fromMe) {
                        const textoCache = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || ''
                        const tipoMedia = m.message.imageMessage ? 'image' : m.message.videoMessage ? 'video' : m.message.audioMessage ? 'audio' : m.message.stickerMessage ? 'sticker' : null
                        if (tipoMedia) {
                            downloadMediaMessage(m, 'buffer', {}).then((buf) => {
                                cacheAntidelete.set(`${from}:${m.key.id}`, { sender, texto: textoCache, mediaBuffer: buf, mediaTipo: tipoMedia, ts: Date.now() })
                            }).catch(() => {})
                        } else if (textoCache) {
                            cacheAntidelete.set(`${from}:${m.key.id}`, { sender, texto: textoCache, mediaBuffer: null, mediaTipo: null, ts: Date.now() })
                        }
                    }
                } catch (e) {}
            }

            // ====== IDENTIFICACIÓN DE OWNER: EXCLUSIVAMENTE POR LID ======
            // No se usa participantAlt (JID/número real) para decidir si alguien es owner —
            // solo se acepta si alguno de los campos disponibles es un @lid.
            function obtenerLid(mensaje) {
                const candidatos = [mensaje.key.participant, mensaje.key.participantAlt, mensaje.key.remoteJid]
                for (const c of candidatos) {
                    if (c && c.endsWith('@lid')) return normalizarJid(c)
                }
                return null
            }
            const lidDetectado = obtenerLid(m)
            const isOwner = lidDetectado !== null && OWNERS.some(o => normalizarJid(o) === lidDetectado)

            // ====== LOG BONITO EN CONSOLA por cada comando reconocido (caja de color, estilo terminal) ======
            if (command) {
                const horaLog = new Date().toLocaleTimeString('es-AR', { hour12: false })
                const esGrupoLog = from.endsWith('@g.us')
                const numeroLog = normalizarJid(m.key.participant || sender)
                const AMARILLO = '\x1b[33m', CYAN = '\x1b[36m', AZUL = '\x1b[34m', VERDE = '\x1b[32m', BLANCO = '\x1b[37m', ROJO = '\x1b[31m', GRIS = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m', MAGENTA = '\x1b[35m'
                console.log(`\n${BOLD}${MAGENTA}╭━━━ ❬${RESET} ${BOLD}${CYAN}${horaLog}${RESET} ${BOLD}${MAGENTA}❭ ━━━ ✧${RESET}`)
                console.log(`${BOLD}${MAGENTA}┃${RESET} ${BOLD}${BLANCO}💬 Chat :${RESET} ${esGrupoLog ? `${BOLD}${CYAN}👥 Grupo${RESET}` : `${BOLD}${AZUL}👤 Privado${RESET}`}`)
                console.log(`${BOLD}${MAGENTA}┃${RESET} ${BOLD}${BLANCO}👤 User :${RESET} ${BOLD}${AMARILLO}${pushName}${RESET} ${BOLD}${VERDE}(+${numeroLog})${RESET}${isOwner ? ` ${BOLD}${ROJO}[👑 OWNER]${RESET}` : ''}`)
                console.log(`${BOLD}${MAGENTA}┃${RESET} ${BOLD}${BLANCO}🚀 Cmd  :${RESET} ${BOLD}${BLANCO}${body.substring(0, 60)}${RESET}`)
                console.log(`${BOLD}${MAGENTA}╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ✧${RESET}`)
            }

            // ====== RATE LIMIT: si alguien manda demasiados comandos seguidos, se ignora ======
            if (command && usuarioExcedioLimite(sender)) return

            // ====== APAGADO SOLO EN ESTE GRUPO: se chequea temprano para que el bot quede
            // realmente en silencio ahí (ni "necesitás perfil" ni nada), salvo para reactivarlo ======
            if (command && command !== 'on' && command !== 'off' && from.endsWith('@g.us')) {
                const gcfgTemprano = getGrupoCfg(from)
                if (gcfgTemprano.botOn === false) return
            }

            // ====== COMANDOS/CATEGORÍAS DESACTIVADAS EN ESTE GRUPO PUNTUALMENTE ======
            // (distinto de .off que apaga TODO — esto es para apagar solo una parte,
            // ej. casino en un grupo familiar, o descargas para ahorrar datos)
            if (command && from.endsWith('@g.us') && !['activar', 'desactivar', 'desactivados', 'on', 'off'].includes(command)) {
                const gcfgFeature = getGrupoCfg(from)
                if ((gcfgFeature.comandosDesactivados || []).includes(command)) {
                    return sendReply(sock, from, { text: tr(lang, `🚫 El comando *${prefix}${command}* está desactivado en este grupo. Un admin lo reactiva con *${prefix}activar ${command}*.`, `🚫 O comando *${prefix}${command}* está desativado neste grupo. Um admin religa com *${prefix}enable ${command}*.`, `🚫 El command *${prefix}${command}* is disabled in this group. An admin turns it back on with *${prefix}activar ${command}*.`) }, { quoted: m })
                }
            }

            // Contador global de comandos usados (título "Spammer Neón" — GDD V4.0 §5)
            if (command) { const _u = getUsuario(sender); _u.comandosUsados++ }

            // ====== REGISTRO OBLIGATORIO: los comandos de juego (Wolfric Protocol) requieren .crearperfil primero ======
            if (command && !command.startsWith('cat_') && !COMANDOS_SIN_REGISTRO.has(command) && !isOwner) {
                const _u = getUsuario(sender)
                if (!_u.registrado) {
                    return sendReply(sock, from, { text: tr(obtenerIdioma(from, sender), `🚫 Todavía no tenés perfil creado.\nUsa *${prefix}register* para empezar tu aventura en Wolfric Protocol (te regala una fruta, $300 y una mini guía).`, `🚫 Você ainda não tem perfil.\nUse *${prefix}register* para começar no Wolfric Protocol (ganha uma fruta, $300 e um guia rápido).`, `🚫 You still don't have a profile.\nUse *${prefix}register* to start your adventure in Wolfric Protocol (it gives you a fruit, $300 and a mini guide).`) }, { quoted: m })
                }
                regenerarHpTierra(_u)
                // Estar de viaje por mar bloquea las actividades "de tierra" (duelos, mazmorras, 2vs2)
                if (_u.marActual !== null && COMANDOS_REQUIEREN_TIERRA.has(command)) {
                    return sendReply(sock, from, { text: tr(obtenerIdioma(from, sender), `🌊 Estás de viaje en el mar, no podés hacer eso desde ahí.\nUsa *${prefix}islandhome* para volver antes.`, `🌊 Você está viajando no mar e não pode fazer isso daí.\nUse *${prefix}islandhome* para voltar.`, `🌊 You're traveling at sea, you can't do that from there.\nUse *${prefix}islandhome* to go back first.`) }, { quoted: m })
                }
            }

            // ====== WHOAMI: cualquiera puede ver su propio JID exacto (útil para configurar OWNER) ======

            if (command === 'whoami') {
                const lidMostrar = lidDetectado ? `${lidDetectado}@lid` : null
                const extraLid = lidMostrar
                    ? (lang === 'pt'
                        ? `\n\nLID (este é o que vai em OWNERS):\n${lidMostrar}`
                        : lang === 'en'
                        ? `\n\nLID (this is what goes in OWNERS):\n${lidMostrar}`
                        : `\n\nLID (esto es lo que va en OWNERS):\n${lidMostrar}`)
                    : (lang === 'pt'
                        ? '\n\nNão detectei um @lid neste chat. Escreva o comando de novo no privado do bot ou num grupo e veja o log.'
                        : lang === 'en'
                        ? '\n\nNo @lid was detected in this chat. Try the command again in the bot DM or a group and check the log.'
                        : '\n\nNo detecté un @lid en este chat. Probá el comando de nuevo en el privado del bot o en un grupo.')
                return sendReply(sock, from, { text: tr(lang,
                    `🆔 Tu identificador de este mensaje:\n\n${sender}${extraLid}\n\nLos OWNERS se configuran SOLO con el LID (@lid), no con el número.`,
                    `🆔 Seu identificador desta mensagem:\n\n${sender}${extraLid}\n\nOs OWNERS se configuram SÓ com o LID (@lid), não com o número.`,
                    `🆔 Your ID for this message:\n\n${sender}${extraLid}\n\nOWNERS are set ONLY with the LID (@lid), not the phone number.`) }, { quoted: m })
            }

            // ====== CONTROL DE ENCENDIDO / APAGADO GLOBAL (dueño, fuera de un grupo) / PRIVADO ======
            if (command === 'on' && isOwner && !from.endsWith('@g.us')) {
                botOn = true
                return sendReply(sock, from, { text: tr(lang, '✅ Bot encendido.', '✅ Bot ligado.', '✅ Bot is on.') }, { quoted: m })
            }
            if (command === 'off' && isOwner && !from.endsWith('@g.us')) {
                botOn = false
                return sendReply(sock, from, { text: tr(lang, '🔴 Bot apagado. Solo el dueño puede reactivarlo con .on', '🔴 Bot desligado. Só o dono pode religar com .on', '🔴 Bot is off. Only the owner can turn it back on con .on') }, { quoted: m })
            }
            if (command === 'private' && isOwner) {
                modoPrivado = true
                return sendReply(sock, from, { text: tr(lang, '🔒 Modo privado activado. Solo el dueño puede usar el bot.', '🔒 Modo privado ativado. Só o dono pode usar o bot.', '🔒 Private mode on. Only the owner can use the bot.') }, { quoted: m })
            }
            if (command === 'public' && isOwner) {
                modoPrivado = false
                return sendReply(sock, from, { text: tr(lang, '🔓 Modo público activado. Todos pueden usar el bot.', '🔓 Modo público ativado. Todos podem usar o bot.', '🔓 Public mode on. Everyone can use the bot.') }, { quoted: m })
            }

            if (!botOn) return
            if (modoPrivado && !isOwner) return

            const isGroup = from.endsWith('@g.us')
            let isAdmin = false
            let isBotAdmin = false

            if (isGroup) {
                try {
                    const groupMetadata = await obtenerGroupMetadataCache(sock, from)
                    const participants = groupMetadata.participants
                    const user = participants.find(p => normalizarJid(p.id) === normalizarJid(sender) || (lidDetectado && normalizarJid(p.id) === lidDetectado))
                    isAdmin = user?.admin === 'admin' || user?.admin === 'superadmin'
                    // Creador del bot: su LID vale como admin del grupo para comandos del bot,
                    // aunque en WhatsApp no sea admin real del chat.
                    if (isOwner) isAdmin = true

                    // Título "Dictador del Chat": ser admin del grupo y tener nivel 50+ (GDD V4.0 §5)
                    if (isAdmin) {
                        const uChequeo = getUsuario(sender)
                        if (uChequeo.level >= 50 && !uChequeo.fueAdminConNivel50) {
                            uChequeo.fueAdminConNivel50 = true
                            revisarTitulosAutomaticos(uChequeo, sender)
                            guardarEconomia()
                        }
                    }

                    const miNumero = normalizarJid(sock.user.lid || sock.user.id)
                    const bot = participants.find(p => normalizarJid(p.id) === miNumero)
                    isBotAdmin = bot?.admin === 'admin' || bot?.admin === 'superadmin'

                    if (command) {
                        // console.log('DEBUG GRUPO -> sock.user.id:', sock.user.id, '| sock.user.lid:', sock.user.lid)
                        // console.log('DEBUG GRUPO -> participantes:', participants.map(p => `${p.id} (${p.admin || 'miembro'})`))
                        // console.log('DEBUG GRUPO -> isBotAdmin:', isBotAdmin)
                    }
                } catch (e) {
                    console.log('Error obteniendo metadata del grupo:', e)
                }
                if (isOwner) isAdmin = true
            }

            if (isGroup && command && getGrupoCfg(from).adminOnly && !isAdmin && !['menu','help','groupinfo','gp','on','off'].includes(command)) {
                return sendReply(sock, from, { text: '🔒 Este grupo está en modo solo-admins.' }, { quoted: m })
            }

            // ====== ENCENDIDO/APAGADO SOLO EN ESTE GRUPO (mismo .on/.off, pero usado adentro de un grupo) ======
            if ((command === 'on' || command === 'off') && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins del grupo.', '❌ Apenas admins do grupo.', '❌ Group admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                if (command === 'off') {
                    gcfg.botOn = false
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: tr(lang, '🔴 Bot apagado en este grupo. Un admin puede reactivarlo con *.on*. El resto de tus grupos sigue funcionando normal.', '🔴 Bot desligado neste grupo. Um admin pode religar com *.on*. Os outros grupos seguem normais.', '🔴 Bot is off in this group. An admin can turn it back on with *.on*. Your other groups keep working as usual.') }, { quoted: m })
                }
                gcfg.botOn = true
                guardarGruposConfig()
                return sendReply(sock, from, { text: tr(lang, '✅ Bot reactivado en este grupo.', '✅ Bot reativado neste grupo.', '✅ Bot is back on in this group.') }, { quoted: m })
            }

            if (isGroup && body && !m.key.fromMe) {
                const gcfg = getGrupoCfg(from)
                if (Array.isArray(gcfg.blacklist) && gcfg.blacklist.includes(normalizarJid(sender)) && !isOwner) {
                    return
                }
                if (gcfg.antispam && !isAdmin && !isOwner && esSpam(from, sender)) {
                    try { await sock.sendMessage(from, { delete: m.key }) } catch (_) {}
                    await sendReply(sock, from, { text: tr(lang, '🚫 Anti-spam: no inundés el chat.', '🚫 Anti-spam: não flooda o chat.', '🚫 Anti-spam: no flood the chat.') }, { quoted: m })
                    return
                }
                if (gcfg.antispam && !isAdmin && !isOwner && body) {
                    const fk = from + '|rep|' + normalizarJid(sender)
                    const prev = spamTracker.get(fk)
                    if (prev && prev.msg === body && Date.now() - prev.t < 20000) {
                        prev.n = (prev.n || 1) + 1
                        prev.t = Date.now()
                        if (prev.n >= 3) {
                            try { await sock.sendMessage(from, { delete: m.key }) } catch (_) {}
                            await sendReply(sock, from, { text: tr(lang, '🚫 Anti-flood: no repitas el mismo mensaje.', '🚫 Anti-flood: não repita a mesma mensagem.', '🚫 Anti-flood: no repeat the same message.') }, { quoted: m })
                            return
                        }
                    } else spamTracker.set(fk, { msg: body, t: Date.now(), n: 1 })
                }
                if (gcfg.antilink && !isAdmin && !isOwner) {
                    const linkRe = /(https?:\/\/|www\.|chat\.whatsapp\.com|wa\.me\/)/i
                    if (linkRe.test(body)) {
                        try { await sock.sendMessage(from, { delete: m.key }) } catch (_) {}
                        if (!gcfg.linkWarns) gcfg.linkWarns = {}
                        const kid = normalizarJid(sender)
                        gcfg.linkWarns[kid] = (gcfg.linkWarns[kid] || 0) + 1
                        const n = gcfg.linkWarns[kid]
                        guardarGruposConfig()
                        let extra = ''
                        if (n > 15) {
                            try {
                                await sock.groupParticipantsUpdate(from, [sender], 'remove')
                                invalidarGroupMetadataCache(from)
                                extra = '\n👢 Superó 15 advertencias por links y fue *baneado* del grupo.'
                                gcfg.linkWarns[kid] = 0
                                guardarGruposConfig()
                            } catch (e) {
                                extra = '\n⚠️ Llegó a ' + n + ' warns. No pude expulsarlo: hacé admin al bot.'
                            }
                        }
                        await sendReply(sock, from, { text: tr(lang, `🔗 Link detectado y borrado.\n⚠️ Advertencia *${n}/15* por links.${extra}`, `🔗 Link detectado e apagado.\n⚠️ Aviso *${n}/15* por links.${extra}`, `🔗 Link detected and deleted.\n⚠️ Warning *${n}/15* for links.${extra}`) }, { quoted: m })
                        return
                    }
                }

                // ====== LOG PARA .resumen (siempre activo, liviano, solo en memoria) ======
                if (!prefijoUsado && body && body.trim().length > 1 && !m.key.fromMe) {
                    registrarMensajeGrupo(from, sender.split('@')[0], body.trim().slice(0, 300))
                }

                // ====== MODO CHAT IA (Gemini) — el bot responde como un miembro más del grupo ======
                if (gcfg.iaChat && !prefijoUsado && body && body.trim().length > 1 && !m.key.fromMe) {
                    manejarIaChat(sock, from, sender, body, m).catch(e => console.log('[WOLFRIC] Error en modo chat IA:', e.message || e))
                }

                // ====== ANTI-PELEAS (IA) — avisa sin aplicar strike/warn real ======
                if (gcfg.antipeleas && !prefijoUsado && body && body.trim().length > 1 && !m.key.fromMe) {
                    const citado = armarMensajeCitado(m)
                    const citadoJid = citado?.key?.participant || null
                    revisarConflicto(sock, from, sender, body, m, citadoJid, gcfg).catch(e => console.log('[WOLFRIC] Error en anti-peleas:', e.message || e))
                }
            }

            const getMentioned = () => m.message?.extendedTextMessage?.contextInfo?.mentionedJid || []

            // ====== APAGADO: si el grupo (o el bot entero) está apagado, no dispares NADA ambiental —
            // spawns de boss/monstruos no dependen de que alguien escriba un comando, así que necesitan
            // su propio chequeo acá (el de arriba solo frena comandos reconocidos). ======
            const grupoApagadoAmbiental = isGroup && getGrupoCfg(from).botOn === false

            // ====== BOSS GLOBAL: SPAWN ALEATORIO (GDD V4.0 §6.1) ======
            // X% de chance de que aparezca un Boss cada vez que alguien envía un mensaje al grupo (configurable con .admin_event_control boss_spawn_chance)
            if (isGroup && !grupoApagadoAmbiental && !bosses.has(from) && Math.random() * 100 < bossSpawnChancePct) {
                const ultimoSpawn = ultimoBossPorGrupo.get(from) || 0
                if (Date.now() - ultimoSpawn >= bossCooldownMs) {
                    let miembros = 0
                    try { miembros = (await obtenerGroupMetadataCache(sock, from)).participants.length } catch (e) {}
                    const boss = spawnearBoss(from, miembros)
                    ultimoBossPorGrupo.set(from, Date.now())
                    await sendReply(sock, from, { text: tr(lang, `🌑💀⛓️ *¡EL ${boss.nombre.toUpperCase()} HA APARECIDO!* ⛓️💀🌑\n\nLa actividad de la red atrajo a un virus masivo.\n❤️ HP: ${boss.hp}\n\nUsen *${prefix}attackboss* o *${prefix}skillboss* para combatirlo. ¡Tienen 45 minutos antes de que huya!`, `🌑💀⛓️ *O ${boss.nombre.toUpperCase()} APARECEU!* ⛓️💀🌑\n\nA atividade da rede atraiu um vírus massivo.\n❤️ HP: ${boss.hp}\n\nUsem *${prefix}attackboss* ou *${prefix}skillboss*. Vocês têm 45 minutos antes dele fugir!`, `🌑💀⛓️ *EL ${boss.nombre.toUpperCase()} HAS APPEARED!* ⛓️💀🌑\n\nNetwork activity pulled in a massive virus.\n❤️ HP: ${boss.hp}\n\nUse *${prefix}attackboss* o *${prefix}skillboss* to fight it. You've got 45 minutes before it runs!`) })
                    narrarBossIA(sock, from, boss.nombre).catch(() => {})
                    if (botConfig.grupoAvisos && botConfig.grupoAvisos !== from) {
                        enviarAvisoGrupo(`🌑 *¡Boss avistado!* ${boss.nombre} apareció en otro grupo de la red (❤️ ${boss.hp} HP). Corran a ayudar si están cerca.`)
                    }
                }
            }

            // ====== FARMING: SPAWN ALEATORIO DE MONSTRUOS MENORES ======
            // Aparecen seguido, pero con cooldown para no saturar el chat de mensajes
            if (isGroup && !grupoApagadoAmbiental && !monstruosActivos.has(from)) {
                const ultimoMonstruo = ultimoMonstruoPorGrupo.get(from) || 0
                if (Date.now() - ultimoMonstruo >= MONSTRUO_COOLDOWN_MS && Math.random() * 100 < MONSTRUO_SPAWN_CHANCE_PCT) {
                    const nombre = NOMBRES_MONSTRUOS[Math.floor(Math.random() * NOMBRES_MONSTRUOS.length)]
                    monstruosActivos.set(from, { nombre, spawnedAt: Date.now() })
                    ultimoMonstruoPorGrupo.set(from, Date.now())
                    setTimeout(() => {
                        const m2 = monstruosActivos.get(from)
                        if (m2 && m2.spawnedAt && Date.now() - m2.spawnedAt >= MONSTRUO_EXPIRA_MS) monstruosActivos.delete(from)
                    }, MONSTRUO_EXPIRA_MS + 1000)
                    await sendReply(sock, from, { text: tr(lang, `${nombre} apareció cerca del chat...\n¡El primero en escribir *${prefix}cazar* se lleva $${MONSTRUO_RECOMPENSA}!`, `${nombre} apareceu perto do chat...\nO primeiro a escrever *${prefix}hunt* leva $${MONSTRUO_RECOMPENSA}!`, `${nombre} showed up near the chat...\nFirst one to type *${prefix}hunt* gets $${MONSTRUO_RECOMPENSA}!`) })
                }
            }


            // ====================== WOLFRIC FRONTIER: INTERFAZ Y EXPLORACIÓN ======================
            if (command === 'frontera') {
                return sendReply(sock, from, { text: frontierGuiaMovil(prefix, args.join(' '), lang) }, { quoted: m })
            }

            if (command === 'ayuda') {
                return sendReply(sock, from, { text: frontierAyudaMovil(prefix, args.join(' '), lang) }, { quoted: m })
            }

            if (command === 'registro') {
                return sendReply(sock, from, { text: lang === 'pt'
                    ? `${frontierTitulo('REGISTRO DE EXPLORADOR', 'A Arca Inicial aceita novos nomes.', '🪪')}\n\n${frontierPanel('PRIMEIRO PASSO', [`${prefix}register · receba sua carga inicial.`, `Depois abra ${prefix}start para escolher Guide ou Skills.`], '✦')}`
                    : lang === 'en'
                    ? `${frontierTitulo('EXPLORER REGISTRY', 'The Initial Ark takes new names.', '🪪')}\n\n${frontierPanel('FIRST STEP', [`${prefix}register · get your starter pack.`, `Then open ${prefix}start to pick Guide or Skills.`], '✦')}`
                    : `${frontierTitulo('REGISTRO DE EXPLORADOR', 'El Arca Inicial admite nuevos nombres.', '🪪')}\n\n${frontierPanel('PRIMER PASO', [`${prefix}register · recibe tu carga inicial.`, `Después abre ${prefix}start para elegir Guide o Skills.`], '✦')}` }, { quoted: m })
            }

            if (command === 'inicio') {
                const user = getUsuario(sender)
                const texto = frontierZonaInicial(user, prefix, args.join(' '), lang)
                guardarEconomia()
                return sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'guia') {
                const user = getUsuario(sender)
                frontierTutorialElegirRuta(user, 'guia')
                guardarEconomia()
                return sendReply(sock, from, { text: frontierGuiaInicial(prefix, args.join(' '), lang) }, { quoted: m })
            }

            if (command === 'habilidades') {
                const user = getUsuario(sender)
                frontierTutorialElegirRuta(user, 'habilidades')
                guardarEconomia()
                return sendReply(sock, from, { text: frontierZonaInicial(user, prefix, 'habilidades', lang) }, { quoted: m })
            }

            if (command === 'orientacion' || command === 'pordonde') {
                const user = getUsuario(sender)
                const recomendaciones = frontierOrientacionInicial(user, prefix, lang)
                return sendReply(sock, from, { text: lang === 'pt'
                    ? `${frontierTitulo('ORIENTAÇÃO DE ROTA', 'Recomendações conforme seu estado atual.', '🧭')}\n\n${frontierPanel('POR ONDE COMEÇAR', recomendaciones, '→')}\n\n${frontierPanel('CONSULTAS ÚTEIS', [`${prefix}guide · explicação completa`, `${prefix}profile · estado e localização`, `${prefix}frontiermissions · missões Frontier`], '📖')}`
                    : lang === 'en'
                    ? `${frontierTitulo('ROUTE ORIENTATION', 'Tips based on your current state.', '🧭')}\n\n${frontierPanel('WHERE TO START', recomendaciones, '→')}\n\n${frontierPanel('USEFUL LOOKUPS', [`${prefix}guide · full explanation`, `${prefix}profile · status and location`, `${prefix}frontiermissions · Frontier quests`], '📖')}`
                    : `${frontierTitulo('ORIENTACIÓN DE RUTA', 'Recomendaciones según tu estado actual.', '🧭')}\n\n${frontierPanel('POR DÓNDE EMPEZAR', recomendaciones, '→')}\n\n${frontierPanel('CONSULTAS ÚTILES', [`${prefix}guide · explicación completa`, `${prefix}profile · estado y ubicación`, `${prefix}frontiermissions · encargos Frontier`], '📖')}` }, { quoted: m })
            }

            if (command === 'perfil' || command === 'estado') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                frontierActualizarRango(user)
                const region = frontierRegion(f.regionActual) || REGIONES_FRONTIER[0]
                const arma = frontierArma(user)
                const artes = f.artesEquipadas.map(id => FRONTIER_ARTES.find(a => a.id === id)?.nombre || id).join(', ')
                const fruta = frutaEquipadaObj(user)
                const texto = lang === 'pt'
                    ? `${frontierTitulo('𝗣𝗘𝗥𝗙𝗜𝗟 𝗗𝗘 𝗘𝗫𝗣𝗟𝗢𝗥𝗔𝗗𝗢𝗥', f.alias || pushName, '🪪')}

${frontierPanel('𝗘𝗦𝗧𝗔𝗗𝗢 𝗣𝗘𝗦𝗦𝗢𝗔𝗟', [`🧭 Rank ${f.rango} · Nível ${user.level}`, `📍 ${region.icono} ${region.nombre}`, `❤️ HP ${user.hp}/${user.maxHp} · ⚡ ${user.energy}/${user.maxEnergy}`, `💰 Créditos $${user.coins} · 💀 Bounty $${user.bounty}`], '📡')}

${frontierPanel('𝗖𝗔𝗥𝗚𝗔 𝗔𝗧𝗜𝗩𝗔', [`🗡️ Arma: ${arma.nombre} · +${arma.atk} ATK`, `🍎 Fruta: ${fruta ? `${fruta.nombre} · ${fruta.categoria}` : 'sem equipar'}`, `✨ Arte: ${artes}`, `🗺️ Regiões: ${f.regionesDescubiertas.length}/${REGIONES_FRONTIER.length}`, `🔐 Cenários ativos: ${f.escenariosUnicos.filter(e => e.estado === 'activo').length}`], '🧩')}

${frontierPanel('𝗔𝗧𝗥𝗜𝗕𝗨𝗧𝗢𝗦', [`FUE ${user.stats.str} · DEF ${user.stats.def}`, `AGI ${user.stats.agi} · TEC/INT ${user.stats.int}`], '📊')}

Use *${prefix}combat* para ver ações ou *${prefix}map* para escolher uma região.`
                    : `${frontierTitulo('𝗣𝗘𝗥𝗙𝗜𝗟 𝗗𝗘 𝗘𝗫𝗣𝗟𝗢𝗥𝗔𝗗𝗢𝗥', f.alias || pushName, '🪪')}

${frontierPanel('𝗘𝗦𝗧𝗔𝗗𝗢 𝗣𝗘𝗥𝗦𝗢𝗡𝗔𝗟', [`🧭 Rango ${f.rango} · Nivel ${user.level}`, `📍 ${region.icono} ${region.nombre}`, `❤️ HP ${user.hp}/${user.maxHp} · ⚡ ${user.energy}/${user.maxEnergy}`, `💰 Créditos $${user.coins} · 💀 Bounty $${user.bounty}`], '📡')}

${frontierPanel('𝗖𝗔𝗥𝗚𝗔 𝗔𝗖𝗧𝗜𝗩𝗔', [`🗡️ Arma: ${arma.nombre} · +${arma.atk} ATK`, `🍎 Fruta: ${fruta ? `${fruta.nombre} · ${fruta.categoria}` : 'sin equipar'}`, `✨ Arte: ${artes}`, `🗺️ Regiones: ${f.regionesDescubiertas.length}/${REGIONES_FRONTIER.length}`, `🔐 Escenarios activos: ${f.escenariosUnicos.filter(e => e.estado === 'activo').length}`], '🧩')}

${frontierPanel('𝗔𝗧𝗥𝗜𝗕𝗨𝗧𝗢𝗦', [`FUE ${user.stats.str} · DEF ${user.stats.def}`, `AGI ${user.stats.agi} · TEC/INT ${user.stats.int}`], '📊')}

Usa *${prefix}combat* para consultar acciones o *${prefix}map* para elegir una región.`
                return sendReply(sock, from, { text: texto, mentions: [sender] }, { quoted: m })
            }

            if (command === 'combate' || command === 'loadout') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const fruta = frutaEquipadaObj(user)
                const arte = frontierArteEquipada(user)
                const estilo = ESTILOS_COMBATE.find(e => e.id === user.estiloEquipado)
                const arma = frontierArma(user)
                const frutaTexto = fruta ? `${fruta.nombre} · ${fruta.categoria}${fruta.despertada ? ' · 🌟 despertada' : ''}` : 'Ninguna equipada'
                const estiloTexto = estilo ? estilo.nombre : 'Sin estilo clásico'
                const texto = `${frontierTitulo('𝗖𝗔𝗥𝗚𝗔 𝗗𝗘 𝗖𝗢𝗠𝗕𝗔𝗧𝗘', 'Tu identidad se compone de varias capas', '⚔️')}

${frontierPanel('𝗘𝗤𝗨𝗜𝗣𝗔𝗠𝗜𝗘𝗡𝗧𝗢', [
    `👤 ${f.alias || pushName} · Nivel ${user.level} · Rango ${f.rango}`,
    `🍎 Fruta: ${frutaTexto}`,
    `🥋 Estilo: ${estiloTexto}`,
    `🗡️ Arma: ${arma.nombre} · +${arma.atk} ATK`,
    `✨ Arte activo: ${arte.nombre}`
], '🧩')}

${frontierPanel('𝗔𝗖𝗖𝗜𝗢𝗡𝗘𝗦 𝗗𝗜𝗦𝗣𝗢𝗡𝗜𝗕𝗟𝗘𝗦', [
    `⚔️ ${prefix}attack · golpe físico con el arma equipada`,
    `✨ ${prefix}arte · usa ${arte.nombre} (${frontierArteHabilidad(user).costo}⚡)`,
    `🍎 ${prefix}useskill · habilidad de fruta`,
    `🌟 ${prefix}ultimate · ultimate de fruta despertada`,
    `🛡️ ${prefix}defender · escudo para el próximo impacto`
], '🎯')}

${frontierPanel('𝗣𝗥𝗘𝗣𝗔𝗥𝗔𝗖𝗜𝗢́𝗡', [
    `${prefix}equiparfruta <nombre>`,
    `${prefix}equipararma <arma>`,
    `${prefix}equipararte <arte>`,
    `${prefix}equiparestilo <estilo>`
], '🛠️')}`
                return sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'mapa' || command === 'regiones') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                let texto = `${frontierTitulo(tr(lang, '𝗠𝗔𝗣𝗔 𝗗𝗘 𝗟𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗥𝗔', '𝗠𝗔𝗣𝗔 𝗗𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗜𝗥𝗔', '𝗠𝗔𝗣𝗔 𝗗𝗘 𝗟𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗥𝗔'), tr(lang, 'Las rutas se revelan con el progreso', 'As rotas aparecem com o progresso', 'Routes unlock as you progress'))}

`
                REGIONES_FRONTIER.forEach((region, index) => {
                    const descubierta = f.regionesDescubiertas.includes(region.id)
                    const actual = f.regionActual === region.id
                    const estado = actual ? tr(lang, '📍 ACTUAL', '📍 ATUAL', '📍 ACTUAL') : descubierta ? tr(lang, '✅ DESCUBIERTA', '✅ DESCOBERTA', '✅ DESCUBIERTA') : tr(lang, '🔒 BLOQUEADA', '🔒 BLOQUEADA', '🔒 BLOQUEADA')
                    texto += `${frontierPanel(`${estado} · ${index + 1}. ${region.nombre}`, [`${tr(lang, 'Nivel', 'Nível', 'Level')} ${region.nivelMin}-${region.nivelMax}`, descubierta ? lore(lang, region.descripcion) : tr(lang, 'Región no descubierta. Explora rutas cercanas.', 'Região não descoberta. Explore rotas próximas.', 'Region not discovered. Explore nearby routes.'), actual ? tr(lang, 'Tu posición actual.', 'Sua posição atual.', 'Your current position.') : ''], actual ? '✦' : descubierta ? '✓' : '·')}\n\n`
                })
                texto += frontierPanel(tr(lang, '𝗡𝗔𝗩𝗘𝗚𝗔𝗖𝗜𝗢́𝗡', '𝗡𝗔𝗩𝗘𝗚𝗔𝗖̧𝗔̃𝗢', '𝗡𝗔𝗩𝗘𝗚𝗔𝗖𝗜𝗢́𝗡'), [tr(lang, `Viajá con ${prefix}travel <nombre de región>.`, `Viaje com ${prefix}travel <nome da região>.`, `Travel with ${prefix}travel <region name>.`), tr(lang, `Explorá con ${prefix}explore <nombre de región>.`, `Explore com ${prefix}explore <nome da região>.`, `Explore with ${prefix}explore <region name>.`), tr(lang, 'Las regiones bloqueadas requieren nivel mínimo.', 'Regiões bloqueadas pedem nível mínimo.', 'Locked regions need a min level.')], '🧭')
                return sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if ((command === 'viajar' || command === 'ir') && text && isNaN(Number(args[0]))) {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const region = frontierRegion(text)
                if (!region) return sendReply(sock, from, { text: tr(lang, `❌ Región no reconocida. Usa *${prefix}map* para consultar los nombres válidos.`, `❌ Região não reconhecida. Use *${prefix}map* para ver os nomes válidos.`, `❌ Unknown region. Use *${prefix}map* to check valid names.`) }, { quoted: m })
                if (user.level < region.nivelMin) return sendReply(sock, from, { text: tr(lang, `🔒 *${region.nombre}* requiere nivel ${region.nivelMin}. Tu nivel actual es ${user.level}.`, `🔒 *${region.nombre}* exige nível ${region.nivelMin}. Seu nível atual é ${user.level}.`, `🔒 *${region.nombre}* needs level ${region.nivelMin}. Your current level is ${user.level}.`) }, { quoted: m })
                if (!f.regionesDescubiertas.includes(region.id) && region.id !== 'arca-inicial') return sendReply(sock, from, { text: tr(lang, `🧭 Todavía no has descubierto *${region.nombre}*. Explora las regiones que ya conoces para encontrar una ruta.`, `🧭 Você ainda não descobriu *${region.nombre}*. Explore as regiões que já conhece para achar uma rota.`, `🧭 You haven't discovered *${region.nombre}*. Explore regions you already know to find a route.`) }, { quoted: m })
                f.regionActual = region.id
                if (!f.regionesDescubiertas.includes(region.id)) f.regionesDescubiertas.push(region.id)
                guardarEconomia()
                return sendFrontierEvento(sock, from, 'transito', `${frontierTitulo(tr(lang, '𝗧𝗥𝗔𝗡𝗦𝗜𝗧𝗢 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗔𝗗𝗢', '𝗧𝗥𝗔𝗡𝗦𝗜𝗧𝗢 𝗖𝗢𝗡𝗖𝗟𝗨𝗜́𝗗𝗢', '𝗧𝗥𝗔𝗡𝗦𝗜𝗧 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘'), region.nombre, region.icono)}\n\n${frontierPanel(tr(lang, 'LLEGADA', 'CHEGADA', 'ARRIVAL'), [lore(lang, region.descripcion), tr(lang, `Siguiente paso: ${prefix}explore ${region.nombre}`, `Próximo passo: ${prefix}explore ${region.nombre}`, `Next step: ${prefix}explore ${region.nombre}`)], '🧭')}`, { quoted: m })
            }

            if (command === 'subzonas') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const region = frontierRegion(text) || REGIONES_FRONTIER.find(r => r.id === f.regionActual)
                if (!region) return sendReply(sock, from, { text: tr(lang, `❌ Región no reconocida. Usa *${prefix}map*.`, `❌ Região não reconhecida. Use *${prefix}map*.`, `❌ Unknown region. Use *${prefix}map*.`) }, { quoted: m })
                const conocidas = f.subzonasDescubiertas[region.id] || []
                const lista = (FRONTIER_SUBZONAS[region.id] || []).map(s => `${conocidas.includes(s.id) ? '◆' : '◇'} *${s.nombre}*\n   ${conocidas.includes(s.id) ? s.desc : 'Coordenadas todavía no registradas.'}`).join('\n\n') || 'Esta región todavía no tiene subzonas registradas.'
                return sendReply(sock, from, { text: `${frontierTitulo('𝗦𝗨𝗕𝗭𝗢𝗡𝗔𝗦 𝗗𝗘 𝗥𝗨𝗧𝗔', region.nombre, '📍')}\n\n${lista}\n\n${tr(lang, `Explora *${prefix}explore ${region.nombre}* para descubrir nuevas coordenadas.`, `Explore *${prefix}explore ${region.nombre}* para descobrir novas coordenadas.`, `Explore *${prefix}explore ${region.nombre}* to discover new coordinates.`)}` }, { quoted: m })
            }

            if (command === 'elites') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const lista = FRONTIER_ELITES.map(elite => `${f.elitesDerrotadas.includes(elite.id) ? '✅' : user.level >= elite.nivelMin ? '⚠️' : '🔒'} *${elite.nombre}* · ${REGIONES_FRONTIER.find(r => r.id === elite.region)?.nombre || elite.region}\n   Nvl. ${elite.nivel} · ${elite.material} · ${elite.itemDrop}`).join('\n\n')
                return sendReply(sock, from, { text: `${frontierTitulo('𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢 𝗗𝗘 𝗘́𝗟𝗜𝗧𝗘𝗦', 'Firmas hostiles fuera del patrón', '🚨')}\n\n${lista}\n\n${tr(lang, 'Las élites aparecen durante la exploración. Cada victoria registra prestigio, Bounty y un objeto especial.', 'As elites aparecem na exploração. Cada vitória registra prestígio, Bounty e um item especial.', 'Elites show up while exploring. Each win logs prestige, Bounty and a special item.')}` }, { quoted: m })
            }

            if (command === 'explorar' && text && isNaN(Number(args[0])) && !['boss'].includes(frontierNormalizar(args[0]))) {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const region = frontierRegion(text)
                if (!region) return sendReply(sock, from, { text: tr(lang, `❌ No conozco esa región. Usa *${prefix}map*.`, `❌ Não conheço essa região. Use *${prefix}map*.`, `❌ I don't know that region. Use *${prefix}map*.`) }, { quoted: m })
                if (user.level < region.nivelMin) return sendReply(sock, from, { text: tr(lang, `🔒 *${region.nombre}* requiere nivel ${region.nivelMin}.`, `🔒 *${region.nombre}* exige nível ${region.nivelMin}.`, `🔒 *${region.nombre}* needs level ${region.nivelMin}.`) }, { quoted: m })
                if (!f.regionesDescubiertas.includes(region.id)) return sendReply(sock, from, { text: tr(lang, `🧭 Primero debes descubrir *${region.nombre}*. Usa *${prefix}explorar ${REGIONES_FRONTIER.find(r => f.regionesDescubiertas.includes(r.id))?.nombre || 'Arca Inicial'}* para comenzar.`, `🧭 Primeiro você precisa descobrir *${region.nombre}*. Use *${prefix}explore ${REGIONES_FRONTIER.find(r => f.regionesDescubiertas.includes(r.id))?.nombre || 'Arca Inicial'}* para começar.`, `🧭 Primero debes descubrir *${region.nombre}*. Use *${prefix}explorer ${REGIONES_FRONTIER.find(r => f.regionesDescubiertas.includes(r.id))?.nombre || 'Arca Inicial'}* para comenzar.`) }, { quoted: m })
                f.regionActual = region.id
                const existente = encuentrosFrontierActivos.get(from)
                if (existente) return sendReply(sock, from, { text: frontierDescripcionEncuentro(existente, lang) }, { quoted: m })
                f.exploraciones[region.id] = (f.exploraciones[region.id] || 0) + 1

                const roll = Math.random()
                let texto = `${frontierTitulo('𝗘𝗫𝗣𝗟𝗢𝗥𝗔𝗖𝗜𝗢́𝗡', region.nombre)}\n\n`
                if (roll < 0.50) {
                    const base = frontierElegirMonstruo(region.id, user)
                    const subzona = frontierElegirSubzona(user, region.id)
                    const encuentro = { regionId: region.id, subzona, monster: { ...base, hpMax: base.hp }, spawnedAt: Date.now() }
                    encuentrosFrontierActivos.set(from, encuentro)
                    setTimeout(() => {
                        const actual = encuentrosFrontierActivos.get(from)
                        if (actual && actual.spawnedAt === encuentro.spawnedAt) encuentrosFrontierActivos.delete(from)
                    }, 5 * 60 * 1000)
                    texto += `${tr(lang, '⚠️ Una señal hostil aparece entre los datos.', '⚠️ Um sinal hostil aparece entre os dados.', '⚠️ A hostile signal pops up in the data.')}\n\n${frontierDescripcionEncuentro(encuentro, lang)}`
                } else if (roll < 0.75) {
                    const candidatosMaterial = FRONTIER_MONSTRUOS.filter(monstruo => monstruo.region === region.id)
                    const fuenteMaterial = candidatosMaterial.length ? candidatosMaterial[Math.floor(Math.random() * candidatosMaterial.length)] : FRONTIER_MONSTRUOS[0]
                    const materialId = fuenteMaterial.drop
                    const monstruoMaterial = FRONTIER_MONSTRUOS.find(monstruo => monstruo.drop === materialId)
                    const cantidad = Math.floor(Math.random() * 3) + 1
                    f.materiales[materialId] = (f.materiales[materialId] || 0) + cantidad
                    f.reputacion[region.id] = (f.reputacion[region.id] || 0) + 1
                    texto += `📦 Has encontrado *${cantidad}x ${monstruoMaterial?.material || materialId}*.\n\nReputación regional: +1`
                } else if (roll < 0.90) {
                    const nuevaPista = frontierPistaInicial(user)
                    if (nuevaPista) texto += `🔐 *ANOMALÍA DE INFORMACIÓN*\n\nHas encontrado una señal que no aparece en el mapa normal.\n\nNueva pista: revisa *${prefix}pistas*.\nNuevo contenido: *${prefix}escenarios*.`
                    else texto += `🛰️ Encuentras una señal repetida. El Archivo de la Frontera no detecta información nueva.`
                } else {
                    const evento = frontierEventoRegional(region.id)
                    const premio = evento?.coins || (Math.floor(Math.random() * 90) + 60)
                    const expEvento = evento?.exp || 12
                    user.coins += premio
                    user.lifetimeCoinsEarned += premio
                    const nivelesSubidos = frontierDarExp(user, expEvento)
                    const regionNueva = frontierIntentarDesbloqueo(user)
                    const repEvento = evento?.rep || 3
                    f.reputacion[region.id] = (f.reputacion[region.id] || 0) + repEvento
                    if (evento) { f.eventosFrontier.push(evento.id); if (evento.item) user.inventory.push(evento.item) }
                    texto += `✨ *${evento?.nombre || 'Evento favorable'}* altera la ruta.\n\n${evento?.desc || 'La señal abre una oportunidad breve.'}\n💰 +$${premio} · ✨ +${expEvento} EXP · Reputación regional +${repEvento}${evento?.item ? `\n🎒 Objeto obtenido: *${evento.item}*.` : ''}${nivelesSubidos ? `\n⬆️ Subiste ${nivelesSubidos} nivel(es).` : ''}${regionNueva ? `\n🗺️ Nueva región descubierta: *${regionNueva.nombre}*.` : ''}`
                }
                frontierActualizarRango(user)
                guardarEconomia()
                if (roll >= 0.75) return sendFrontierEvento(sock, from, 'descubrimiento', texto, { quoted: m })
                return sendReply(sock, from, { text: texto }, { quoted: m })
            }



            // ====================== WOLFRIC FRONTIER: NPCs, MISIONES Y CIERRE DE TEMPORADA ======================
            if (command === 'npc' || command === 'hablarnpc') {
                const user = getUsuario(sender); const f = frontierInicializar(user, pushName)
                if (command === 'npc' && !text.trim()) {
                    const lista = FRONTIER_NPCS.map(n => `${f.npcsConocidos.includes(n.id) ? '✅' : '🔒'} *${n.nombre}* · ${lore(lang, n.rol)}\n   📍 ${n.region} · ${tr(lang,'Nvl.','Nív.','Lv.')} ${n.nivelMin}`).join('\n\n')
                    return sendReply(sock, from, { text: `${frontierTitulo(tr(lang, '𝗡𝗣𝗖𝗦 𝗗𝗘 𝗟𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗥𝗔', '𝗡𝗣𝗖𝗦 𝗗𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗜𝗥𝗔', '𝗙𝗥𝗢𝗡𝗧𝗜𝗘𝗥 𝗡𝗣𝗖𝗦'), tr(lang, 'Personajes, encargos y reputación', 'Personagens, missões e reputação', 'Characters, quests and reputation'), '👥')}\n\n${lista}\n\n${tr(lang, `Habla con *${prefix}talknpc <nombre>* para conocer sus encargos.`, `Fale com *${prefix}talknpc <nome>* para ver as missões.`, `Talk with *${prefix}talknpc <name>* to hear their quests.`)}` }, { quoted: m })
                }
                const npc = frontierNpc(text); if (!npc) return sendReply(sock, from, { text: tr(lang, `❌ NPC no reconocido. Usa *${prefix}npc*.`, `❌ NPC não reconhecido. Use *${prefix}npc*.`, `❌ Unknown NPC. Use *${prefix}npc*.`) }, { quoted: m })
                if (user.level < npc.nivelMin) return sendReply(sock, from, { text: tr(lang, `🔒 *${npc.nombre}* requiere nivel ${npc.nivelMin}.`, `🔒 *${npc.nombre}* exige nível ${npc.nivelMin}.`, `🔒 *${npc.nombre}* needs level ${npc.nivelMin}.`) }, { quoted: m })
                if (!f.npcsConocidos.includes(npc.id)) f.npcsConocidos.push(npc.id)
                const rep = f.reputacion[npc.region] || 0
                const misiones = FRONTIER_MISIONES.filter(x => x.npc === npc.id).map(x => `• ${x.id}: ${lore(lang, x.nombre)} · ${tr(lang,'reputación mínima','reputação mínima','min reputation')} ${x.repMin}`).join('\n') || lore(lang, 'No tiene encargos disponibles.')
                guardarEconomia()
                return sendReply(sock, from, { text: `${frontierTitulo(tr(lang, '𝗖𝗢𝗡𝗩𝗘𝗥𝗦𝗔𝗖𝗜𝗢́𝗡', '𝗖𝗢𝗡𝗩𝗘𝗥𝗦𝗔', '𝗖𝗢𝗡𝗩𝗘𝗥𝗦𝗔𝗧𝗜𝗢𝗡'), npc.nombre, '💬')}\n\n${frontierPanel(tr(lang, '𝗣𝗘𝗥𝗙𝗜𝗟', '𝗣𝗘𝗥𝗙𝗜𝗟', '𝗣𝗘𝗥𝗙𝗜𝗟'), [`${lore(lang, npc.rol)}`, tr(lang, `📍 Región: ${npc.region}`, `📍 Região: ${npc.region}`, `📍 Region: ${npc.region}`), tr(lang, `🤝 Reputación: ${rep} · ${frontierReputacionNivel(rep)}`, `🤝 Reputação: ${rep} · ${frontierReputacionNivel(rep)}`, `🤝 Reputation: ${rep} · ${frontierReputacionNivel(rep)}`), lore(lang, npc.dialogo)], '👤')}\n\n${frontierPanel(tr(lang, '𝗘𝗡𝗖𝗔𝗥𝗚𝗢𝗦', '𝗠𝗜𝗦𝗦𝗢̃𝗘𝗦', '𝗤𝗨𝗘𝗦𝗧𝗦'), [misiones], '📜')}\n\n${tr(lang, `Usa *${prefix}acceptquest <id>* para comenzar un encargo.`, `Use *${prefix}acceptquest <id>* para aceitar uma missão.`, `Use *${prefix}acceptquest <id>* to start a quest.`)}` }, { quoted: m })
            }
            if (command === 'reputacion') {
                const user = getUsuario(sender); const f = frontierInicializar(user)
                const texto = REGIONES_FRONTIER.map(r => `${r.icono} *${r.nombre}* · ${f.reputacion[r.id] || 0} · ${frontierReputacionNivel(f.reputacion[r.id] || 0)}`).join('\n')
                return sendReply(sock, from, { text: tr(lang, `${frontierTitulo('𝗥𝗘𝗣𝗨𝗧𝗔𝗖𝗜𝗢́𝗡 𝗥𝗘𝗚𝗜𝗢𝗡𝗔𝗟', 'Cada región recuerda tus decisiones', '🤝')}\n\n${frontierPanel('𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢', texto.split('\n'), '🗺️')}`, `${frontierTitulo('𝗥𝗘𝗣𝗨𝗧𝗔𝗖𝗜𝗢́𝗡 𝗥𝗘𝗚𝗜𝗢𝗡𝗔𝗟', 'Cada región recuerda tus decisiones', '🤝')}\n\n${frontierPanel('𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢', texto.split('\n'), '🗺️')}`, `${frontierTitulo('𝗥𝗘𝗣𝗨𝗧𝗔𝗖𝗜𝗢́𝗡 𝗥𝗘𝗚𝗜𝗢𝗡𝗔𝗟', 'Cada región recuerda tus decisiones', '🤝')}\n\n${frontierPanel('𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢', texto.split('\n'), '🗺️')}`) }, { quoted: m })
            }
            if (command === 'misionesfrontier') {
                const user = getUsuario(sender); const f = frontierInicializar(user)
                const texto = FRONTIER_MISIONES.map(x => { const st = frontierEstadoMision(user, x); const p = frontierMisionProgreso(user, x); const meta = ['arma', 'guardian'].includes(x.requisito.tipo) ? 1 : x.requisito.cantidad; return `${st.reclamada ? '✅' : st.aceptada ? '⚔️' : '🔒'} *${x.id}* · ${lore(lang, x.nombre)}\n   ${lore(lang, x.desc)}\n   ${tr(lang,'Progreso','Progresso','Progress')}: ${Math.min(p, meta)}/${meta} · ${st.aceptada ? tr(lang,'activa','ativa','active') : tr(lang,'no aceptada','não aceita','not accepted')}` }).join('\n\n')
                return sendReply(sock, from, { text: `${frontierTitulo(tr(lang, '𝗠𝗜𝗦𝗜𝗢𝗡𝗘𝗦 𝗗𝗘 𝗙𝗥𝗢𝗡𝗧𝗜𝗘𝗥', '𝗠𝗜𝗦𝗦𝗢̃𝗘𝗦 𝗗𝗘 𝗙𝗥𝗢𝗡𝗧𝗜𝗘𝗥', '𝗙𝗥𝗢𝗡𝗧𝗜𝗘𝗥 𝗤𝗨𝗘𝗦𝗧𝗦'), tr(lang, 'Encargos permanentes de los NPCs', 'Missões permanentes dos NPCs', 'Permanent NPC quests'), '📜')}\n\n${texto}\n\n${tr(lang, `Aceptá con *${prefix}acceptquest <id>* y entregá con *${prefix}turninquest <id>*.`, `Aceite com *${prefix}acceptquest <id>* e entregue com *${prefix}turninquest <id>*.`, `Accept with *${prefix}acceptquest <id>* and turn in with *${prefix}turninquest <id>*.`)}`, }, { quoted: m })
            }
            if (command === 'aceptarmision' || command === 'entregarmision') {
                const user = getUsuario(sender); const mission = frontierMision(text)
                if (!mission) return sendReply(sock, from, { text: tr(lang, `❌ Misión no reconocida. Usa *${prefix}frontiermissions*.`, `❌ Missão não reconhecida. Use *${prefix}frontiermissions*.`, `❌ Unknown quest. Use *${prefix}frontiermissions*.`) }, { quoted: m })
                const resultado = command === 'aceptarmision' ? frontierAceptarMision(user, mission) : frontierReclamarMision(user, mission)
                if (resultado.ok) guardarEconomia()
                return sendReply(sock, from, { text: `${frontierTitulo(command === 'aceptarmision' ? tr(lang, '𝗠𝗜𝗦𝗜𝗢́𝗡 𝗔𝗖𝗘𝗣𝗧𝗔𝗗𝗔', '𝗠𝗜𝗦𝗦𝗔̃𝗢 𝗔𝗖𝗘𝗜𝗧𝗔', '𝗤𝗨𝗘𝗦𝗧 𝗔𝗖𝗖𝗘𝗣𝗧𝗘𝗗') : tr(lang, '𝗠𝗜𝗦𝗜𝗢́𝗡 𝗘𝗡𝗧𝗥𝗘𝗚𝗔𝗗𝗔', '𝗠𝗜𝗦𝗦𝗔̃𝗢 𝗘𝗡𝗧𝗥𝗘𝗚𝗨𝗘', '𝗤𝗨𝗘𝗦𝗧 𝗧𝗨𝗥𝗡𝗘𝗗 𝗜𝗡'), mission.nombre, '📜')}\n\n${resultado.texto}` }, { quoted: m })
            }
            if (command === 'recetas') {
                const user = getUsuario(sender); const f = frontierInicializar(user)
                const texto = FRONTIER_RECETAS.map(r => `${f.recetasDescubiertas.includes(r.id) ? '✅' : '🔒'} *${r.nombre}* · ${r.desc}\n   ${r.cantidad}x ${r.material} · $${r.costo} · reputación ${r.repMin}`).join('\n\n')
                return sendReply(sock, from, { text: `${frontierTitulo('𝗥𝗘𝗖𝗘𝗧𝗔𝗦 𝗔𝗩𝗔𝗡𝗭𝗔𝗗𝗔𝗦', 'Mejoras permanentes para tus armas', '🛠️')}\n\n${texto}\n\n${tr(lang, `Usa *${prefix}craft <receta>* cuando cumplas los requisitos.`, `Use *${prefix}craft <receita>* quando cumprir os requisitos.`, `Use *${prefix}craft <recipe>* when you meet the requirements.`)}` }, { quoted: m })
            }
            if (command === 'fabricar') {
                const user = getUsuario(sender); const recipe = frontierReceta(text)
                if (!recipe) return sendReply(sock, from, { text: tr(lang, `❌ Receta no reconocida. Usa *${prefix}recetas*.`, `❌ Receita não reconhecida. Use *${prefix}recipes*.`, `❌ Unknown recipe. Use *${prefix}recipes*.`) }, { quoted: m })
                const f = frontierInicializar(user)
                if (!f.recetasDescubiertas.includes(recipe.id)) return sendReply(sock, from, { text: tr(lang, '🔒 Todavía no conoces esa receta. Aumenta reputación y completa encargos.', '🔒 Você ainda não conhece essa receita. Suba reputação e complete missões.', `🔒 You don't know that recipe yet. Raise reputation and finish quests.`) }, { quoted: m })
                const resultado = frontierFabricar(user, recipe); if (resultado.ok) guardarEconomia()
                return sendReply(sock, from, { text: resultado.texto }, { quoted: m })
            }
            if (command === 'temporada' || command === 'mundofrontier') {
                const t = frontierMundo.temporada
                return sendReply(sock, from, { text: lang === 'pt'
                    ? `${frontierTitulo('𝗘𝗦𝗧𝗔𝗗𝗢 𝗗𝗢 𝗠𝗨𝗡𝗗𝗢', t.nombre, '🌐')}\n\n${frontierPanel('𝗧𝗘𝗠𝗣𝗢𝗥𝗔𝗗𝗔', [`Estado: ${t.estado}`, `Início: ${new Date(t.inicio).toLocaleDateString('pt-BR')}`, `Guardiões vencidos no geral: ${frontierMundo.estadisticas.guardianes}`, `Soberanos vencidos: ${frontierMundo.estadisticas.soberanos}`, `Ressonâncias concluídas: ${frontierMundo.estadisticas.resonancias}`], '⏳')}\n\n${frontierPanel('𝗖𝗢𝗡𝗦𝗘𝗤𝗨Ê𝗡𝗖𝗜𝗔𝗦', frontierMundo.consecuencias.length ? frontierMundo.consecuencias : ['O mundo ainda espera uma vitória que mude as rotas.'], '🧭')}`
                    : lang === 'en'
                    ? `${frontierTitulo('𝗪𝗢𝗥𝗟𝗗 𝗦𝗧𝗔𝗧𝗨𝗦', t.nombre, '🌐')}\n\n${frontierPanel('𝗦𝗘𝗔𝗦𝗢𝗡', [`Status: ${t.estado}`, `Start: ${new Date(t.inicio).toLocaleDateString('en-US')}`, `Guardians beaten worldwide: ${frontierMundo.estadisticas.guardianes}`, `Sovereigns beaten: ${frontierMundo.estadisticas.soberanos}`, `Resonances cleared: ${frontierMundo.estadisticas.resonancias}`], '⏳')}\n\n${frontierPanel('𝗙𝗔𝗟𝗟𝗢𝗨𝗧', frontierMundo.consecuencias.length ? frontierMundo.consecuencias : ['The world is still waiting for a win that changes its routes.'], '🧭')}`
                    : `${frontierTitulo('𝗘𝗦𝗧𝗔𝗗𝗢 𝗗𝗘𝗟 𝗠𝗨𝗡𝗗𝗢', t.nombre, '🌐')}\n\n${frontierPanel('𝗧𝗘𝗠𝗣𝗢𝗥𝗔𝗗𝗔', [`Estado: ${t.estado}`, `Inicio: ${new Date(t.inicio).toLocaleDateString('es-AR')}`, `Guardianes vencidos globalmente: ${frontierMundo.estadisticas.guardianes}`, `Soberanos vencidos: ${frontierMundo.estadisticas.soberanos}`, `Resonancias completadas: ${frontierMundo.estadisticas.resonancias}`], '⏳')}\n\n${frontierPanel('𝗖𝗢𝗡𝗦𝗘𝗖𝗨𝗘𝗡𝗖𝗜𝗔𝗦', frontierMundo.consecuencias.length ? frontierMundo.consecuencias : ['El mundo todavía espera una victoria que cambie sus rutas.'], '🧭')}` }, { quoted: m })
            }
            if (command === 'clasificacionfrontier') {
                const ranking = Object.entries(economia).map(([jid, user]) => ({ jid, user, puntos: frontierPrestigio(user) })).sort((a, b) => b.puntos - a.puntos).slice(0, 10)
                const filas = ranking.length ? ranking.map((x, i) => `${i + 1}. @${x.jid.split('@')[0]} · ${x.puntos} prestigio`) : [lang === 'pt' ? 'Ainda não tem exploradores registrados.' : lang === 'en' ? 'No explorers on the board yet.' : 'Todavía no hay exploradores registrados.']
                return sendReply(sock, from, { text: `${frontierTitulo(lang === 'pt' ? '𝗖𝗟𝗔𝗦𝗦𝗜𝗙𝗜𝗖𝗔𝗖̧𝗔̃𝗢' : lang === 'en' ? '𝗥𝗔𝗡𝗞𝗜𝗡𝗚' : '𝗖𝗟𝗔𝗦𝗜𝗙𝗜𝗖𝗔𝗖𝗜𝗢́𝗡', lang === 'pt' ? 'Prestígio acumulado da temporada' : lang === 'en' ? 'Season prestige so far' : 'Prestigio acumulado de la temporada', '🏆')}\n\n${frontierPanel('𝗧𝗢𝗣 𝟭𝟬', filas, '📊')}`, mentions: ranking.map(x => x.jid) }, { quoted: m })
            }

            // ====================== WOLFRIC FRONTIER: SEGUNDA RESONANCIA ======================
            if (command === 'resonancia') {
                const user = getUsuario(sender); const f = frontierInicializar(user); const estado = frontierEscenarioDos(user, false); const activo = frontierResonanciaActiva(from)
                const bloqueado = !frontierResonanciaDesbloqueada(user)
                const texto = bloqueado
                    ? frontierPanel(lang === 'pt' ? '𝗥𝗘𝗦𝗦𝗢𝗡𝗔̂𝗡𝗖𝗜𝗔 𝗕𝗟𝗢𝗤𝗨𝗘𝗔𝗗𝗔' : lang === 'en' ? '𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗘 𝗟𝗢𝗖𝗞𝗘𝗗' : '𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔 𝗕𝗟𝗢𝗤𝗨𝗘𝗔𝗗𝗔', [lang === 'pt' ? `Nível necessário: ${FRONTIER_RESONANCIA.nivel}` : lang === 'en' ? `Required level: ${FRONTIER_RESONANCIA.nivel}` : `Nivel requerido: ${FRONTIER_RESONANCIA.nivel}`, lang === 'pt' ? 'Vença o Primeiro Soberano pra abrir esta rota.' : lang === 'en' ? 'Beat the First Sovereign to open this route.' : 'Completa al Primer Soberano para abrir esta ruta.'], '🔒')
                    : frontierPanel(lang === 'pt' ? '𝗥𝗘𝗦𝗦𝗢𝗡𝗔̂𝗡𝗖𝗜𝗔 𝗗𝗘𝗦𝗖𝗢𝗕𝗘𝗥𝗧𝗔' : lang === 'en' ? '𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗘 𝗨𝗡𝗟𝗢𝗖𝗞𝗘𝗗' : '𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔 𝗗𝗘𝗦𝗖𝗨𝗕𝗜𝗘𝗥𝗧𝗔', [lang === 'pt' ? `Estado: ${estado?.estado || 'disponível'}` : lang === 'en' ? `Status: ${estado?.estado || 'available'}` : `Estado: ${estado?.estado || 'disponible'}`, lang === 'pt' ? `Região: ${FRONTIER_RESONANCIA.region}` : lang === 'en' ? `Region: ${FRONTIER_RESONANCIA.region}` : `Región: ${FRONTIER_RESONANCIA.region}`, activo ? (lang === 'pt' ? 'Tem um encontro ativo neste chat.' : lang === 'en' ? 'There is an active encounter in this chat.' : 'Hay un encuentro activo en este chat.') : (lang === 'pt' ? `Começa com ${prefix}iniciaresonancia.` : lang === 'en' ? `Start with ${prefix}startresonance.` : `Inicia con ${prefix}iniciaresonancia.`)], '🌱')
                return sendReply(sock, from, { text: `${frontierTitulo(lang === 'pt' ? '𝗢 𝗝𝗔𝗥𝗗𝗜𝗠 𝗤𝗨𝗘 𝗟𝗘𝗠𝗕𝗥𝗔' : lang === 'en' ? '𝗧𝗛𝗘 𝗚𝗔𝗥𝗗𝗘𝗡 𝗧𝗛𝗔𝗧 𝗥𝗘𝗠𝗘𝗠𝗕𝗘𝗥𝗦' : '𝗘𝗟 𝗝𝗔𝗥𝗗𝗜́𝗡 𝗤𝗨𝗘 𝗥𝗘𝗖𝗨𝗘𝗥𝗗𝗔', lang === 'pt' ? 'Segundo cenário único da temporada' : lang === 'en' ? 'Second unique stage of the season' : 'Segundo escenario único de la temporada', '🌱')}\n\n${tr(lang, FRONTIER_RESONANCIA.desc, 'Uma memória viva cresce debaixo do Bosque Prismático e repete as decisões de cada explorador.', 'A living memory grows under the Prismatic Forest and repeats every explorer\'s choices.')}\n\n${texto}${activo ? `\n\n${frontierResonanciaTexto(activo, lang)}` : ''}` }, { quoted: m })
            }
            if (command === 'iniciaresonancia') {
                if (!isGroup) return sendReply(sock, from, { text: tr(lang, '❌ La Segunda Resonancia necesita un grupo.', '❌ A Segunda Ressonância precisa de um grupo.', '❌ The Second Resonance needs a group.') }, { quoted: m })
                if (frontierResonanciaActiva(from)) return sendReply(sock, from, { text: frontierResonanciaTexto(frontierResonanciaActiva(from), lang) }, { quoted: m })
                const resultado = frontierCrearResonancia(from, getUsuario(sender), sender, pushName)
                if (resultado.ok) return sendFrontierEvento(sock, from, 'desafio', resultado.texto, { quoted: m })
                return sendReply(sock, from, { text: resultado.texto }, { quoted: m })
            }
            if (command === 'unirresonancia') {
                const activo = frontierResonanciaActiva(from); if (!activo) return sendReply(sock, from, { text: tr(lang, `❌ No hay resonancia activa. Usa *${prefix}iniciaresonancia*.`, `❌ Não há ressonância ativa. Use *${prefix}startresonance*.`, `❌ There is no active resonance. Use *${prefix}startresonance*.`) }, { quoted: m })
                const agregado = frontierResonanciaAgregar(activo, sender, pushName); if (!agregado) return sendReply(sock, from, { text: tr(lang, `❌ El equipo ya alcanzó ${FRONTIER_MAX_RESONANCIA} participantes.`, `❌ O time já chegou a ${FRONTIER_MAX_RESONANCIA} participantes.`, `❌ The team already hit ${FRONTIER_MAX_RESONANCIA} players.`) }, { quoted: m })
                return sendReply(sock, from, { text: tr(lang, `🤝 @${sender.split('@')[0]} joined.\n\n${frontierResonanciaTexto(activo, lang)}`, `🤝 @${sender.split('@')[0]} entrou.\n\n${frontierResonanciaTexto(activo, lang)}`, `🤝 @${sender.split('@')[0]} joined.\n\n${frontierResonanciaTexto(activo, lang)}`), mentions: [sender] }, { quoted: m })
            }
            if (['atacarresonancia', 'arteresonancia', 'frutaresonancia'].includes(command) && frontierResonanciaActiva(from)) {
                const e = frontierResonanciaActiva(from); const normal = normalizarJidGlobal(sender); if (!e.participantes.some(p => normalizarJidGlobal(p.jid) === normal)) return sendReply(sock, from, { text: tr(lang, `❌ Primero usa *${prefix}unirresonancia*.`, `❌ Primeiro use *${prefix}joinresonance*.`, `❌ First use *${prefix}joinresonance*.`) }, { quoted: m })
                const user = getUsuario(sender); let modo = command === 'arteresonancia' ? 'arte' : command === 'frutaresonancia' ? 'fruta' : 'normal'; let costo = modo === 'arte' ? frontierArteHabilidad(user).costo : modo === 'fruta' ? frontierSoberanoFruta(user)?.habilidad?.costo || 0 : 0
                if (user.energy < costo) return sendReply(sock, from, { text: tr(lang, `⚡ Necesitas ${costo} de energía.`, `⚡ Você precisa de ${costo} de energia.`, `⚡ You need ${costo} energy.`) }, { quoted: m })
                user.energy -= costo; const dano = frontierResonanciaDanio(user, e, modo); e.hp = Math.max(0, e.hp - dano); const participante = e.participantes.find(p => normalizarJidGlobal(p.jid) === normal); participante.dano += dano; participante.acciones++
                const cambio = frontierResonanciaFase(e); let texto = `${frontierTitulo(modo === 'arte' ? tr(lang,'𝗔𝗥𝗧𝗘 𝗗𝗘 𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔','𝗔𝗥𝗧𝗘 𝗗𝗔 𝗥𝗘𝗦𝗦𝗢𝗡𝗔̂𝗡𝗖𝗜𝗔','𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗘 𝗔𝗥𝗧') : modo === 'fruta' ? tr(lang,'𝗙𝗥𝗨𝗧𝗔 𝗗𝗘 𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔','𝗙𝗥𝗨𝗧𝗔 𝗗𝗔 𝗥𝗘𝗦𝗦𝗢𝗡𝗔̂𝗡𝗖𝗜𝗔','𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗘 𝗙𝗥𝗨𝗜𝗧') : tr(lang,'𝗚𝗢𝗟𝗣𝗘 𝗗𝗘 𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔','𝗚𝗢𝗟𝗣𝗘 𝗗𝗔 𝗥𝗘𝗦𝗦𝗢𝗡𝗔̂𝗡𝗖𝗜𝗔','𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗘 𝗛𝗜𝗧'), FRONTIER_RESONANCIA.nombre, modo === 'arte' ? '✨' : modo === 'fruta' ? '🍎' : '⚔️')}\n\n${tr(lang, `@${sender.split('@')[0]} causa *${dano}* de daño.`, `@${sender.split('@')[0]} causa *${dano}* de dano.`, `@${sender.split('@')[0]} deals *${dano}* damage.`)}\n\n${frontierResonanciaTexto(e, lang)}`; if (cambio) texto += `\n\n🔻 ${tr(lang, 'CAMBIO DE FASE', 'MUDANÇA DE FASE', 'PHASE CHANGE')}: ${cambio}`
                if (e.hp <= 0) { const avisos = frontierRecompensarResonancia(e); frontierResonanciasActivas.delete(from); frontierGuardarResonancias(); guardarEconomia(); texto += `\n\n🏆 *${tr(lang, 'RESONANCIA COMPLETADA', 'RESSONÂNCIA CONCLUÍDA', 'RESONANCE CLEARED')}*\n${avisos.join('\n')}\n\n${tr(lang, `Elige con *${prefix}decidirresonancia integrar*, *aislar* o *reprogramar*.`, `Escolhe com *${prefix}decidirresonancia integrar*, *aislar* ou *reprogramar*.`, `Pick with *${prefix}decidirresonancia integrar*, *aislar* or *reprogramar*.`)}` } else { const contra = frontierAplicarEscudo(user, Math.max(1, e.dano - Math.floor(user.stats.def / 3) + Math.floor(Math.random() * 12))); user.hp = Math.max(1, user.hp - contra); texto += `\n\n💢 ${tr(lang, `Contraataque: -${contra} HP\n❤️ Tu HP: ${user.hp}/${user.maxHp}`, `Contra-ataque: -${contra} HP\n❤️ Seu HP: ${user.hp}/${user.maxHp}`, `Counter: -${contra} HP\n❤️ Your HP: ${user.hp}/${user.maxHp}`)}`; frontierGuardarResonancias(); guardarEconomia() }
                if (e.hp <= 0) return sendFrontierEvento(sock, from, 'victoria', texto, { quoted: m, mentions: [sender] })
                return sendReply(sock, from, { text: texto, mentions: [sender] }, { quoted: m })
            }
            if (command === 'decidirresonancia') {
                const user = getUsuario(sender); const resultado = frontierAplicarDecisionResonancia(user, args[0] || ''); if (resultado.ok) guardarEconomia()
                return sendReply(sock, from, { text: tr(lang, `${frontierTitulo('𝗗𝗘𝗖𝗜𝗦𝗜𝗢́𝗡 𝗗𝗘 𝗟𝗔 𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔', args[0] || 'sin opción', '🌱')}\n\n${resultado.texto}`, `${frontierTitulo('𝗗𝗘𝗖𝗜𝗦𝗜𝗢́𝗡 𝗗𝗘 𝗟𝗔 𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔', args[0] || 'sin opción', '🌱')}\n\n${resultado.texto}`, `${frontierTitulo('𝗗𝗘𝗖𝗜𝗦𝗜𝗢́𝗡 𝗗𝗘 𝗟𝗔 𝗥𝗘𝗦𝗢𝗡𝗔𝗡𝗖𝗜𝗔', args[0] || 'sin opción', '🌱')}\n\n${resultado.texto}`) }, { quoted: m })
            }
            if (command === 'huirresonancia') {
                const e = frontierResonanciaActiva(from); if (!e) return sendReply(sock, from, { text: tr(lang, '❌ No hay una resonancia activa.', '❌ Não há ressonância ativa.', `❌ There is no active resonance.`) }, { quoted: m })
                e.participantes = e.participantes.filter(p => normalizarJidGlobal(p.jid) !== normalizarJidGlobal(sender)); if (!e.participantes.length) frontierResonanciasActivas.delete(from); frontierGuardarResonancias()
                return sendReply(sock, from, { text: tr(lang, `🏃 @${sender.split('@')[0]} abandonó la resonancia.`, `🏃 @${sender.split('@')[0]} saiu da ressonância.`, `🏃 @${sender.split('@')[0]} left the resonance.`), mentions: [sender] }, { quoted: m })
            }

            // ====================== WOLFRIC FRONTIER: GUARDIANES Y SOBERANO ======================
            if (command === 'guardianes') {
                const user = getUsuario(sender)
                const escenario = frontierEscenario(user, false)
                let texto = `${frontierTitulo('𝗚𝗨𝗔𝗥𝗗𝗜𝗔𝗡𝗘𝗦 𝗗𝗘 𝗟𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗥𝗔', 'Cada victoria abre una etapa del escenario único', '⚔️')}\n\n`
                FRONTIER_GUARDIANES.forEach(g => {
                    const activo = escenario?.etapa === g.etapa && escenario.estado !== 'completado'
                    const vencido = user.frontier.guardianesDerrotados.includes(g.id)
                    const estado = vencido ? '✅ derrotado' : activo ? '⚠️ disponible' : '🔒 bloqueado'
                    texto += `${frontierPanel(`${estado.toUpperCase()} · ${g.nombre}`, [`Etapa ${g.etapa} · Nivel ${g.nivel}`, `📍 ${g.region}`, `❤️ ${g.hp} HP`, g.desc], vencido ? '✓' : activo ? '!' : '·')}\n\n`
                })
                texto += frontierPanel(tr(lang, '𝗣𝗥𝗢́𝗫𝗜𝗠𝗢 𝗣𝗔𝗦𝗢', '𝗣𝗥𝗢́𝗫𝗜𝗠𝗢 𝗣𝗔𝗦𝗦𝗢', '𝗣𝗥𝗢́𝗫𝗜𝗠𝗢 𝗣𝗔𝗦𝗢'), [tr(lang, `Descubrí señales con ${prefix}explore <región>.`, `Descubra sinais com ${prefix}explore <região>.`, `Descubrí signals con ${prefix}explore <region>.`), tr(lang, `Consultá el escenario con ${prefix}sovereign.`, `Veja o cenário com ${prefix}sovereign.`, `Consultá el escenario con ${prefix}sovereign.`)], '🧭')
                return sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'soberano') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const escenario = frontierEscenario(user, false)
                const activo = frontierSoberanoActivo(from)
                let texto = `${frontierTitulo('𝗟𝗔 𝗦𝗘𝗡̃𝗔𝗟 𝗗𝗘𝗟 𝗣𝗥𝗜𝗠𝗘𝗥 𝗦𝗢𝗕𝗘𝗥𝗔𝗡𝗢', 'Escenario único de Wolfric Frontier', '👑')}\n\n`
                if (!escenario) {
                    texto += frontierPanel('𝗘𝗦𝗧𝗔𝗗𝗢 𝗜𝗡𝗔𝗖𝗧𝗜𝗩𝗢', ['🔒 Señal todavía no descubierta.', `Explora con ${prefix}explorar <región>.`], '🔒')
                } else {
                    texto += frontierPanel('𝗣𝗥𝗢𝗚𝗥𝗘𝗦𝗢 𝗡𝗔𝗥𝗥𝗔𝗧𝗜𝗩𝗢', [`Estado: ${escenario.estado}`, `Etapa: ${escenario.etapa}/3`, `Fase: ${escenario.faseNarrativa}`, `Decisión pendiente: ${escenario.decisionPendiente ? 'sí' : 'no'}`, `Pistas: ${f.pistas.length}`], '📜')
                    texto += `\n\n${activo ? frontierSoberanoTexto(activo, lang) : frontierPanel(tr(lang,'𝗣𝗥𝗢́𝗫𝗜𝗠𝗔 𝗔𝗖𝗖𝗜𝗢́𝗡','𝗣𝗥𝗢́𝗫𝗜𝗠𝗔 𝗔𝗖̧𝗔̃𝗢','𝗡𝗘𝗫𝗧 𝗔𝗖𝗧𝗜𝗢𝗡'), [tr(lang, `Inicia la etapa con ${prefix}iniciarfrontera.`, `Começa a etapa com ${prefix}frontierstart.`, `Start the stage with ${prefix}frontierstart.`)], '🎯')}`
                }
                return sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'iniciarfrontera') {
                if (!isGroup) return sendReply(sock, from, { text: tr(lang, '❌ Los Guardianes de Frontier se enfrentan en grupos.', '❌ Os Guardiões de Frontier lutam em grupos.', '❌ Frontier Guardians are fought in groups.') }, { quoted: m })
                const activo = frontierSoberanoActivo(from)
                if (activo) return sendReply(sock, from, { text: frontierSoberanoTexto(activo, lang) }, { quoted: m })
                const user = getUsuario(sender)
                const resultado = frontierCrearSoberano(from, user, sender, pushName)
                if (resultado.ok) return sendFrontierEvento(sock, from, 'desafio', resultado.texto, { quoted: m })
                return sendReply(sock, from, { text: resultado.texto }, { quoted: m })
            }

            if (command === 'unirsefrontera') {
                if (!isGroup) return sendReply(sock, from, { text: tr(lang, '❌ Este encuentro necesita un grupo.', '❌ Este encontro precisa de um grupo.', '❌ This encounter needs a group.') }, { quoted: m })
                const activo = frontierSoberanoActivo(from)
                if (!activo) return sendReply(sock, from, { text: tr(lang, `❌ No hay un Guardián activo. Usa *${prefix}iniciarfrontera* si tienes una etapa disponible.`, `❌ Não há um Guardião ativo. Use *${prefix}startfrontier* se tiver uma etapa disponível.`, `❌ There's no un Guardián activo. Use *${prefix}iniciarfrontier* si tienes una etapa disponible.`) }, { quoted: m })
                const user = getUsuario(sender)
                const escenario = frontierEscenario(user, false)
                if (!escenario || escenario.etapa !== activo.etapa || escenario.decisionPendiente) return sendReply(sock, from, { text: tr(lang, '❌ Tu etapa narrativa no coincide con la del encuentro o tienes una decisión pendiente.', '❌ Sua etapa da história não bate com o encontro ou você tem uma decisão pendente.', '❌ Tu etapa narrativa no coincide con la del encounter o tienes una decisión pendiente.') }, { quoted: m })
                const agregado = frontierSoberanoAgregarParticipante(activo, sender, pushName)
                if (!agregado) return sendReply(sock, from, { text: tr(lang, `❌ El equipo ya alcanzó el máximo de ${FRONTIER_MAX_PARTICIPANTES} exploradores.`, `❌ O time já chegou ao máximo de ${FRONTIER_MAX_PARTICIPANTES} exploradores.`, `❌ The team already hit el máximo de ${FRONTIER_MAX_PARTICIPANTES} exploredores.`) }, { quoted: m })
                frontierGuardarSoberanos()
                return sendReply(sock, from, { text: tr(lang, `🤝 @${sender.split('@')[0]} se unió al equipo del encuentro.\n\n${frontierSoberanoTexto(activo, lang)}`, `🤝 @${sender.split('@')[0]} entrou no time do encontro.\n\n${frontierSoberanoTexto(activo, lang)}`, `🤝 @${sender.split('@')[0]} joined the encounter team.\n\n${frontierSoberanoTexto(activo, lang)}`), mentions: [sender] }, { quoted: m })
            }

            if (command === 'decidirfrontera') {
                const user = getUsuario(sender)
                const resultado = frontierAplicarDecision(user, args[0] || '')
                if (resultado.ok) guardarEconomia()
                return sendReply(sock, from, { text: tr(lang, `${frontierTitulo('𝗗𝗘𝗖𝗜𝗦𝗜𝗢́𝗡 𝗗𝗘 𝗟𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗥𝗔', args[0] || 'sin opción')}\n\n${resultado.texto}`, `${frontierTitulo('𝗗𝗘𝗖𝗜𝗦𝗜𝗢́𝗡 𝗗𝗘 𝗟𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗥𝗔', args[0] || 'sin opción')}\n\n${resultado.texto}`, `${frontierTitulo('𝗗𝗘𝗖𝗜𝗦𝗜𝗢́𝗡 𝗗𝗘 𝗟𝗔 𝗙𝗥𝗢𝗡𝗧𝗘𝗥𝗔', args[0] || 'sin opción')}\n\n${resultado.texto}`) }, { quoted: m })
            }

            if (command === 'frutafrontera') {
                const encuentro = frontierSoberanoActivo(from)
                if (!encuentro) return sendReply(sock, from, { text: tr(lang, `❌ No hay un encuentro activo. Usa *${prefix}iniciarfrontera*.`, `❌ Não há encontro ativo. Use *${prefix}startfrontier*.`, `❌ There's no active encounter. Use *${prefix}iniciarfrontier*.`) }, { quoted: m })
                const normal = normalizarJidGlobal(sender)
                if (!encuentro.participantes.some(p => normalizarJidGlobal(p.jid) === normal)) return sendReply(sock, from, { text: tr(lang, `❌ Primero usa *${prefix}unirsefrontera*.`, `❌ Primeiro use *${prefix}joinfrontier*.`, `❌ Use first *${prefix}unirsefrontier*.`) }, { quoted: m })
                const user = getUsuario(sender)
                const kit = frontierSoberanoFruta(user)
                if (!kit) return sendReply(sock, from, { text: tr(lang, `❌ No tienes una fruta equipada con habilidad. Usa *${prefix}equiparfruta <nombre>*.`, `❌ Você não tem uma fruta equipada com habilidade. Use *${prefix}equipfruit <nome>*.`, `❌ You don't have una fruit equipped con skill. Use *${prefix}equiparfruit <name>*.`) }, { quoted: m })
                const costo = kit.habilidad.costo || 0
                if (user.energy < costo) return sendReply(sock, from, { text: tr(lang, `❌ *${kit.habilidad.nombre}* needs ${costo}⚡ and you have ${user.energy}⚡.`, `❌ *${kit.habilidad.nombre}* precisa de ${costo}⚡ e você tem ${user.energy}⚡.`, `❌ *${kit.habilidad.nombre}* needs ${costo}⚡ and you have ${user.energy}⚡.`) }, { quoted: m })
                user.energy -= costo
                const dano = frontierSoberanoDanio(user, encuentro, 'fruta')
                encuentro.hp = Math.max(0, encuentro.hp - dano)
                const participante = encuentro.participantes.find(p => normalizarJidGlobal(p.jid) === normal)
                participante.dano += dano; participante.acciones++
                const cambio = frontierSoberanoAplicarFase(encuentro)
                let texto = `${frontierTitulo(tr(lang,'𝗔𝗖𝗖𝗜𝗢́𝗡 𝗗𝗘 𝗙𝗥𝗨𝗧𝗔','𝗔𝗖̧𝗔̃𝗢 𝗗𝗘 𝗙𝗥𝗨𝗧𝗔','𝗙𝗥𝗨𝗜𝗧 𝗔𝗖𝗧𝗜𝗢𝗡'), kit.habilidad.nombre, '🍎')}\n\n${tr(lang, `🍎 @${sender.split('@')[0]} canaliza *${kit.fruta.nombre}* y causa *${dano}* de daño.`, `🍎 @${sender.split('@')[0]} canaliza *${kit.fruta.nombre}* e causa *${dano}* de dano.`, `🍎 @${sender.split('@')[0]} channels *${kit.fruta.nombre}* and deals *${dano}* damage.`)}\n\n${frontierSoberanoTexto(encuentro, lang)}`
                if (cambio) texto += `\n\n🔻 *${tr(lang, 'CAMBIO DE FASE', 'MUDANÇA DE FASE', 'PHASE CHANGE')}:* ${cambio}`
                const guardian = FRONTIER_GUARDIANES.find(g => g.id === encuentro.guardianId)
                if (encuentro.hp <= 0) {
                    const recompensas = frontierRecompensarVictoria(encuentro)
                    frontierSoberanosActivos.delete(from); frontierGuardarSoberanos(); guardarEconomia()
                    texto += `\n\n🏆 *${guardian.nombre.toUpperCase()} DERROTADO*\n${recompensas.join('\n')}\n\nRevisa *${prefix}escenarios*. Si hay una decisión pendiente, usa *${prefix}decidirfrontera observar*, *romper* o *sellar*.`
                } else {
                    const contra = frontierAplicarEscudo(user, Math.max(1, encuentro.dano - Math.floor(user.stats.def / 4) + Math.floor(Math.random() * 10)))
                    user.hp = Math.max(1, user.hp - contra)
                    texto += `\n\n💢 ${tr(lang, `Contraataque del jefe: -${contra} HP\n❤️ Tu HP: ${user.hp}/${user.maxHp}`, `Contra-ataque do chefe: -${contra} HP\n❤️ Seu HP: ${user.hp}/${user.maxHp}`, `Boss counter: -${contra} HP\n❤️ Your HP: ${user.hp}/${user.maxHp}`)}`
                    frontierGuardarSoberanos(); guardarEconomia()
                }
                if (encuentro.hp <= 0) return sendFrontierEvento(sock, from, 'victoria', texto, { quoted: m, mentions: [sender] })
                return sendReply(sock, from, { text: texto, mentions: [sender] }, { quoted: m })
            }

            if (command === 'habilidadfrontera' && frontierSoberanoActivo(from)) {
                const encuentro = frontierSoberanoActivo(from)
                const normal = normalizarJidGlobal(sender)
                if (!encuentro.participantes.some(p => normalizarJidGlobal(p.jid) === normal)) return sendReply(sock, from, { text: tr(lang, `❌ Primero usa *${prefix}unirsefrontera*.`, `❌ Primeiro use *${prefix}joinfrontier*.`, `❌ Use first *${prefix}unirsefrontier*.`) }, { quoted: m })
                const user = getUsuario(sender)
                const arte = frontierArteEquipada(user)
                const habilidadArte = frontierArteHabilidad(user)
                const costoArte = habilidadArte.costo || 0
                if (user.energy < costoArte) return sendReply(sock, from, { text: tr(lang, `⚡ *${arte.nombre}* necesita ${costoArte} de energía y tienes ${user.energy}⚡.`, `⚡ *${arte.nombre}* precisa de ${costoArte} de energia e você tem ${user.energy}⚡.`, `⚡ *${arte.nombre}* needs ${costoArte} energy and you have ${user.energy}⚡.`) }, { quoted: m })
                user.energy -= costoArte
                const dano = frontierSoberanoDanio(user, encuentro, 'arte')
                encuentro.hp = Math.max(0, encuentro.hp - dano)
                const participante = encuentro.participantes.find(p => normalizarJidGlobal(p.jid) === normal)
                participante.dano += dano; participante.acciones++
                const cambio = frontierSoberanoAplicarFase(encuentro)
                let texto = `${frontierTitulo(tr(lang,'𝗔𝗖𝗖𝗜𝗢́𝗡 𝗗𝗘 𝗔𝗥𝗧𝗘','𝗔𝗖̧𝗔̃𝗢 𝗗𝗘 𝗔𝗥𝗧𝗘','𝗔𝗥𝗧 𝗔𝗖𝗧𝗜𝗢𝗡'), arte.nombre, '✨')}\n\n${tr(lang, `✨ @${sender.split('@')[0]} ejecuta *${arte.nombre}* y causa *${dano}* de daño.\n⚡ Coste: ${costoArte} · Energía restante: ${user.energy}`, `✨ @${sender.split('@')[0]} executa *${arte.nombre}* e causa *${dano}* de dano.\n⚡ Custo: ${costoArte} · Energia restante: ${user.energy}`, `✨ @${sender.split('@')[0]} uses *${arte.nombre}* and deals *${dano}* damage.\n⚡ Cost: ${costoArte} · Energy left: ${user.energy}`)}\n\n${frontierSoberanoTexto(encuentro, lang)}`
                if (cambio) texto += `\n\n🔻 *${tr(lang, 'CAMBIO DE FASE', 'MUDANÇA DE FASE', 'PHASE CHANGE')}:* ${cambio}`
                const guardian = FRONTIER_GUARDIANES.find(g => g.id === encuentro.guardianId)
                if (encuentro.hp <= 0) {
                    const recompensas = frontierRecompensarVictoria(encuentro)
                    user.frontier.guardianesDerrotados = Array.isArray(user.frontier.guardianesDerrotados) ? user.frontier.guardianesDerrotados : []
                    if (!user.frontier.guardianesDerrotados.includes(encuentro.guardianId)) user.frontier.guardianesDerrotados.push(encuentro.guardianId)
                    frontierSoberanosActivos.delete(from); frontierGuardarSoberanos(); guardarEconomia()
                    texto += `\n\n🏆 *${guardian.nombre.toUpperCase()} DERROTADO*\n${recompensas.join('\n')}\n\nLos participantes deben revisar *${prefix}escenarios* y elegir con *${prefix}decidirfrontera <observar/romper/sellar>* si corresponde.`
                } else {
                    const contra = Math.max(1, encuentro.dano - Math.floor(user.stats.def / 4) + Math.floor(Math.random() * 10))
                    user.hp = Math.max(1, user.hp - contra)
                    texto += `\n\n💢 ${tr(lang, `Contraataque del jefe: -${contra} HP\n❤️ Tu HP: ${user.hp}/${user.maxHp}`, `Contra-ataque do chefe: -${contra} HP\n❤️ Seu HP: ${user.hp}/${user.maxHp}`, `Boss counter: -${contra} HP\n❤️ Your HP: ${user.hp}/${user.maxHp}`)}`
                    frontierGuardarSoberanos(); guardarEconomia()
                }
                if (encuentro.hp <= 0) return sendFrontierEvento(sock, from, 'victoria', texto, { quoted: m, mentions: [sender] })
                return sendReply(sock, from, { text: texto, mentions: [sender] }, { quoted: m })
            }

            if ((command === 'huirfrontera' || command === 'huir') && frontierSoberanoActivo(from)) {
                const encuentro = frontierSoberanoActivo(from)
                const normal = normalizarJidGlobal(sender)
                encuentro.participantes = encuentro.participantes.filter(p => normalizarJidGlobal(p.jid) !== normal)
                if (!encuentro.participantes.length) frontierSoberanosActivos.delete(from)
                frontierGuardarSoberanos()
                return sendReply(sock, from, { text: tr(lang, `🏃 @${sender.split('@')[0]} abandonó el encuentro de Frontier.${encuentro.participantes.length ? `\nEquipo restante: ${frontierNombreParticipantes(encuentro)}` : '\nEl encuentro se cerró porque no quedan participantes.'}`, `🏃 @${sender.split('@')[0]} saiu do encontro de Frontier.${encuentro.participantes.length ? `\nTime restante: ${frontierNombreParticipantes(encuentro)}` : '\nO encontro fechou porque não sobrou ninguém.'}`, `🏃 @${sender.split('@')[0]} left the Frontier encounter.${encuentro.participantes.length ? `\nTeam left: ${frontierNombreParticipantes(encuentro)}` : '\nThe encounter closed because nobody is left.'}`), mentions: [sender] }, { quoted: m })
            }

            if (command === 'usarfrontera') {
                const user = getUsuario(sender)
                const query = text.trim().toLowerCase()
                if (!query) return sendReply(sock, from, { text: tr(lang, `❌ Uso: *${prefix}usarfrontera <objeto>*. Consulta *${prefix}tienda* o usa objetos obtenidos en eventos y élites.`, `❌ Uso: *${prefix}frontieruse <objeto>*. Veja *${prefix}shop* ou use itens de eventos e elites.`, `❌ Usage: *${prefix}frontieruse <item>*. Check *${prefix}shop* or use items from events and elites.`) }, { quoted: m })
                const index = user.inventory.findIndex(nombre => nombre.toLowerCase().includes(query))
                if (index === -1) return sendReply(sock, from, { text: tr(lang, '❌ No tienes ese objeto en tu inventario.', '❌ Você não tem esse objeto no inventário.', `❌ You don't have that item in your inventory.`) }, { quoted: m })
                const item = ITEMS_CONSUMIBLES.find(i => user.inventory[index].toLowerCase().includes(i.nombre.toLowerCase()))
                if (!item?.tipo?.startsWith('frontier_')) return sendReply(sock, from, { text: tr(lang, `❌ *${user.inventory[index]}* no es un consumible de Frontier. Usa *${prefix}usar* para los consumibles clásicos.`, `❌ *${user.inventory[index]}* não é um consumível de Frontier. Use *${prefix}use* para os consumíveis clássicos.`, `❌ *${user.inventory[index]}* no es un consumible de Frontier. Use *${prefix}usar* para los consumibles clásicos.`) }, { quoted: m })
                const activo = frontierSoberanoActivo(from) || frontierResonanciasActivas.get(from) || encuentrosFrontierActivos.get(from)
                const resultado = frontierAplicarItemActivo(user, item, activo)
                if (!resultado.ok) return sendReply(sock, from, { text: tr(lang, `❌ ${resultado.texto}`, `❌ ${resultado.texto}`, `❌ ${resultado.texto}`) }, { quoted: m })
                user.inventory.splice(index, 1)
                frontierGuardarSoberanos(); frontierGuardarResonancias(); guardarEconomia()
                return sendReply(sock, from, { text: `${frontierTitulo('𝗢𝗕𝗝𝗘𝗧𝗢 𝗗𝗘 𝗙𝗥𝗢𝗡𝗧𝗘𝗥𝗔', item.nombre, '🎒')}\n\n${resultado.texto}` }, { quoted: m })
            }

            if (command === 'atacarfrontera' && frontierSoberanoActivo(from)) {
                const encuentro = frontierSoberanoActivo(from)
                const normal = normalizarJidGlobal(sender)
                if (!encuentro.participantes.some(p => normalizarJidGlobal(p.jid) === normal)) return sendReply(sock, from, { text: tr(lang, `❌ Primero usa *${prefix}unirsefrontera*.`, `❌ Primeiro use *${prefix}joinfrontier*.`, `❌ Use first *${prefix}unirsefrontier*.`) }, { quoted: m })
                const user = getUsuario(sender)
                const dano = frontierSoberanoDanio(user, encuentro, false)
                encuentro.hp = Math.max(0, encuentro.hp - dano)
                const participante = encuentro.participantes.find(p => normalizarJidGlobal(p.jid) === normal)
                participante.dano += dano; participante.acciones++
                const cambio = frontierSoberanoAplicarFase(encuentro)
                let texto = `${tr(lang, `⚔️ @${sender.split('@')[0]} ataca al jefe y causa *${dano}* de daño.`, `⚔️ @${sender.split('@')[0]} ataca o chefe e causa *${dano}* de dano.`, `⚔️ @${sender.split('@')[0]} hits the boss for *${dano}* damage.`)}\n\n${frontierSoberanoTexto(encuentro, lang)}`
                if (cambio) texto += `\n\n🔻 *${tr(lang, 'CAMBIO DE FASE', 'MUDANÇA DE FASE', 'PHASE CHANGE')}:* ${cambio}`
                const guardian = FRONTIER_GUARDIANES.find(g => g.id === encuentro.guardianId)
                if (encuentro.hp <= 0) {
                    const recompensas = frontierRecompensarVictoria(encuentro)
                    for (const p of encuentro.participantes) {
                        const pf = frontierInicializar(getUsuario(p.jid))
                        if (!pf.guardianesDerrotados.includes(encuentro.guardianId)) pf.guardianesDerrotados.push(encuentro.guardianId)
                    }
                    frontierSoberanosActivos.delete(from); frontierGuardarSoberanos(); guardarEconomia()
                    texto += `\n\n🏆 *${guardian.nombre.toUpperCase()} DERROTADO*\n${recompensas.join('\n')}\n\nRevisa *${prefix}escenarios*. Si hay una decisión pendiente, usa *${prefix}decidirfrontera observar*, *romper* o *sellar*.`
                } else {
                    const contra = Math.max(1, encuentro.dano - Math.floor(user.stats.def / 4) + Math.floor(Math.random() * 10))
                    user.hp = Math.max(1, user.hp - contra)
                    texto += `\n\n💢 ${tr(lang, `Contraataque del jefe: -${contra} HP\n❤️ Tu HP: ${user.hp}/${user.maxHp}`, `Contra-ataque do chefe: -${contra} HP\n❤️ Seu HP: ${user.hp}/${user.maxHp}`, `Boss counter: -${contra} HP\n❤️ Your HP: ${user.hp}/${user.maxHp}`)}`
                    frontierGuardarSoberanos(); guardarEconomia()
                }
                if (encuentro.hp <= 0) return sendFrontierEvento(sock, from, 'victoria', texto, { quoted: m, mentions: [sender] })
                return sendReply(sock, from, { text: texto, mentions: [sender] }, { quoted: m })
            }

            if (command === 'atacarfrontera') {
                const encuentro = encuentrosFrontierActivos.get(from)
                if (!encuentro) return sendReply(sock, from, { text: tr(lang, `❌ No hay un encuentro activo. Usa *${prefix}explorar <región>* para buscar actividad.`, `❌ Não há encontro ativo. Use *${prefix}explore <região>* para procurar atividade.`, `❌ There's no active encounter. Use *${prefix}explorer <region>* para buscar actividad.`) }, { quoted: m })
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const arma = frontierArma(user)
                const arte = f.artesEquipadas.map(id => FRONTIER_ARTES.find(a => a.id === id)).find(Boolean)
                let dano = Math.max(1, user.stats.str + frontierArmaExtra(user, 'normal') + Math.floor(Math.random() * 12) + Math.floor(user.stats.agi / 10) + frontierConsumirBonusFase(user))
                if (arte?.id === 'golpe_precision') dano += Math.floor(user.stats.int * 0.4)
                if (arte?.id === 'ruptura_guardian' && encuentro.monster.nivel > user.level) dano = Math.floor(dano * 1.25)
                encuentro.monster.hp = Math.max(0, encuentro.monster.hp - dano)
                let texto = `${frontierTitulo('COMBATE DE RUTA', encuentro.monster.nombre, encuentro.monster.elite ? '🚨' : '⚔️')}

${frontierPanel('ACCIÓN', [`${pushName} ejecuta un ataque.`, `Daño infligido: ${dano}`], '⚔️')}

${frontierPanel('ESTADO DEL OBJETIVO', [`👹 HP: ${encuentro.monster.hp}/${encuentro.monster.hpMax}`], encuentro.monster.elite ? '🚨' : '◈')}`
                if (encuentro.monster.hp <= 0) {
                    const cantidad = Math.floor(Math.random() * (encuentro.monster.maxDrop - encuentro.monster.minDrop + 1)) + encuentro.monster.minDrop
                    f.materiales[encuentro.monster.drop] = (f.materiales[encuentro.monster.drop] || 0) + cantidad
                    const monedas = 50 + encuentro.monster.nivel * 8
                    user.coins += monedas
                    user.lifetimeCoinsEarned += monedas
                    const nivelesSubidos = frontierDarExp(user, 18 + encuentro.monster.nivel)
                    user.bounty += 2
                    if (!f.encuentrosDescubiertos.includes(encuentro.monster.id)) f.encuentrosDescubiertos.push(encuentro.monster.id)
                    let premioExtra = ''
                    if (encuentro.monster.elite) {
                        if (!f.elitesDerrotadas.includes(encuentro.monster.id)) f.elitesDerrotadas.push(encuentro.monster.id)
                        f.prestigio += 25; user.bounty += encuentro.monster.bounty || 10
                        if (encuentro.monster.itemDrop) { user.inventory.push(encuentro.monster.itemDrop); premioExtra = `\n🎒 Objeto élite: *${encuentro.monster.itemDrop}*` }
                    }
                    f.reputacion[encuentro.regionId] = (f.reputacion[encuentro.regionId] || 0) + (encuentro.monster.elite ? 4 : 1)
                    encuentrosFrontierActivos.delete(from)
                    const regionNueva = frontierIntentarDesbloqueo(user)
                    frontierActualizarRango(user)
                    texto += `\n\n${frontierPanel(encuentro.monster.elite ? 'ÉLITE SUPERADO' : 'ENCUENTRO SUPERADO', [`🎁 +${cantidad}x ${encuentro.monster.material}${premioExtra}`, `💰 +$${monedas} · ✨ +${18 + encuentro.monster.nivel} EXP`, `💀 +${encuentro.monster.elite ? (encuentro.monster.bounty || 10) : 2} Bounty`, nivelesSubidos ? `⬆️ Subiste ${nivelesSubidos} nivel(es).` : '', regionNueva ? `🗺️ Nueva región: ${regionNueva.nombre}.` : '', `Siguiente paso: ${prefix}equipo`], '🏆')}`
                } else {
                    const contra = frontierAplicarEscudo(user, Math.max(1, encuentro.monster.dano - Math.floor(user.stats.def / 3)))
                    user.hp = Math.max(0, user.hp - contra)
                    texto += `\n\n${frontierPanel('RESPUESTA HOSTIL', [`👹 Contraataque: -${contra} HP`, `❤️ Tu HP: ${user.hp}/${user.maxHp}`], '⚠️')}`
                    if (user.hp <= 0) {
                        user.hp = Math.max(1, Math.floor(user.maxHp * 0.25))
                        encuentrosFrontierActivos.delete(from)
                        texto += `\n\n${frontierPanel('RETIRO FORZADO', ['☠️ Has caído.', 'Vuelves con 25% de HP.'], '☠️')}`
                    } else {
                        texto += `\n\n${frontierPanel('SIGUIENTE DECISIÓN', [`${prefix}atacarfrontera · continuar`, `${prefix}huir · retirarte`], '🎯')}`
                    }
                }
                guardarEconomia()
                const logroElite = encuentro.monster.hp <= 0 && Boolean(encuentro.monster.elite)
                if (logroElite) return sendFrontierEvento(sock, from, 'victoria', texto, { quoted: m, mentions: [sender] })
                return sendReply(sock, from, { text: texto, mentions: [sender] }, { quoted: m })
            }

            if (command === 'huir') {
                if (!encuentrosFrontierActivos.has(from)) return sendReply(sock, from, { text: tr(lang, '❌ No hay un encuentro de Frontier activo.', '❌ Não há encontro de Frontier ativo.', `❌ There's no un encounter de Frontier activo.`) }, { quoted: m })
                encuentrosFrontierActivos.delete(from)
                return sendReply(sock, from, { text: tr(lang, '🏃 Te retiras del encuentro. No pierdes objetos, pero tampoco recibes recompensa.', '🏃 Você sai do encontro. Não perde itens, mas também não ganha recompensa.', '🏃 Te retiras del encounter. No pierdes items, pero tampoco recibes reward.') }, { quoted: m })
            }

            if (command === 'equipo') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const arma = frontierArma(user)
                const poseidas = f.armasPoseidas.map(id => FRONTIER_ARMAS.find(a => a.id === id)?.nombre || id).join(', ')
                const artes = f.artesDesbloqueadas.map(id => FRONTIER_ARTES.find(a => a.id === id)?.nombre || id).join(', ')
                const texto = `${frontierTitulo('𝗘𝗤𝗨𝗜𝗣𝗢 𝗗𝗘𝗟 𝗘𝗫𝗣𝗟𝗢𝗥𝗔𝗗𝗢𝗥', pushName)}\n\n⚔️ *Arma equipada:* ${arma.nombre}\n📈 Ataque adicional: +${arma.atk}\n\n🧰 *Armas poseídas:*\n${poseidas}\n\n✨ *Artes aprendidas:*\n${artes}\n\n📦 *Materiales:*\n${frontierMaterialesTexto(f)}\n\nForja con *${prefix}forjar <arma>* y cambia con *${prefix}equipararma <arma>*.\nConsulta artes con *${prefix}artes*.`
                return sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'forjar') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const q = frontierNormalizar(text)
                const arma = FRONTIER_ARMAS.find(a => frontierNormalizar(a.id) === q || frontierNormalizar(a.nombre) === q || frontierNormalizar(a.nombre).includes(q))
                if (!arma || !q) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}forjar <nombre de arma>. Usa *${prefix}equipo* para ver tus opciones.`, `❌ Uso: ${prefix}forge <nome da arma>. Use *${prefix}gear* para ver as opções.`, `❌ Usage: ${prefix}forjar <name de weapon>. Use *${prefix}equipo* para ver tus opciones.`) }, { quoted: m })
                if (f.armasPoseidas.includes(arma.id)) return sendReply(sock, from, { text: tr(lang, `✅ Ya posees *${arma.nombre}*. Equípala con *${prefix}equipararma ${arma.nombre}*.`, `✅ Você já tem *${arma.nombre}*. Equipe com *${prefix}equipweapon ${arma.nombre}*.`, `✅ Ya posees *${arma.nombre}*. Equípala con *${prefix}equiparweapon ${arma.nombre}*.`) }, { quoted: m })
                if (user.level < arma.nivelMin) return sendReply(sock, from, { text: tr(lang, `🔒 *${arma.nombre}* requiere nivel ${arma.nivelMin}.`, `🔒 *${arma.nombre}* exige nível ${arma.nivelMin}.`, `🔒 *${arma.nombre}* needs level ${arma.nivelMin}.`) }, { quoted: m })
                if (arma.material && (f.materiales[arma.material] || 0) < arma.cantidad) return sendReply(sock, from, { text: tr(lang, `🧱 Te faltan materiales para forjar *${arma.nombre}*: necesitas ${arma.cantidad} unidades.`, `🧱 Faltam materiais para forjar *${arma.nombre}*: você precisa de ${arma.cantidad} unidades.`, `🧱 Te faltan materiales para forjar *${arma.nombre}*: you need ${arma.cantidad} unidades.`) }, { quoted: m })
                if (arma.material) f.materiales[arma.material] -= arma.cantidad
                f.armasPoseidas.push(arma.id)
                f.armaEquipada = arma.id
                guardarEconomia()
                return sendReply(sock, from, { text: `${frontierTitulo('𝗙𝗢𝗥𝗝𝗔 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗔𝗗𝗔', arma.nombre)}\n\n⚔️ ${lore(lang, arma.desc)}\n📈 Ataque adicional: +${arma.atk}\n\n${tr(lang, 'La nueva arma ha quedado equipada automáticamente.', 'A nova arma ficou equipada automaticamente.', 'The new weapon was auto-equipped.')}` }, { quoted: m })
            }

            if (command === 'equipararma') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const q = frontierNormalizar(text)
                const arma = FRONTIER_ARMAS.find(a => frontierNormalizar(a.id) === q || frontierNormalizar(a.nombre) === q || frontierNormalizar(a.nombre).includes(q))
                if (!arma || !q) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}equipararma <nombre>. Usa *${prefix}equipo*.`, `❌ Uso: ${prefix}equipweapon <nome>. Use *${prefix}gear*.`, `❌ Usage: ${prefix}equiparweapon <name>. Use *${prefix}equipo*.`) }, { quoted: m })
                if (!f.armasPoseidas.includes(arma.id)) return sendReply(sock, from, { text: tr(lang, `❌ Todavía no posees *${arma.nombre}*.`, `❌ Você ainda não tem *${arma.nombre}*.`, `❌ Not yet posees *${arma.nombre}*.`) }, { quoted: m })
                f.armaEquipada = arma.id
                guardarEconomia()
                return sendReply(sock, from, { text: tr(lang, `⚔️ Arma equipada: *${arma.nombre}* (+${arma.atk} ATK).`, `⚔️ Arma equipada: *${arma.nombre}* (+${arma.atk} ATK).`, `⚔️ Arma equipped: *${arma.nombre}* (+${arma.atk} ATK).`) }, { quoted: m })
            }

            if (command === 'artes') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                let texto = `${frontierTitulo('𝗔𝗥𝗧𝗘𝗦 𝗗𝗘 𝗖𝗢𝗠𝗕𝗔𝗧𝗘', 'Habilidades que definen tu construcción')}\n\n`
                FRONTIER_ARTES.forEach(arte => {
                    const aprendido = f.artesDesbloqueadas.includes(arte.id)
                    const equipado = f.artesEquipadas.includes(arte.id)
                    texto += `${equipado ? '👑' : aprendido ? '✅' : '🔒'} *${arte.nombre}* — Nvl. ${arte.nivelMin} · ${arte.costo ? `$${arte.costo}` : 'Inicial'}\n   ${arte.desc}\n\n`
                })
                texto += `Aprende con *${prefix}aprenderarte <nombre>* y equipa con *${prefix}equipararte <nombre>*.`
                return sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'aprenderarte') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const arte = frontierArte(text)
                if (!text.trim() || !arte) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}aprenderarte <nombre del arte>. Usa *${prefix}artes*.`, `❌ Uso: ${prefix}learnart <nome da arte>. Use *${prefix}arts*.`, `❌ Usage: ${prefix}aprenderarte <name del arte>. Use *${prefix}artes*.`) }, { quoted: m })
                if (f.artesDesbloqueadas.includes(arte.id)) return sendReply(sock, from, { text: tr(lang, `✅ Ya aprendiste *${arte.nombre}*.`, `✅ Você já aprendeu *${arte.nombre}*.`, `✅ You already learned *${arte.nombre}*.`) }, { quoted: m })
                if (user.level < arte.nivelMin) return sendReply(sock, from, { text: tr(lang, `🔒 *${arte.nombre}* requiere nivel ${arte.nivelMin}.`, `🔒 *${arte.nombre}* exige nível ${arte.nivelMin}.`, `🔒 *${arte.nombre}* needs level ${arte.nivelMin}.`) }, { quoted: m })
                if (user.coins < arte.costo) return sendReply(sock, from, { text: tr(lang, `❌ Necesitas $${arte.costo} para aprender *${arte.nombre}*.`, `❌ Você precisa de $${arte.costo} para aprender *${arte.nombre}*.`, `❌ You need $${arte.costo} para aprender *${arte.nombre}*.`) }, { quoted: m })
                user.coins -= arte.costo
                f.artesDesbloqueadas.push(arte.id)
                f.artesEquipadas = [arte.id]
                guardarEconomia()
                return sendReply(sock, from, { text: tr(lang, `✨ Has aprendido y equipado *${arte.nombre}*.\n${arte.desc}`, `✨ Você aprendeu e equipou *${arte.nombre}*.\n${arte.desc}`, `✨ Has aprendido y equipped *${arte.nombre}*.\n${arte.desc}`) }, { quoted: m })
            }

            if (command === 'equipararte') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const arte = frontierArte(text)
                if (!text.trim() || !arte) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}equipararte <nombre del arte>. Usa *${prefix}artes*.`, `❌ Uso: ${prefix}equipart <nome da arte>. Use *${prefix}arts*.`, `❌ Usage: ${prefix}equipart <art name>. Use *${prefix}arts*.`) }, { quoted: m })
                if (!f.artesDesbloqueadas.includes(arte.id)) return sendReply(sock, from, { text: tr(lang, `❌ Todavía no aprendiste *${arte.nombre}*.`, `❌ Você ainda não aprendeu *${arte.nombre}*.`, `❌ You have not learned *${arte.nombre}* yet.`) }, { quoted: m })
                f.artesEquipadas = [arte.id]
                guardarEconomia()
                return sendReply(sock, from, { text: tr(lang, `✨ Arte equipado: *${arte.nombre}*.\n${arte.desc}`, `✨ Arte equipada: *${arte.nombre}*.\n${arte.desc}`, `✨ Arte equipped: *${arte.nombre}*.\n${arte.desc}`) }, { quoted: m })
            }

            if (command === 'pistas') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                if (!f.pistas.length) return sendReply(sock, from, { text: tr(lang, `${frontierTitulo('𝗔𝗥𝗖𝗛𝗜𝗩𝗢 𝗗𝗘 𝗣𝗜𝗦𝗧𝗔𝗦', 'Todavía no has encontrado señales ocultas')}\n\nExplora regiones para descubrir información que no aparece en el mapa.`, `${frontierTitulo('𝗔𝗥𝗤𝗨𝗜𝗩𝗢 𝗗𝗘 𝗣𝗜𝗦𝗧𝗔𝗦', 'Você ainda não achou sinais escondidos')}\n\nExplore regiões pra descobrir info que não aparece no mapa.`, `${frontierTitulo('𝗖𝗟𝗨𝗘 𝗔𝗥𝗖𝗛𝗜𝗩𝗘', 'You have not found hidden signals yet')}\n\nExplore regions to uncover info that does not show on the map.`) }, { quoted: m })
                const lista = f.pistas.map((p, i) => `${i + 1}. *${p.id}*\n   ${p.texto}`).join('\n\n')
                return sendReply(sock, from, { text: tr(lang, `${frontierTitulo('𝗔𝗥𝗖𝗛𝗜𝗩𝗢 𝗗𝗘 𝗣𝗜𝗦𝗧𝗔𝗦', `${f.pistas.length} señal(es) registrada(s)`)}\n\n${lista}\n\nConsulta *${prefix}escenarios* para ver qué contenido activaron.`, `${frontierTitulo('𝗔𝗥𝗤𝗨𝗜𝗩𝗢 𝗗𝗘 𝗣𝗜𝗦𝗧𝗔𝗦', `${f.pistas.length} sinal(is) registrado(s)`)}\n\n${lista}\n\nConsulta *${prefix}stages* pra ver o que essas pistas liberaram.`, `${frontierTitulo('𝗖𝗟𝗨𝗘 𝗔𝗥𝗖𝗛𝗜𝗩𝗘', `${f.pistas.length} signal(s) logged`)}\n\n${lista}\n\nCheck *${prefix}stages* to see what content they unlocked.`) }, { quoted: m })
            }

            if (command === 'escenarios') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                if (!f.escenariosUnicos.length) return sendReply(sock, from, { text: tr(lang, `${frontierTitulo('𝗘𝗦𝗖𝗘𝗡𝗔𝗥𝗜𝗢𝗦 𝗨́𝗡𝗜𝗖𝗢𝗦', 'Contenido especial de la Frontera')}\n\nNo tienes escenarios activos. Las pistas aparecen mientras exploras.`, `${frontierTitulo('𝗖𝗘𝗡𝗔́𝗥𝗜𝗢𝗦 𝗨́𝗡𝗜𝗖𝗢𝗦', 'Conteúdo especial da Fronteira')}\n\nVocê não tem cenários ativos. As pistas aparecem enquanto explora.`, `${frontierTitulo('𝗨𝗡𝗜𝗤𝗨𝗘 𝗦𝗧𝗔𝗚𝗘𝗦', 'Special Frontier content')}\n\nYou have no active stages. Clues show up while you explore.`) }, { quoted: m })
                const lista = f.escenariosUnicos.map(e => `🔐 *${e.nombre}*\n   Estado: ${e.estado}\n   Progreso: ${e.progreso}/${e.meta}`).join('\n\n')
                return sendReply(sock, from, { text: tr(lang, `${frontierTitulo('𝗘𝗦𝗖𝗘𝗡𝗔𝗥𝗜𝗢𝗦 𝗨́𝗡𝗜𝗖𝗢𝗦', 'Las decisiones aquí pueden cambiar el mundo')}\n\n${lista}\n\nMás etapas se habilitarán al descubrir nuevas señales.`, `${frontierTitulo('𝗖𝗘𝗡𝗔́𝗥𝗜𝗢𝗦 𝗨́𝗡𝗜𝗖𝗢𝗦', 'As escolhas daqui podem mudar o mundo')}\n\n${lista}\n\nMais etapas abrem quando você achar sinais novos.`, `${frontierTitulo('𝗨𝗡𝗜𝗤𝗨𝗘 𝗦𝗧𝗔𝗚𝗘𝗦', 'Choices here can change the world')}\n\n${lista}\n\nMore stages unlock when you find new signals.`) }, { quoted: m })
            }

            if (command === 'rastrear') {
                const user = getUsuario(sender)
                const f = frontierInicializar(user, pushName)
                const region = frontierRegion(f.regionActual) || REGIONES_FRONTIER[0]
                const pistas = f.pistas.length ? `Tu última señal dice: “${f.pistas[f.pistas.length - 1].texto}”` : `No hay señales registradas en ${region.nombre}.`
                return sendReply(sock, from, { text: tr(lang, `${frontierTitulo('𝗥𝗔𝗦𝗧𝗥𝗘𝗢', region.nombre)}\n\n${pistas}\n\nSugerencia: explora la región actual con *${prefix}explorar ${region.nombre}*.`, `${frontierTitulo('𝗥𝗔𝗦𝗧𝗥𝗘𝗢', region.nombre)}\n\n${pistas}\n\nSugerencia: explora la región actual con *${prefix}explorar ${region.nombre}*.`, `${frontierTitulo('𝗥𝗔𝗦𝗧𝗥𝗘𝗢', region.nombre)}\n\n${pistas}\n\nSugerencia: explora la región actual con *${prefix}explorar ${region.nombre}*.`) }, { quoted: m })
            }


            // Categorías del menú con botones: solo muestran submenús de comandos
            if (command.startsWith('cat_')) {
                const cat = command.slice(4)
                if (cat === 'mas' || cat === 'más') {
                    try {
                        await sock.sendMessage(from, {
                            text: 'Más secciones:',
                            footer: (botConfig && botConfig.botName) || 'Wolfric',
                            buttons: [
                                { text: 'PvP', id: 'cat_pvp' },
                                { text: 'Actividad', id: 'cat_actividad' },
                                { text: 'Siguiente', id: 'cat_mas2' }
                            ]
                        })
                    } catch (e) {
                        await sendReply(sock, from, { text: wolfricMenuMovil(prefix, '', lang) }, { quoted: m })
                    }
                    return
                }
                if (cat === 'mas2') {
                    try {
                        await sock.sendMessage(from, {
                            text: 'Más secciones:',
                            footer: (botConfig && botConfig.botName) || 'Wolfric',
                            buttons: [
                                { text: 'Comercio', id: 'cat_comercio' },
                                { text: 'Mundo', id: 'cat_mundo' },
                                { text: 'Siguiente', id: 'cat_mas3' }
                            ]
                        })
                    } catch (e) {
                        await sendReply(sock, from, { text: wolfricMenuMovil(prefix, '', lang) }, { quoted: m })
                    }
                    return
                }
                if (cat === 'mas3') {
                    try {
                        await sock.sendMessage(from, {
                            text: 'Más secciones:',
                            footer: (botConfig && botConfig.botName) || 'Wolfric',
                            buttons: [
                                { text: 'Media', id: 'cat_media' },
                                { text: 'Frontera', id: 'cat_frontier' },
                                { text: 'Jugador', id: 'cat_jugador' }
                            ]
                        })
                    } catch (e) {
                        await sendReply(sock, from, { text: wolfricMenuMovil(prefix, '', lang) }, { quoted: m })
                    }
                    return
                }
                const texto = menuCategoria(prefix, cat, lang)
                if (!texto) return sendReply(sock, from, { text: textoUI(lang, 'cat_desconocida', { p: prefix }) }, { quoted: m })
                return sendReply(sock, from, { text: texto }, { quoted: m })
            }

            // ====================== IDIOMA (es / pt) ======================
            if (['idioma', 'language', 'lang', 'lingua', 'linguagem', 'idioma_es', 'idioma_pt', 'idioma_en'].includes(command)) {
                const user = getUsuario(sender)
                let pedido = (args[0] || '').toLowerCase()
                if (command === 'idioma_es') pedido = 'es'
                if (command === 'idioma_pt') pedido = 'pt'
                if (command === 'idioma_en') pedido = 'en'

                if (pedido === 'grupo' || pedido === 'group') {
                    if (!from.endsWith('@g.us')) return sendReply(sock, from, { text: textoUI(lang, 'invalido', { p: prefix }) }, { quoted: m })
                    if (!isAdmin && !isOwner) return sendReply(sock, from, { text: textoUI(lang, 'grupo_solo_admin') }, { quoted: m })
                    const elegidoGrupo = normalizarIdioma(args[1] || '')
                    if (!elegidoGrupo) return sendReply(sock, from, { text: textoUI(lang, 'invalido', { p: prefix }) }, { quoted: m })
                    const gcfgLang = getGrupoCfg(from)
                    gcfgLang.idioma = elegidoGrupo
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: textoUI(elegidoGrupo, 'grupo_ok', { nombre: IDIOMAS_NOMBRE[elegidoGrupo] }) }, { quoted: m })
                }

                const elegido = normalizarIdioma(pedido)
                if (elegido) {
                    user.idioma = elegido
                    guardarEconomia()
                    return sendReply(sock, from, { text: textoUI(elegido, 'elegido', { nombre: IDIOMAS_NOMBRE[elegido] }) }, { quoted: m })
                }

                const gLang = from.endsWith('@g.us') ? (getGrupoCfg(from).idioma || 'es') : 'es'
                const noElegido = tr(lang, 'todavía no elegiste', 'ainda não escolheu', "haven't chosen yet")
                const estado = textoUI(lang, 'estado', {
                    p: prefix,
                    yo: user.idioma ? IDIOMAS_NOMBRE[user.idioma] : noElegido,
                    grupo: from.endsWith('@g.us') ? IDIOMAS_NOMBRE[gLang] || gLang : tr(lang, 'chat privado', 'chat privado', 'private chat')
                })
                const okLang = await enviarConBotones(sock, from, textoUI(lang, 'elige', { p: prefix }) + '\n\n' + estado, [
                    { text: '🇪🇸 Español', id: 'idioma_es' },
                    { text: '🇧🇷 Português', id: 'idioma_pt' },
                    { text: '🇺🇸 English', id: 'idioma_en' }
                ], m)
                if (!okLang) {
                    await sendReply(sock, from, { text: textoUI(lang, 'elige', { p: prefix }) + '\n\n' + estado }, { quoted: m })
                }
                return
            }

            // ====================== MENÚ MÓVIL (+ botones/listas) ======================
            if (command === 'menu') {
                try {
                    const candidatosMenu = [path.join(process.cwd(), 'menu.jpg'), path.join(__dirname, 'menu.jpg')]
                    const menuPath = candidatosMenu.find(archivo => fs.existsSync(archivo))
                    let img = null
                    if (menuPath) {
                        try { img = fs.readFileSync(menuPath) } catch (e) { console.log('menu.jpg read:', e.message || e) }
                    }
                    const ok = await enviarMenuBotones(sock, from, m, img, lang)
                    if (!ok) {
                        await sendReply(sock, from, { text: wolfricMenuMovil(prefix, '', lang) }, { quoted: m })
                    }
                } catch (eMenu) {
                    console.log('menu handler error:', eMenu && (eMenu.message || eMenu))
                    try {
                        await sock.sendMessage(from, { text: wolfricMenuMovil(prefix, '', lang) })
                    } catch (_) {}
                }
                return
            }

            if (command === 'help') {
                return sendReply(sock, from, { text: frontierMenuPrincipal(prefix, lang) }, { quoted: m })
            }

            if (command === 'botones') {
                const ok = await enviarBotonesRapidos(sock, from, m, lang)
                if (!ok) {
                    await sendReply(sock, from, { text: textoUI(lang, 'botones_fail', { p: prefix }) }, { quoted: m })
                }
                return
            }

            // ====================== WOLFRIC PROTOCOL: MENÚ MÓVIL ======================
            if (command === 'wolfric') {
                return sendReply(sock, from, { text: wolfricMenuMovil(prefix, args.join(' '), lang) }, { quoted: m })
            }

            // ====================== ADMIN ======================
            if ((command === 'kick' || command === 'ban') && isGroup) {
                if (!isAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                if (!isBotAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Necesito ser admin.', '❌ Preciso ser admin.', '❌ I need to be admin.') }, { quoted: m })
                if (accionRuidosaEnCooldown(from)) return sendReply(sock, from, { text: tr(lang, '⏳ Espera unos segundos antes de otra acción de grupo.', '⏳ Espere alguns segundos antes de outra ação no grupo.', '⏳ Espera unos seconds antes de otra acción de group.') }, { quoted: m })
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, '❌ Etiqueta al usuario.', '❌ Marque o usuário.', '❌ Tag the user.') }, { quoted: m })
                await sock.groupParticipantsUpdate(from, mentioned, 'remove')
                invalidarGroupMetadataCache(from)
                registrarAccionRoot(sender, command, from, mentioned[0])
                await sendReply(sock, from, { text: tr(lang, '✅ Usuario expulsado.', '✅ Usuário removido.', '✅ Usuario expulsado.') }, { quoted: m })
            }

            if (command === 'promote' && isGroup) {
                if (!isAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                if (!isBotAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Necesito ser admin.', '❌ Preciso ser admin.', '❌ I need to be admin.') }, { quoted: m })
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, '❌ Etiqueta al usuario.', '❌ Marque o usuário.', '❌ Tag the user.') }, { quoted: m })
                await sock.groupParticipantsUpdate(from, mentioned, 'promote')
                invalidarGroupMetadataCache(from)
                registrarAccionRoot(sender, 'promote', from, mentioned[0])
                await sendReply(sock, from, { text: tr(lang, '✅ Promovido a admin.', '✅ Promovido a admin.', '✅ Promovido a admin.') }, { quoted: m })
            }

            if (command === 'demote' && isGroup) {
                if (!isAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                if (!isBotAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Necesito ser admin.', '❌ Preciso ser admin.', '❌ I need to be admin.') }, { quoted: m })
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, '❌ Etiqueta al usuario.', '❌ Marque o usuário.', '❌ Tag the user.') }, { quoted: m })
                await sock.groupParticipantsUpdate(from, mentioned, 'demote')
                invalidarGroupMetadataCache(from)
                registrarAccionRoot(sender, 'demote', from, mentioned[0])
                await sendReply(sock, from, { text: tr(lang, '✅ Se quitó el admin.', '✅ O cargo de admin foi removido.', '✅ Se quitó el admin.') }, { quoted: m })
            }

            if (command === 'tagall' && isGroup) {
                if (!isAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const restante = tagallEnCooldown(from)
                if (restante) return sendReply(sock, from, { text: tr(lang, `⏳ Menciones masivas en enfriamiento (${restante}s más). Es la señal de spam que más vigila WhatsApp, por eso el límite.`, `⏳ Menções em massa em espera (${restante}s). É o tipo de spam que o WhatsApp mais vigia, por isso o limite.`, `⏳ Menciones masivas en enfriamiento (${restante}s más). Es la signal de spam que más vigila WhatsApp, por eso el límite.`) }, { quoted: m })
                const groupMetadata = await sock.groupMetadata(from)
                const participants = groupMetadata.participants.map(p => p.id)
                await sendReply(sock, from, { text: text || tr(lang, '📢 Atención a todos', '📢 Atenção, pessoal', '📢 Atención a todos'), mentions: participants })
            }

            if (command === 'open' && isGroup) {
                if (!isAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                if (!isBotAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Necesito ser admin.', '❌ Preciso ser admin.', '❌ I need to be admin.') }, { quoted: m })
                const segs = parseTiempoGrupo(args[0]||'')
                if (segs > 0) {
                    await sendReply(sock, from, { text: `⏳ Se abre en ${args[0]}.` }, { quoted: m })
                    setTimeout(() => sock.groupSettingUpdate(from, 'not_announcement').catch(()=>{}), segs*1000)
                    return
                }
                await sock.groupSettingUpdate(from, 'not_announcement')
                await sendReply(sock, from, { text: tr(lang, '✅ Grupo abierto.', '✅ Grupo aberto.', '✅ Group abierto.') }, { quoted: m })
            }

            if (command === 'close' && isGroup) {
                if (!isAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                if (!isBotAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Necesito ser admin.', '❌ Preciso ser admin.', '❌ I need to be admin.') }, { quoted: m })
                const segs = parseTiempoGrupo(args[0]||'')
                if (segs > 0) {
                    await sock.groupSettingUpdate(from, 'announcement')
                    await sendReply(sock, from, { text: `🔒 Cerrado. Se reabre en ${args[0]}.` }, { quoted: m })
                    setTimeout(() => sock.groupSettingUpdate(from, 'not_announcement').catch(()=>{}), segs*1000)
                    return
                }
                await sock.groupSettingUpdate(from, 'announcement')
                await sendReply(sock, from, { text: tr(lang, '✅ Grupo cerrado.', '✅ Grupo fechado.', '✅ Group cerrado.') }, { quoted: m })
            }

            // ====================== PANEL ADMIN DE GRUPO ======================
            if (command === 'admin') {
                if (isGroup && !isAdmin && !isOwner) {
                    return sendReply(sock, from, { text: `${wolfricTitulo(tr(lang, 'ACCESO DENEGADO', 'ACESSO NEGADO', 'ACCESS DENIED'), tr(lang, 'Solo admins del grupo.', 'Apenas admins do grupo.', 'Group admins only.'), '🚫')}\n\n${frontierPanel(tr(lang, 'DETALLE', 'DETALHE', 'DETAIL'), [tr(lang, 'Necesitás ser admin del grupo para ver este panel.', 'Você precisa ser admin do grupo para ver este painel.', 'You need ser admin del group para ver este panel.')], '⚠')}` }, { quoted: m })
                }
                return sendReply(sock, from, { text: menuAdminGrupo(prefix, lang) }, { quoted: m })
            }

            if (command === 'owner' && isOwner) {
                return sendReply(sock, from, { text: menuOwnerBot(prefix, lang) }, { quoted: m })
            }
            if (command === 'owner' && !isOwner) {
                return sendReply(sock, from, { text: `${wolfricTitulo(tr(lang, 'ACCESO DENEGADO', 'ACESSO NEGADO', 'ACCESS DENIED'), tr(lang, 'Solo el dueño del bot.', 'Apenas o dono do bot.', 'Bot owner only.'), '🚫')}\n\n${frontierPanel(tr(lang, 'DETALLE', 'DETALHE', 'DETAIL'), [tr(lang, 'Este panel es exclusivo del owner.', 'Este painel é exclusivo do owner.', 'This panel is owner-only.')], '⚠')}` }, { quoted: m })
            }

            if (command === 'hidetag' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const restante = tagallEnCooldown(from)
                if (restante) return sendReply(sock, from, { text: tr(lang, `⏳ Menciones masivas en enfriamiento (${restante}s más).`, `⏳ Menções em massa em espera (${restante}s).`, `⏳ Menciones masivas en enfriamiento (${restante}s más).`) }, { quoted: m })
                const groupMetadata = await sock.groupMetadata(from)
                const participants = groupMetadata.participants.map(p => p.id)
                await esperarTurnoEnvio()
                await sock.sendMessage(from, { text: text || `${botConfig.botEmoji} ${botConfig.botName}`, mentions: participants })
                return
            }

            if (command === 'warn' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}warn @usuario`, `❌ Uso: ${prefix}warn @usuario`, `❌ Usage: ${prefix}warn @user`) }, { quoted: m })
                const target = mentioned[0]
                if (!advertencias.has(from)) advertencias.set(from, {})
                const mapa = advertencias.get(from)
                const key = normalizarJid(target)
                mapa[key] = (mapa[key] || 0) + 1
                const n = mapa[key]
                registrarAccionRoot(sender, 'warn', `${n}/3`, target)
                let extra = ''
                if (n >= ((getGrupoCfg(from).warnLimit)||3) && isBotAdmin) {
                    try {
                        await sock.groupParticipantsUpdate(from, [target], 'remove')
                        invalidarGroupMetadataCache(from)
                        extra = tr(lang, '\n👢 Alcanzó 3 advertencias y fue expulsado.', '\n👢 Chegou a 3 advertências e foi removido.', '\n👢 Alcanzó 3 advertencias y fue expulsado.')
                        mapa[key] = 0
                    } catch (_) { extra = tr(lang, '\n⚠ Llegó a 3 warns pero no pude expulsarlo (¿soy admin?).', '\n⚠ Chegou a 3 warns, mas não consegui remover (sou admin?).', '\n⚠ Llegó a 3 warns pero no pude expulsarlo (soy admin?).') }
                }
                return sendReply(sock, from, {
                    text: `${wolfricTitulo(tr(lang, 'ADVERTENCIA', 'ADVERTÊNCIA', 'ADVERTENCIA'), `@${target.split('@')[0]}`, '⚠')}\n\n${frontierPanel(tr(lang, 'DETALLE', 'DETALHE', 'DETAIL'), [`Warns: *${n}/${(getGrupoCfg(from).warnLimit) || 3}*`, extra || tr(lang, 'A la 3ra advertencia hay kick automático.', 'Na 3ª advertência tem kick automático.', 'A la 3ra advertencia hay kick automático.')], '📋')}`,
                    mentions: [target]
                }, { quoted: m })
            }

            if (command === 'warns' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const mentioned = getMentioned()
                const target = mentioned.length ? mentioned[0] : sender
                const n = (advertencias.get(from) || {})[normalizarJid(target)] || 0
                return sendReply(sock, from, {
                    text: `${wolfricTitulo(tr(lang, 'ADVERTENCIAS', 'ADVERTÊNCIAS', 'ADVERTENCIAS'), `@${target.split('@')[0]}`, '📋')}\n\n${frontierPanel(tr(lang, 'DETALLE', 'DETALHE', 'DETAIL'), [tr(lang, `Warns actuales: *${n}/${(getGrupoCfg(from).warnLimit)||3}*`, `Warns atuais: *${n}/${(getGrupoCfg(from).warnLimit)||3}*`, `Warns actuales: *${n}/${(getGrupoCfg(from).warnLimit)||3}*`)], '⚠')}`,
                    mentions: [target]
                }, { quoted: m })
            }

            if (command === 'unwarn' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}unwarn @usuario`, `❌ Uso: ${prefix}unwarn @usuario`, `❌ Usage: ${prefix}unwarn @user`) }, { quoted: m })
                const target = mentioned[0]
                if (!advertencias.has(from)) advertencias.set(from, {})
                const mapa = advertencias.get(from)
                const key = normalizarJid(target)
                mapa[key] = Math.max(0, (mapa[key] || 0) - 1)
                return sendReply(sock, from, {
                    text: `${wolfricTitulo(tr(lang, 'WARN QUITADO', 'WARN REMOVIDO', 'WARN QUITADO'), `@${target.split('@')[0]}`, '✅')}\n\n${frontierPanel(tr(lang, 'DETALLE', 'DETALHE', 'DETAIL'), [tr(lang, `Warns actuales: *${mapa[key]}/${(getGrupoCfg(from).warnLimit)||3}*`, `Warns atuais: *${mapa[key]}/${(getGrupoCfg(from).warnLimit)||3}*`, `Warns actuales: *${mapa[key]}/${(getGrupoCfg(from).warnLimit)||3}*`)], '📋')}`,
                    mentions: [target]
                }, { quoted: m })
            }

            if (command === 'groupinfo' && isGroup) {
                const meta = await sock.groupMetadata(from)
                const admins = meta.participants.filter(p => p.admin).length
                return sendReply(sock, from, {
                    text: `${wolfricTitulo(tr(lang, 'INFO DEL GRUPO', 'INFO DO GRUPO', 'INFO DEL GRUPO'), meta.subject || 'Grupo', 'ℹ️')}\n\n${frontierPanel(tr(lang, 'DETALLE', 'DETALHE', 'DETAIL'), [
                        tr(lang, `Miembros: *${meta.participants.length}*`, `Membros: *${meta.participants.length}*`, `Miembros: *${meta.participants.length}*`),
                        `Admins: *${admins}*`,
                        tr(lang, `Descripción: ${(meta.desc || 'Sin descripción').slice(0, 120)}`, `Descrição: ${(meta.desc || 'Sem descrição').slice(0, 120)}`, `Descripción: ${(meta.desc || 'Sin descripción').slice(0, 120)}`)
                    ], '📋')}`
                }, { quoted: m })
            }

            // ====================== PERSONALIZACIÓN DEL BOT (OWNER) ======================

            if (command === 'antilink' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                const arg = (args[0] || '').toLowerCase()
                if (['on', 'activar', '1', 'true'].includes(arg)) gcfg.antilink = true
                else if (['off', 'desactivar', '0', 'false'].includes(arg)) gcfg.antilink = false
                else gcfg.antilink = !gcfg.antilink
                guardarGruposConfig()
                return sendReply(sock, from, { text: tr(lang, `🔗 Anti-link: *${gcfg.antilink ? 'ON' : 'OFF'}*`, `🔗 Anti-link: *${gcfg.antilink ? 'ON' : 'OFF'}*`, `🔗 Anti-link: *${gcfg.antilink ? 'ON' : 'OFF'}*`) }, { quoted: m })
            }

            if (command === 'welcome' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                const arg = (args[0] || '').toLowerCase()
                if (['on', '1'].includes(arg)) gcfg.welcome = true
                else if (['off', '0'].includes(arg)) gcfg.welcome = false
                else gcfg.welcome = !gcfg.welcome
                guardarGruposConfig()
                return sendReply(sock, from, { text: tr(lang, `👋 Bienvenida de este grupo: *${gcfg.welcome ? 'ON' : 'OFF'}*\nTexto: ${prefix}setwelcome hola @user`, `👋 Boas-vindas deste grupo: *${gcfg.welcome ? 'ON' : 'OFF'}*\nTexto: ${prefix}setwelcome olá @user`, `👋 Bienvenida de este group: *${gcfg.welcome ? 'ON' : 'OFF'}*\nTexto: ${prefix}setwelcome hola @user`) }, { quoted: m })
            }

            if (command === 'setwelcome' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                gcfg.welcomeText = text || ''
                gcfg.welcome = true
                guardarGruposConfig()
                return sendReply(sock, from, { text: tr(lang, `✅ Bienvenida guardada.\nUsá @user donde vaya el nombre.\nAhora: *ON*`, `✅ Boas-vindas salvas.\nUse @user onde for o nome.\nAgora: *ON*`, `✅ Bienvenida guardada.\nUse @user donde vaya el name.\nAhour: *ON*`) }, { quoted: m })
            }

            if (command === 'goodbye' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                const arg = (args[0] || '').toLowerCase()
                if (['on', '1'].includes(arg)) gcfg.goodbye = true
                else if (['off', '0'].includes(arg)) gcfg.goodbye = false
                else gcfg.goodbye = !gcfg.goodbye
                guardarGruposConfig()
                return sendReply(sock, from, { text: tr(lang, `👋 Despedida: *${gcfg.goodbye ? 'ON' : 'OFF'}*`, `👋 Despedida: *${gcfg.goodbye ? 'ON' : 'OFF'}*`, `👋 Despedida: *${gcfg.goodbye ? 'ON' : 'OFF'}*`) }, { quoted: m })
            }

            if (command === 'setgoodbye' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                gcfg.goodbyeText = text || ''
                gcfg.goodbye = true
                guardarGruposConfig()
                return sendReply(sock, from, { text: tr(lang, '✅ Despedida guardada.', '✅ Despedida salva.', '✅ Despedida guardada.') }, { quoted: m })
            }

            const programarGrupo = (() => {
                if (!globalThis.__wolfricGrupoTimers) globalThis.__wolfricGrupoTimers = new Map()
                return globalThis.__wolfricGrupoTimers
            })()
            function parseTiempoGrupo(s) {
                const x = String(s||'').trim().toLowerCase()
                const m = x.match(/^(\d+)\s*(s|m|h|min|seg|hora|horas|minuto|minutos)?$/)
                if (!m) return 0
                const n = parseInt(m[1],10)
                const u = m[2] || 'm'
                if (u.startsWith('s')) return n
                if (u.startsWith('h')) return n*3600
                return n*60
            }

            if (command === 'setwarnlimit' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const n = parseInt(args[0],10)
                if (!n || n < 1 || n > 20) return sendReply(sock, from, { text: `❌ Uso: ${prefix}setwarnlimit 3` }, { quoted: m })
                getGrupoCfg(from).warnLimit = n
                guardarGruposConfig()
                return sendReply(sock, from, { text: `✅ Límite de warns: *${n}*` }, { quoted: m })
            }
            if (command === 'adminonly' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                const arg = (args[0]||'').toLowerCase()
                if (['on','1'].includes(arg)) gcfg.adminOnly = true
                else if (['off','0'].includes(arg)) gcfg.adminOnly = false
                else gcfg.adminOnly = !gcfg.adminOnly
                guardarGruposConfig()
                return sendReply(sock, from, { text: `🔒 Solo admins pueden usar comandos: *${gcfg.adminOnly ? 'ON' : 'OFF'}*` }, { quoted: m })
            }
            if (command === 'setgpname' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                if (!isBotAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Necesito ser admin.', '❌ Preciso ser admin.', '❌ I need to be admin.') }, { quoted: m })
                const nom = (typeof text==='string' && text) ? text : args.join(' ')
                if (!nom) return sendReply(sock, from, { text: `❌ Uso: ${prefix}setgpname nombre` }, { quoted: m })
                await sock.groupUpdateSubject(from, nom.slice(0, 25))
                return sendReply(sock, from, { text: '✅ Nombre del grupo actualizado.' }, { quoted: m })
            }
            if (command === 'setgpdesc' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                if (!isBotAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Necesito ser admin.', '❌ Preciso ser admin.', '❌ I need to be admin.') }, { quoted: m })
                const desc = (typeof text==='string' && text) ? text : args.join(' ')
                if (!desc) return sendReply(sock, from, { text: `❌ Uso: ${prefix}setgpdesc texto` }, { quoted: m })
                await sock.groupUpdateDescription(from, desc.slice(0, 500))
                return sendReply(sock, from, { text: '✅ Descripción actualizada.' }, { quoted: m })
            }
            if (command === 'setgpbanner' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                if (!isBotAdmin) return sendReply(sock, from, { text: tr(lang, '❌ Necesito ser admin.', '❌ Preciso ser admin.', '❌ I need to be admin.') }, { quoted: m })
                try {
                    let mediaMessage = m.message.imageMessage ? m : armarMensajeCitado(m)
                    if (!mediaMessage || !mediaMessage.message || !mediaMessage.message.imageMessage) {
                        return sendReply(sock, from, { text: `❌ Mandá o respondé una imagen con ${prefix}setgpbanner` }, { quoted: m })
                    }
                    const buffer = await downloadMediaMessage(mediaMessage, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
                    await sock.updateProfilePicture(from, buffer)
                    return sendReply(sock, from, { text: '✅ Foto del grupo actualizada.' }, { quoted: m })
                } catch (e) {
                    return sendReply(sock, from, { text: `❌ ${e.message || e}` }, { quoted: m })
                }
            }
            if (command === 'topcount' && isGroup) {
                const gcfg = getGrupoCfg(from)
                const top = Object.entries(gcfg.msgCounts||{}).sort((a,b)=>b[1]-a[1]).slice(0,10)
                if (!top.length) return sendReply(sock, from, { text: 'Todavía no hay conteo de mensajes.' }, { quoted: m })
                const lines = top.map(([id,n],i)=>`${i+1}. @${id.split('@')[0]} · ${n}`)
                return sendReply(sock, from, { text: `📊 *Top mensajes*\n\n${lines.join('\n')}`, mentions: top.map(x=>x[0]) }, { quoted: m })
            }
            if (command === 'setprimary' && isGroup) {
                return sendReply(sock, from, { text: 'Wolfric es el único socket de este número. No hay bot primario/secundario.' }, { quoted: m })
            }
            if (command === 'clear' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const modo = (args[0]||'views').toLowerCase()
                const gcfg = getGrupoCfg(from)
                const meta = await sock.groupMetadata(from)
                const now = Date.now()
                const lim = 30*24*60*60*1000
                if (modo === 'views' || modo === 'ver') {
                    const filas = meta.participants.map(p=>{
                        const seen = gcfg.lastSeen[p.id]
                        const msgs = gcfg.msgCounts[p.id]||0
                        const estado = !seen ? 'sin datos' : (now-seen>lim ? 'inactivo +30d' : 'activo')
                        return `@${p.id.split('@')[0]} · ${msgs} msg · ${estado}`
                    }).slice(0,30)
                    return sendReply(sock, from, { text: `👁 *Actividad (muestra)*\n\n${filas.join('\n')}`, mentions: meta.participants.slice(0,30).map(p=>p.id) }, { quoted: m })
                }
                if (modo === 'delete' || modo === 'kick') {
                    if (!isBotAdmin) return sendReply(sock, from, { text: '❌ Necesito ser admin.' }, { quoted: m })
                    const sacar = meta.participants.filter(p=>{
                        if (p.admin) return false
                        const seen = gcfg.lastSeen[p.id]
                        return seen && (now-seen>lim)
                    }).map(p=>p.id)
                    if (!sacar.length) return sendReply(sock, from, { text: 'Nadie con +30 días inactivo (y dato de actividad).' }, { quoted: m })
                    await sock.groupParticipantsUpdate(from, sacar.slice(0,20), 'remove')
                    return sendReply(sock, from, { text: `✅ Intenté sacar ${Math.min(20,sacar.length)} inactivos.` }, { quoted: m })
                }
                return sendReply(sock, from, { text: `Uso: ${prefix}clear views | ${prefix}clear delete` }, { quoted: m })
            }

            if (command === 'antispam' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                const arg = (args[0] || '').toLowerCase()
                if (['on', '1'].includes(arg)) gcfg.antispam = true
                else if (['off', '0'].includes(arg)) gcfg.antispam = false
                else gcfg.antispam = !gcfg.antispam
                guardarGruposConfig()
                return sendReply(sock, from, { text: tr(lang, `🚫 Anti-spam: *${gcfg.antispam ? 'ON' : 'OFF'}*`, `🚫 Anti-spam: *${gcfg.antispam ? 'ON' : 'OFF'}*`, `🚫 Anti-spam: *${gcfg.antispam ? 'ON' : 'OFF'}*`) }, { quoted: m })
            }

            if (command === 'grupo' && isGroup) {
                const gcfg = getGrupoCfg(from)
                return sendReply(sock, from, { text: tr(lang, `🛡️ *Estado del grupo*\n\n🔗 Anti-link: *${gcfg.antilink ? 'ON' : 'OFF'}*\n🚫 Anti-spam: *${gcfg.antispam ? 'ON' : 'OFF'}*\n👋 Bienvenida: *${gcfg.welcome ? 'ON' : 'OFF'}*\n🚪 Despedida: *${gcfg.goodbye ? 'ON' : 'OFF'}*`, `🛡️ *Estado do grupo*\n\n🔗 Anti-link: *${gcfg.antilink ? 'ON' : 'OFF'}*\n🚫 Anti-spam: *${gcfg.antispam ? 'ON' : 'OFF'}*\n👋 Boas-vindas: *${gcfg.welcome ? 'ON' : 'OFF'}*\n🚪 Despedida: *${gcfg.goodbye ? 'ON' : 'OFF'}*`, `🛡️ *Estado del group*\n\n🔗 Anti-link: *${gcfg.antilink ? 'ON' : 'OFF'}*\n🚫 Anti-spam: *${gcfg.antispam ? 'ON' : 'OFF'}*\n👋 Bienvenida: *${gcfg.welcome ? 'ON' : 'OFF'}*\n🚪 Despedida: *${gcfg.goodbye ? 'ON' : 'OFF'}*`) }, { quoted: m })
            }

            if (command === 'backup' && isOwner) {
                backupEconomiaAhora()
                return sendReply(sock, from, { text: tr(lang, '✅ Backup de economia.json guardado en ./backups/', '✅ Backup de economia.json salvo em ./backups/', '✅ Backup de economia.json guardado en ./backups/') }, { quoted: m })
            }

            if (command === 'setcanal' && isOwner) {
                if (!text) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}setcanal https://whatsapp.com/channel/XXXX`, `❌ Uso: ${prefix}setchannel https://whatsapp.com/channel/XXXX`, `❌ Usage: ${prefix}setchannel https://whatsapp.com/channel/XXXX`) }, { quoted: m })
                const url = text.trim().split(/\s+/)[0]
                if (!/^https?:\/\//i.test(url)) {
                    return sendReply(sock, from, { text: tr(lang, '❌ El link debe empezar con https://', '❌ O link deve começar com https://', '❌ El link debe empezar con https://') }, { quoted: m })
                }
                botConfig.channelUrl = url
                const resto = text.trim().slice(url.length).trim()
                if (resto) botConfig.channelName = resto.slice(0, 40)
                guardarBotConfig()
                return sendReply(sock, from, {
                    text: `${wolfricTitulo(tr(lang,'CANAL CONFIGURADO','CANAL CONFIGURADO','CHANNEL SET'), botConfig.channelName || tr(lang,'Canal','Canal','Channel'), '📢')}\n\n${frontierPanel('DETALLE', [botConfig.channelUrl, 'Probalo con *.canal* o *.botones*'], '✅')}`
                }, { quoted: m })
            }

            if (command === 'canal') {
                const ok = await enviarBotonCanal(sock, from, m)
                if (!ok) return
                return
            }

            if (command === 'setbotname' && isOwner) {
                if (!text) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}setbotname <nombre>`, `❌ Uso: ${prefix}setbotname <nome>`, `❌ Usage: ${prefix}setbotname <name>`) }, { quoted: m })
                botConfig.botName = text.slice(0, 40)
                guardarBotConfig()
                return sendReply(sock, from, { text: `${wolfricTitulo(tr(lang,'CONFIG ACTUALIZADA','CONFIG ATUALIZADA','CONFIG UPDATED'), tr(lang,'Nombre del bot','Nome do bot','Bot name'), '✦')}\n\n${frontierPanel('DETALLE', [`Nuevo nombre: *${botConfig.botName}*`], '✅')}` }, { quoted: m })
            }
            if (command === 'setbotemoji' && isOwner) {
                if (!text) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}setbotemoji <emoji>`, `❌ Uso: ${prefix}setbotemoji <emoji>`, `❌ Usage: ${prefix}setbotemoji <emoji>`) }, { quoted: m })
                botConfig.botEmoji = text.trim().slice(0, 8)
                guardarBotConfig()
                return sendReply(sock, from, { text: `${wolfricTitulo(tr(lang,'CONFIG ACTUALIZADA','CONFIG ATUALIZADA','CONFIG UPDATED'), tr(lang,'Emoji del bot','Emoji do bot','Bot emoji'), '✦')}\n\n${frontierPanel('DETALLE', [`Nuevo emoji: ${botConfig.botEmoji}`], '✅')}` }, { quoted: m })
            }
            if (command === 'setwelcome' && isOwner) {
                botConfig.welcomeMsg = text || ''
                guardarBotConfig()
                return sendReply(sock, from, { text: tr(lang, `${wolfricTitulo('CONFIG ACTUALIZADA', 'Mensaje de estado', '✦')}\n\n${frontierPanel('DETALLE', [botConfig.welcomeMsg || '(vacío)'], '✅')}`, `${wolfricTitulo('CONFIG ACTUALIZADA', 'Mensaje de estado', '✦')}\n\n${frontierPanel('DETALLE', [botConfig.welcomeMsg || '(vacío)'], '✅')}`, `${wolfricTitulo('CONFIG ACTUALIZADA', 'Mensaje de estado', '✦')}\n\n${frontierPanel('DETALLE', [botConfig.welcomeMsg || '(vacío)'], '✅')}`) }, { quoted: m })
            }
            if (command === 'botinfo') {
                return sendReply(sock, from, {
                    text: `${wolfricTitulo(tr(lang, 'INFO DEL BOT', 'INFO DO BOT', 'INFO DEL BOT'), botConfig.botName, botConfig.botEmoji)}\n\n${frontierPanel('CONFIG', [
                        tr(lang, `Nombre: *${botConfig.botName}*`, `Nome: *${botConfig.botName}*`, `Nombre: *${botConfig.botName}*`),
                        `Emoji: ${botConfig.botEmoji}`,
                        tr(lang, `Versión: *${botConfig.botVersion}*`, `Versão: *${botConfig.botVersion}*`, `Versión: *${botConfig.botVersion}*`),
                        tr(lang, `Prefijo: *${prefix}*`, `Prefixo: *${prefix}*`, `Prefix: *${prefix}*`),
                        tr(lang, `IA (Gemini): ${GEMINI_API_KEY ? 'configurada ✅' : 'sin configurar ❌'}`, `IA (Gemini): ${GEMINI_API_KEY ? 'configurada ✅' : 'sem configurar ❌'}`, `IA (Gemini): ${GEMINI_API_KEY ? 'configurada ✅' : 'sin configurar ❌'}`),
                        tr(lang, `Estado: ${botOn ? 'ON' : 'OFF'}`, `Estado: ${botOn ? 'ON' : 'OFF'}`, `Estado: ${botOn ? 'ON' : 'OFF'}`),
                        tr(lang, `Modo: ${modoPrivado ? 'Privado' : 'Público'}`, `Modo: ${modoPrivado ? 'Privado' : 'Público'}`, `Modo: ${modoPrivado ? 'Privado' : 'Público'}`),
                        botConfig.welcomeMsg ? `Nota: ${botConfig.welcomeMsg}` : 'Nota: —'
                    ], '⌁')}`
                }, { quoted: m })
            }

            // Cambiar foto de perfil del bot (owner): responde a una imagen con .setpp
            if (command === 'setpp' && isOwner) {
                try {
                    let mediaMessage = null
                    if (m.message.imageMessage) {
                        mediaMessage = m
                    } else {
                        const citado = armarMensajeCitado(m)
                        if (citado && citado.message.imageMessage) mediaMessage = citado
                    }
                    if (!mediaMessage) {
                        return sendReply(sock, from, {
                            text: `${wolfricTitulo(tr(lang,'FOTO DE PERFIL','FOTO DE PERFIL','PROFILE PHOTO'), tr(lang,'Falta la imagen','Falta a imagem','Image missing'), '🖼')}\n\n${frontierPanel('CÓMO USAR', [
                                `Enviá una imagen con *${prefix}setpp* de caption`,
                                `O respondé a una imagen con *${prefix}setpp*`
                            ], '✦')}`
                        }, { quoted: m })
                    }
                    const buffer = await downloadMediaMessage(mediaMessage, 'buffer', {}, {
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    })
                    const jidBot = sock.user?.id || sock.user?.lid
                    if (!jidBot) throw new Error('No se pudo obtener el JID del bot')
                    await sock.updateProfilePicture(jidBot, buffer)
                    return sendReply(sock, from, {
                        text: `${wolfricTitulo(tr(lang,'FOTO ACTUALIZADA','FOTO ATUALIZADA','PHOTO UPDATED'), botConfig.botName, '✅')}\n\n${frontierPanel('DETALLE', ['La foto de perfil del bot se cambió correctamente.'], '🖼')}`
                    }, { quoted: m })
                } catch (e) {
                    console.log('Error setpp:', e)
                    const msg = String(e.message || e)
                    const hint = /image processing library|jimp|sharp/i.test(msg)
                        ? 'En Termux corre: npm install jimp --no-bin-links'
                        : msg
                    return sendReply(sock, from, {
                        text: `${wolfricTitulo(tr(lang,'ERROR','ERRO','ERROR'), tr(lang,'No se pudo cambiar la foto','Não deu pra trocar a foto','Could not change the photo'), '❌')}\n\n${frontierPanel('DETALLE', [hint], '⚠')}`
                    }, { quoted: m })
                }
            }

            // Cambiar nombre visible de WhatsApp del bot (owner)
            if (command === 'setnamewa' && isOwner) {
                if (!text) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}setnamewa <nombre>`, `❌ Uso: ${prefix}setnamewa <nome>`, `❌ Usage: ${prefix}setnamewa <name>`) }, { quoted: m })
                try {
                    await sock.updateProfileName(text.slice(0, 25))
                    botConfig.botName = text.slice(0, 40)
                    guardarBotConfig()
                    return sendReply(sock, from, {
                        text: `${wolfricTitulo(tr(lang,'NOMBRE WA ACTUALIZADO','NOME WA ATUALIZADO','WA NAME UPDATED'), text.slice(0, 25), '✅')}\n\n${frontierPanel('DETALLE', ['Nombre de WhatsApp del bot cambiado.'], '✦')}`
                    }, { quoted: m })
                } catch (e) {
                    return sendReply(sock, from, { text: tr(lang, `❌ No pude cambiar el nombre: ${e.message || e}`, `❌ Não consegui mudar o nome: ${e.message || e}`, `❌ Couldn't cambiar el name: ${e.message || e}`) }, { quoted: m })
                }
            }

            // ====================== SOCKET / SUBBOT (1 instancia) ======================
            if (command === 'bots' || command === 'sockets') {
                const id = sock.user?.id || sock.user?.lid || '—'
                return sendReply(sock, from, { text:
                    `${wolfricTitulo('SOCKETS', 'Instancia Wolfric', '📡')}\n\n${frontierPanel('ESTADO', [
                        'Sockets activos: *1*',
                        `JID: ${id}`,
                        `Modo: ${modoPrivado ? 'privado' : 'público'}`,
                        'Premium/Mod: no aplica (bot propio, no panel Diamond)'
                    ], '✦')}`
                }, { quoted: m })
            }
            if (command === 'code' || command === 'qr') {
                return sendReply(sock, from, { text:
                    `${wolfricTitulo('VINCULAR', 'Este socket ya corre acá', '🔗')}\n\n${frontierPanel('CÓMO', [
                        'Wolfric no es un panel multi-bot.',
                        'El código/QR se pide al arrancar en Termux (opción 2).',
                        'Para otro número: otra carpeta / otra sesión.'
                    ], '✦')}`
                }, { quoted: m })
            }
            if (command === 'self' && isOwner) {
                if ((args[0] || '').toLowerCase() === 'off') modoPrivado = false
                else if ((args[0] || '').toLowerCase() === 'on') modoPrivado = true
                else modoPrivado = !modoPrivado
                return sendReply(sock, from, { text: `🔒 Socket: ${modoPrivado ? 'privado' : 'público'}` }, { quoted: m })
            }
            if ((command === 'setbanner' || command === 'setmenubanner') && isOwner) {
                try {
                    let mediaMessage = m.message.imageMessage ? m : armarMensajeCitado(m)
                    if (!mediaMessage || !mediaMessage.message || !mediaMessage.message.imageMessage) {
                        return sendReply(sock, from, { text: `❌ Mandá o respondé una imagen con ${prefix}setbanner` }, { quoted: m })
                    }
                    const buffer = await downloadMediaMessage(mediaMessage, 'buffer', {}, {
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    })
                    fs.writeFileSync(path.join(process.cwd(), 'menu.jpg'), buffer)
                    return sendReply(sock, from, { text: '✅ Banner del menú actualizado.' }, { quoted: m })
                } catch (e) {
                    return sendReply(sock, from, { text: '❌ No pude guardar el banner.' }, { quoted: m })
                }
            }
            if ((command === 'join' || command === 'unir') && isOwner) {
                const raw = (typeof text === 'string' && text) ? text : args.join(' ')
                const m1 = String(raw).match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/)
                const inv = m1 ? m1[1] : String(raw).trim()
                if (!inv) return sendReply(sock, from, { text: `❌ Uso: ${prefix}join <enlace>` }, { quoted: m })
                try {
                    const gid = await sock.groupAcceptInvite(inv)
                    return sendReply(sock, from, { text: `✅ Entré al grupo.\n${gid || ''}` }, { quoted: m })
                } catch (e) {
                    return sendReply(sock, from, { text: `❌ No pude unirme: ${e.message || e}` }, { quoted: m })
                }
            }
            if (command === 'leave' && from.endsWith('@g.us')) {
                if (!isOwner) return sendReply(sock, from, { text: '❌ Solo el owner puede sacar el bot.' }, { quoted: m })
                await sendReply(sock, from, { text: '👋 Saliendo.' }, { quoted: m })
                try { await sock.groupLeave(from) } catch (e) {
                    return sendReply(sock, from, { text: `❌ ${e.message || e}` }, { quoted: m })
                }
                return
            }
            if (command === 'setbotcurrency' && isOwner) {
                const val = (typeof text === 'string' && text) ? text : args.join(' ')
                if (!val) return sendReply(sock, from, { text: `❌ Uso: ${prefix}setbotcurrency monedas` }, { quoted: m })
                botConfig.currencyName = val.slice(0, 20)
                guardarBotConfig()
                return sendReply(sock, from, { text: `✅ Moneda: *${botConfig.currencyName}*` }, { quoted: m })
            }
            if ((command === 'setbotlink' || command === 'setlink') && isOwner) {
                const val = (typeof text === 'string' && text) ? text : args.join(' ')
                if (!val) return sendReply(sock, from, { text: `❌ Uso: ${prefix}setbotlink https://...` }, { quoted: m })
                botConfig.channelUrl = val.slice(0, 200)
                guardarBotConfig()
                return sendReply(sock, from, { text: `✅ Link: ${botConfig.channelUrl}` }, { quoted: m })
            }
            if (command === 'setstatus' && isOwner) {
                const val = (typeof text === 'string' && text) ? text : args.join(' ')
                if (!val) return sendReply(sock, from, { text: `❌ Uso: ${prefix}setstatus texto` }, { quoted: m })
                try {
                    await sock.updateProfileStatus(val.slice(0, 139))
                    return sendReply(sock, from, { text: '✅ Estado de WhatsApp actualizado.' }, { quoted: m })
                } catch (e) {
                    return sendReply(sock, from, { text: `❌ ${e.message || e}` }, { quoted: m })
                }
            }
            if (command === 'reload' && isOwner) {
                await sendReply(sock, from, { text: '🔄 Reiniciando el proceso. Si no usás pm2, arrancalo de nuevo a mano.' }, { quoted: m })
                setTimeout(() => process.exit(1), 400)
                return
            }
            if (command === 'logout' && isOwner) {
                await sendReply(sock, from, { text: '🚪 Cerrando sesión. Después borra la carpeta sesion/ y vinculá de nuevo.' }, { quoted: m })
                try { await sock.logout() } catch (_) {}
                setTimeout(() => process.exit(0), 500)
                return
            }

            // ====================== INTERACCIÓN ======================
            // Acción social genérica (abrazo, cachetada, etc.): misma mecánica que .hug/.dance, pero
            // reutilizable para no repetir el mismo bloque 10 veces. El gif va DENTRO del mismo mensaje (caption).
            async function accionSocial(emoji, verboEs, verboPt, gifQuery) {
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, '❌ Etiquetá a alguien.', '❌ Marque alguém.', '❌ Tag someone.') }, { quoted: m })
                const texto = tr(lang, `${emoji} *${pushName}* ${verboEs} @${mentioned[0].split('@')[0]}`, `${emoji} *${pushName}* ${verboPt} @${mentioned[0].split('@')[0]}`, `${emoji} *${pushName}* ${verboEs} @${mentioned[0].split('@')[0]}`)
                await enviarConGif(sock, from, texto, gifQuery, [sender, mentioned[0]], { quoted: m })
            }

            if (command === 'hug') {
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, '❌ Etiquetá a alguien.', '❌ Marque alguém.', '❌ Tag someone.') }, { quoted: m })
                const texto = tr(lang, `🤗 *${pushName}* le dio un fuerte abrazo a @${mentioned[0].split('@')[0]}`, `🤗 *${pushName}* deu um abraço em @${mentioned[0].split('@')[0]}`, `🤗 *${pushName}* le dio un fuerte abrazo a @${mentioned[0].split('@')[0]}`)
                await enviarConGif(sock, from, texto, 'anime hug', [sender, mentioned[0]], { quoted: m })
            }

            if (command === 'kiss') {
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, '❌ Etiquetá a alguien.', '❌ Marque alguém.', '❌ Tag someone.') }, { quoted: m })
                const texto = tr(lang, `😘 *${pushName}* le dio un beso a @${mentioned[0].split('@')[0]}`, `😘 *${pushName}* deu um beijo em @${mentioned[0].split('@')[0]}`, `😘 *${pushName}* le dio un beso a @${mentioned[0].split('@')[0]}`)
                await enviarConGif(sock, from, texto, 'anime kiss', [sender, mentioned[0]], { quoted: m })
            }

            if (command === 'punch') {
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, '❌ Etiquetá a alguien.', '❌ Marque alguém.', '❌ Tag someone.') }, { quoted: m })
                const texto = tr(lang, `👊 *${pushName}* golpeó a @${mentioned[0].split('@')[0]}`, `👊 *${pushName}* bateu em @${mentioned[0].split('@')[0]}`, `👊 *${pushName}* golpeó a @${mentioned[0].split('@')[0]}`)
                await enviarConGif(sock, from, texto, 'anime punch', [sender, mentioned[0]], { quoted: m })
            }

            if (command === 'pet') {
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, '❌ Etiquetá a alguien.', '❌ Marque alguém.', '❌ Tag someone.') }, { quoted: m })
                const texto = tr(lang, `🐾 *${pushName}* acarició a @${mentioned[0].split('@')[0]}`, `🐾 *${pushName}* fez carinho em @${mentioned[0].split('@')[0]}`, `🐾 *${pushName}* acarició a @${mentioned[0].split('@')[0]}`)
                await enviarConGif(sock, from, texto, 'anime pat head', [sender, mentioned[0]], { quoted: m })
            }

            if (command === 'dance') {
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, '❌ Etiquetá a alguien.', '❌ Marque alguém.', '❌ Tag someone.') }, { quoted: m })
                const texto = tr(lang, `💃 *${pushName}* está bailando con @${mentioned[0].split('@')[0]}`, `💃 *${pushName}* está dançando com @${mentioned[0].split('@')[0]}`, `💃 *${pushName}* está bailando con @${mentioned[0].split('@')[0]}`)
                await enviarConGif(sock, from, texto, 'anime dance', [sender, mentioned[0]], { quoted: m })
            }

            // ---- Acciones sociales nuevas (mismo patrón, con gif de GIPHY dentro del mismo mensaje) ----
            if (command === 'slap') await accionSocial('👋', 'le pegó una cachetada a', 'deu um tapa em', 'anime slap')
            if (command === 'bite') await accionSocial('😬', 'le mordió el brazo a', 'mordeu', 'anime bite')
            if (command === 'cuddle') await accionSocial('🥰', 'se acurrucó con', 'se aconchegou com', 'anime cuddle')
            if (command === 'highfive') await accionSocial('🙌', 'chocó los cinco con', 'bateu os cinco com', 'anime high five')
            if (command === 'poke') await accionSocial('👉', 'le picó el costado a', 'cutucou', 'anime poke')
            if (command === 'stare') await accionSocial('👀', 'se quedó mirando fijo a', 'ficou encarando', 'anime stare')
            if (command === 'tickle') await accionSocial('🤣', 'le hizo cosquillas a', 'fez cócegas em', 'anime tickle')
            if (command === 'wave') await accionSocial('👋', 'saludó con la mano a', 'acenou para', 'anime wave hello')
            if (command === 'feed') await accionSocial('🍽️', 'le dio de comer a', 'deu comida para', 'anime feed')
            if (command === 'handhold') await accionSocial('🤝', 'le agarró la mano a', 'deu as mãos com', 'anime holding hands')
            if (command === 'cry') await accionSocial('😢', 'lloró en el hombro de', 'chorou no ombro de', 'anime crying hug')
            if (command === 'stab') await accionSocial('🔪', 'apuñaló (de mentira) a', 'esfaqueou (de brincadeira)', 'anime stab funny')

            if (command === 'peek') await accionSocial('👀', 'espió a', 'espiou', 'anime peek')
            if (command === 'comfort') await accionSocial('🤍', 'consoló a', 'consolou', 'anime comfort hug')
            if (command === 'thinkhard' || command === 'think') await accionSocial('🧠', 'se puso a pensar por', 'ficou pensando por', 'anime thinking')
            if (command === 'curious') await accionSocial('❓', 'miró con cara de duda a', 'ficou curioso com', 'anime curious')
            if (command === 'trip') await accionSocial('🤕', 'se tropezó contra', 'tropeçou em', 'anime trip fall')
            if (command === 'angry') await accionSocial('😠', 'se enojó con', 'ficou bravo com', 'anime angry')
            if (command === 'bleh') await accionSocial('😛', 'le sacó la lengua a', 'mostrou a lingua para', 'anime tongue out')
            if (command === 'bored' || command === 'aburrido') await accionSocial('😑', 'se aburrió con', 'ficou entediado com', 'anime bored')
            if (command === 'clap') await accionSocial('👏', 'le aplaudió a', 'aplaudiu', 'anime clap')
            if (command === 'coffee' || command === 'cafe') await accionSocial('☕', 'tomó café con', 'tomou cafe com', 'anime coffee')
            if (command === 'cold') await accionSocial('🥶', 'sintió frío al lado de', 'sentiu frio com', 'anime cold shiver')
            if (command === 'sing') await accionSocial('🎤', 'le cantó a', 'cantou para', 'anime singing')
            if (command === 'scream') await accionSocial('😱', 'le gritó a', 'gritou com', 'anime scream')
            if (command === 'push') await accionSocial('✋', 'empujó a', 'empurrou', 'anime push')
            if (command === 'nope') await accionSocial('🙅', 'le dijo que no a', 'disse nao para', 'anime no')
            if (command === 'jump' || command === 'happy' || command === 'feliz') await accionSocial('🎉', 'saltó de alegría con', 'pulou de alegria com', 'anime jump happy')
            if (command === 'heat') await accionSocial('🥵', 'sintió calor al lado de', 'sentiu calor com', 'anime hot weather')
            if (command === 'gaming') await accionSocial('🎮', 'se puso a jugar con', 'jogou com', 'anime gaming')
            if (command === 'draw') await accionSocial('✏️', 'dibujó junto a', 'desenhou com', 'anime drawing')
            if (command === 'call') await accionSocial('📞', 'llamó a', 'ligou para', 'anime phone call')
            if (command === 'dramatic' || command === 'drama') await accionSocial('🎭', 'le armó un drama a', 'fez drama com', 'anime dramatic')
            if (command === 'laugh') await accionSocial('😂', 'se rio con', 'riu com', 'anime laugh')
            if (command === 'pout') await accionSocial('😤', 'le hizo pucheros a', 'fez bico para', 'anime pout')
            if (command === 'run' || command === 'correr') await accionSocial('🏃', 'salió corriendo de', 'correu de', 'anime run')
            if (command === 'sad' || command === 'triste') await accionSocial('😢', 'se puso triste con', 'ficou triste com', 'anime sad')
            if (command === 'scared') await accionSocial('😨', 'se asustó por', 'ficou com medo de', 'anime scared')
            if (command === 'shy' || command === 'timido') await accionSocial('😳', 'se puso tímido con', 'ficou timido com', 'anime shy')
            if (command === 'sleep') await accionSocial('😴', 'se durmió al lado de', 'dormiu perto de', 'anime sleep')
            if (command === 'walk') await accionSocial('🚶', 'caminó con', 'caminhou com', 'anime walk')
            if (command === 'eat' || command === 'nom' || command === 'comer') await accionSocial('🍜', 'comió con', 'comeu com', 'anime eating')
            if (command === 'wink') await accionSocial('😉', 'le guiñó a', 'piscou para', 'anime wink')
            if (command === 'blush') await accionSocial('😊', 'se sonrojó por', 'corou por', 'anime blush')
            if (command === 'bath') await accionSocial('🛁', 'fue a bañarse y saludó a', 'foi tomar banho e acenou para', 'anime bath cute')
            if (command === 'smug') await accionSocial('😏', 'le hizo cara de superior a', 'ficou convencido com', 'anime smug')
            if (command === 'smile') await accionSocial('😄', 'le sonrió a', 'sorriu para', 'anime smile')
            if (command === 'cringe') await accionSocial('😖', 'sintió cringe por', 'sentiu cringe com', 'anime cringe')
            if (command === 'bonk') await accionSocial('🔨', 'le dio un bonk a', 'deu um bonk em', 'anime bonk')

            if (command === 'ship') {
                const mentioned = getMentioned()
                if (mentioned.length < 2) return sendReply(sock, from, { text: tr(lang, '❌ Etiquetá a dos personas.', '❌ Marque duas pessoas.', '❌ Tag two people.') }, { quoted: m })
                const porcentaje = Math.floor(Math.random() * 100) + 1
                await sendReply(sock, from, { text: tr(lang, `💘 *Ship*\n\n@${mentioned[0].split('@')[0]}  +  @${mentioned[1].split('@')[0]}\n\n❤️ Compatibilidad: *${porcentaje}%*`, `💘 *Ship*\n\n@${mentioned[0].split('@')[0]}  +  @${mentioned[1].split('@')[0]}\n\n❤️ Compatibilidade: *${porcentaje}%*`, `💘 *Ship*\n\n@${mentioned[0].split('@')[0]}  +  @${mentioned[1].split('@')[0]}\n\n❤️ Compatibilidad: *${porcentaje}%*`), mentions: mentioned }, { quoted: m })
            }

            if (command === 'gay') {
                const mentioned = getMentioned()
                const target = mentioned.length ? mentioned[0] : sender
                const porcentaje = Math.floor(Math.random() * 100) + 1
                await sendReply(sock, from, { text: tr(lang, `🌈 @${target.split('@')[0]} es *${porcentaje}%* gay`, `🌈 @${target.split('@')[0]} é *${porcentaje}%* gay`, `🌈 @${target.split('@')[0]} es *${porcentaje}%* gay`), mentions: [target] }, { quoted: m })
            }

            if (command === 'dice') {
                const numero = Math.floor(Math.random() * 6) + 1
                await sendReply(sock, from, { text: tr(lang, `🎲 *${pushName}* lanzó el dado y salió: *${numero}*`, `🎲 *${pushName}* jogou o dado e saiu: *${numero}*`, `🎲 *${pushName}* lanzó el dado y salió: *${numero}*`) }, { quoted: m })
            }

            if (command === 'gif') {
                const busqueda = args.join(' ')
                if (!busqueda) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}gif <búsqueda>\nEj: ${prefix}gif goku poder`, `❌ Uso: ${prefix}gif <búsqueda>\nEj: ${prefix}gif goku poder`, `❌ Usage: ${prefix}gif <búsqueda>\nEj: ${prefix}gif goku poder`) }, { quoted: m })
                if (!GIPHY_API_KEY) return sendReply(sock, from, { text: tr(lang, '❌ Los gifs todavía no están configurados (falta la API key de GIPHY).', '❌ Os gifs ainda não estão configurados (falta a API key do GIPHY).', '❌ GIFs are not set up yet (missing GIPHY API key).') }, { quoted: m })
                const enviado = await enviarGif(sock, from, busqueda, `🔎 *${busqueda}*`, { quoted: m })
                if (!enviado) return sendReply(sock, from, { text: tr(lang, '❌ No encontré ningún gif para eso, probá con otra palabra.', '❌ Não encontrei nenhum gif para isso, tente outra palavra.', '❌ No encontré ningún gif para eso, probá con otra palabra.') }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: MINIJUEGOS Y UTILIDADES SOCIALES ======================
            if (command === 'truth' || command === 'verdad') {
                const preguntas = lang === 'pt' ? PREGUNTAS_VERDAD.pt : lang === 'en' ? PREGUNTAS_VERDAD.en : PREGUNTAS_VERDAD.es
                await sendReply(sock, from, { text: `🤐 *${tr(lang, 'Verdad', 'Verdade', 'Truth')}:* ${preguntas[Math.floor(Math.random() * preguntas.length)]}` }, { quoted: m })
            }

            if (command === 'dare' || command === 'reto') {
                const retos = lang === 'pt' ? RETOS_DARE.pt : lang === 'en' ? RETOS_DARE.en : RETOS_DARE.es
                await sendReply(sock, from, { text: `🔥 *${tr(lang, 'Reto', 'Desafio', 'Dare')}:* ${retos[Math.floor(Math.random() * retos.length)]}` }, { quoted: m })
            }

            if (command === 'compliment' || command === 'cumplido') {
                const mentioned = getMentioned()
                const target = mentioned.length ? mentioned[0] : sender
                const frases = lang === 'pt' ? CUMPLIDOS.pt : lang === 'en' ? CUMPLIDOS.en : CUMPLIDOS.es
                const frase = frases[Math.floor(Math.random() * frases.length)].replace('{user}', `@${target.split('@')[0]}`)
                await sendReply(sock, from, { text: `💖 ${frase}`, mentions: [target] }, { quoted: m })
            }

            if (command === 'insult' || command === 'insulto') {
                const mentioned = getMentioned()
                const target = mentioned.length ? mentioned[0] : sender
                const frases = lang === 'pt' ? INSULTOS_JOCOSOS.pt : lang === 'en' ? INSULTOS_JOCOSOS.en : INSULTOS_JOCOSOS.es
                const frase = frases[Math.floor(Math.random() * frases.length)].replace('{user}', `@${target.split('@')[0]}`)
                await sendReply(sock, from, { text: `😹 ${frase}`, mentions: [target] }, { quoted: m })
            }

            if (command === 'flirt' || command === 'coqueteo') {
                const mentioned = getMentioned()
                const target = mentioned.length ? mentioned[0] : sender
                const frases = lang === 'pt' ? FRASES_FLIRT.pt : lang === 'en' ? FRASES_FLIRT.en : FRASES_FLIRT.es
                const frase = frases[Math.floor(Math.random() * frases.length)].replace('{user}', `@${target.split('@')[0]}`)
                await sendReply(sock, from, { text: `😏 ${frase}`, mentions: [target] }, { quoted: m })
            }

            if (command === 'weather' || command === 'clima') {
                const ciudad = args.join(' ')
                if (!ciudad) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}clima <ciudad>`, `❌ Uso: ${prefix}clima <cidade>`, `❌ Usage: ${prefix}weather <city>`) }, { quoted: m })
                try {
                    const res = await fetch(`https://wttr.in/${encodeURIComponent(ciudad)}?format=%l:+%c+%t+(feels+%f)+%h+humidity,+%w+wind&lang=${lang}`)
                    const texto = (await res.text()).trim()
                    if (!texto || texto.toLowerCase().includes('unknown location')) throw new Error('no encontrado')
                    await sendReply(sock, from, { text: `🌤️ ${texto}` }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: tr(lang, `❌ No pude encontrar el clima de "${ciudad}".`, `❌ Não consegui encontrar o clima de "${ciudad}".`, `❌ Couldn't find the weather for "${ciudad}".`) }, { quoted: m })
                }
                return
            }

            if (command === 'tts') {
                const textoTts = args.join(' ')
                if (!textoTts) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}tts <texto>`, `❌ Uso: ${prefix}tts <texto>`, `❌ Usage: ${prefix}tts <text>`) }, { quoted: m })
                if (textoTts.length > 200) return sendReply(sock, from, { text: tr(lang, '❌ Máximo 200 caracteres.', '❌ Máximo 200 caracteres.', '❌ 200 characters max.') }, { quoted: m })
                try {
                    const idiomaTts = lang === 'pt' ? 'pt' : lang === 'en' ? 'en' : 'es'
                    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(textoTts)}&tl=${idiomaTts}&client=tw-ob`
                    const res = await fetch(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Referer': 'https://translate.google.com/',
                            'Accept': 'audio/mpeg'
                        }
                    })
                    if (!res.ok) throw new Error('tts http ' + res.status)
                    const buf = Buffer.from(await res.arrayBuffer())
                    if (!buf || buf.length < 400) throw new Error('tts vacio')
                    const id = crypto.randomBytes(6).toString('hex')
                    const inFile = path.join(os.tmpdir(), `tts-${id}.mp3`)
                    const outFile = path.join(os.tmpdir(), `tts-${id}.ogg`)
                    fs.writeFileSync(inFile, buf)
                    try {
                        await execFileAsync('ffmpeg', ['-y', '-i', inFile, '-vn', '-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', outFile], { timeout: 30000 })
                        const opus = fs.readFileSync(outFile)
                        await sock.sendMessage(from, { audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: m })
                    } finally {
                        try { fs.unlinkSync(inFile) } catch (_) {}
                        try { fs.unlinkSync(outFile) } catch (_) {}
                    }
                } catch (e) {
                    console.log('Error tts:', e && e.message ? e.message : e)
                    await sendReply(sock, from, { text: tr(lang, '❌ No se pudo generar el audio ahora.', '❌ Não foi possível gerar o áudio agora.', '❌ Could not generate the audio right now.') }, { quoted: m })
                }
                return
            }

            if (command === 'imagine' || command === 'imaginar' || command === 'dalle') {
                const promptImg = args.join(' ')
                if (!promptImg) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}imaginar <descripción>`, `❌ Uso: ${prefix}imaginar <descrição>`, `❌ Usage: ${prefix}imagine <description>`) }, { quoted: m })
                await sendReply(sock, from, { text: tr(lang, '🎨 Generando tu imagen, esperá unos segundos...', '🎨 Gerando sua imagem, aguarde uns segundos...', '🎨 Generating your image, wait a few seconds...') }, { quoted: m })
                try {
                    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptImg)}?width=768&height=768&nologo=true`
                    const res = await fetch(url)
                    if (!res.ok) throw new Error('fail')
                    const buf = Buffer.from(await res.arrayBuffer())
                    await sock.sendMessage(from, { image: buf, caption: `🎨 "${promptImg}"` }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: tr(lang, '❌ No se pudo generar la imagen ahora, probá de nuevo en un rato.', '❌ Não foi possível gerar a imagem agora, tente de novo daqui a pouco.', '❌ Could not generate the image right now, try again in a bit.') }, { quoted: m })
                }
            }

            // .lyrics siempre busca canción. .letra solo busca canción si NO hay ahorcado activo
            // (si hay ahorcado, .letra es para adivinar y se atiende más abajo).
            if (command === 'lyrics' || (command === 'letra' && !juegosAhorcado.has(from))) {
                const cancion = args.join(' ')
                if (!cancion) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}lyrics <canción>\nPara el ahorcado: ${prefix}ahorcado y después ${prefix}letra <letra>`, `❌ Uso: ${prefix}lyrics <música>\nPara a forca: ${prefix}ahorcado e depois ${prefix}letra <letra>`, `❌ Usage: ${prefix}lyrics <song>\nFor hangman: ${prefix}ahorcado then ${prefix}letra <letter>`) }, { quoted: m })
                try {
                    const res = await fetch(`https://lyricsapi.fly.dev/api/lyrics?q=${encodeURIComponent(cancion)}`)
                    if (!res.ok) throw new Error('fail')
                    const data = await res.json()
                    const letra = data?.result?.lyrics
                    if (!letra) throw new Error('sin letra')
                    const maxChars = 3500
                    const salida = letra.length > maxChars ? letra.slice(0, maxChars) + '...' : letra
                    await sendReply(sock, from, { text: `🎤 *${cancion}*\n\n${salida}` }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: tr(lang, `❌ No encontré la letra de "${cancion}".`, `❌ Não encontrei a letra de "${cancion}".`, `❌ Couldn't find lyrics for "${cancion}".`) }, { quoted: m })
                }
                return
            }

            // ---- Ta-Te-Ti (tictactoe) ----
            if ((command === 'ttt' || command === 'tatetiti') && !/^[1-9]$/.test((args[0] || ''))) {
                const mentioned = getMentioned()
                if (juegosTTT.has(from)) return sendReply(sock, from, { text: tr(lang, '❌ Ya hay una partida de ta-te-ti en curso en este chat.', '❌ Já tem uma partida de jogo da velha em andamento neste chat.', '❌ There is already a tic-tac-toe game going on in this chat.') }, { quoted: m })
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}ttt @rival`, `❌ Uso: ${prefix}ttt @rival`, `❌ Usage: ${prefix}ttt @rival`) }, { quoted: m })
                juegosTTT.set(from, { tablero: Array(9).fill(null), turno: sender, jugadores: [sender, mentioned[0]], simbolos: { [sender]: '❌', [mentioned[0]]: '⭕' } })
                await sendReply(sock, from, { text: `${dibujarTTT(juegosTTT.get(from).tablero)}\n\n${tr(lang, `Empieza @${sender.split('@')[0]} (❌). Jugá con ${prefix}ttt <1-9>`, `Começa @${sender.split('@')[0]} (❌). Jogue com ${prefix}ttt <1-9>`, `@${sender.split('@')[0]} starts (❌). Play with ${prefix}ttt <1-9>`)}`, mentions: [sender, mentioned[0]] }, { quoted: m })
            }
            if (command === 'ttt' && /^[1-9]$/.test((args[0] || ''))) {
                const juego = juegosTTT.get(from)
                if (!juego) return sendReply(sock, from, { text: tr(lang, `❌ No hay partida activa. Empezá una con ${prefix}ttt @rival`, `❌ Não tem partida ativa. Comece uma com ${prefix}ttt @rival`, `❌ No active game. Start one with ${prefix}ttt @rival`) }, { quoted: m })
                if (!juego.jugadores.includes(sender)) return sendReply(sock, from, { text: tr(lang, '❌ No sos parte de esta partida.', '❌ Você não faz parte dessa partida.', "❌ You're not part of this game.") }, { quoted: m })
                if (juego.turno !== sender) return sendReply(sock, from, { text: tr(lang, '❌ No es tu turno.', '❌ Não é sua vez.', "❌ It's not your turn.") }, { quoted: m })
                const pos = parseInt(args[0]) - 1
                if (juego.tablero[pos]) return sendReply(sock, from, { text: tr(lang, '❌ Esa casilla ya está ocupada.', '❌ Essa casinha já está ocupada.', '❌ That spot is already taken.') }, { quoted: m })
                juego.tablero[pos] = juego.simbolos[sender]
                const ganador = revisarGanadorTTT(juego.tablero)
                if (ganador) {
                    juegosTTT.delete(from)
                    return sendReply(sock, from, { text: `${dibujarTTT(juego.tablero)}\n\n🏆 ${tr(lang, `¡Ganó @${sender.split('@')[0]}!`, `@${sender.split('@')[0]} venceu!`, `@${sender.split('@')[0]} won!`)}`, mentions: [sender] }, { quoted: m })
                }
                if (juego.tablero.every(c => c)) {
                    juegosTTT.delete(from)
                    return sendReply(sock, from, { text: `${dibujarTTT(juego.tablero)}\n\n🤝 ${tr(lang, 'Empate.', 'Empate.', 'Tie.')}` }, { quoted: m })
                }
                juego.turno = juego.jugadores.find(j => j !== sender)
                await sendReply(sock, from, { text: `${dibujarTTT(juego.tablero)}\n\n${tr(lang, `Turno de @${juego.turno.split('@')[0]}`, `Vez de @${juego.turno.split('@')[0]}`, `@${juego.turno.split('@')[0]}'s turn`)}`, mentions: [juego.turno] }, { quoted: m })
            }

            // ---- Ahorcado (hangman) ----
            if (command === 'ahorcado' || command === 'hangman') {
                if (juegosAhorcado.has(from)) return sendReply(sock, from, { text: tr(lang, `❌ Ya hay un ahorcado en curso. Adiviná letras con ${prefix}letra <letra> o la palabra con ${prefix}letra <palabra>`, `❌ Já tem uma forca em andamento. Adivinhe letras com ${prefix}letra <letra>`, `❌ There is already a hangman game going. Guess letters with ${prefix}letra <letter>`) }, { quoted: m })
                const palabras = lang === 'pt' ? PALABRAS_AHORCADO.pt : lang === 'en' ? PALABRAS_AHORCADO.en : PALABRAS_AHORCADO.es
                const palabra = palabras[Math.floor(Math.random() * palabras.length)].toUpperCase()
                juegosAhorcado.set(from, { palabra, adivinadas: [], intentosRestantes: 6 })
                const oculto = palabra.split('').map(c => juegosAhorcado.get(from).adivinadas.includes(c) ? c : '_').join(' ')
                await sendReply(sock, from, { text: `🎪 *${tr(lang, 'Ahorcado', 'Forca', 'Hangman')}*\n\n${oculto}\n\n${tr(lang, `Intentos: 6. Adiviná con ${prefix}letra <letra>`, `Tentativas: 6. Adivinhe com ${prefix}letra <letra>`, `Attempts: 6. Guess with ${prefix}letra <letter>`)}` }, { quoted: m })
            }

            if (command === 'letra') {
                const juego = juegosAhorcado.get(from)
                if (!juego) return sendReply(sock, from, { text: tr(lang, `❌ No hay ahorcado activo. Empezá uno con ${prefix}ahorcado`, `❌ Não tem forca ativa. Comece uma com ${prefix}ahorcado`, `❌ No active hangman. Start one with ${prefix}ahorcado`) }, { quoted: m })
                const intento = (args[0] || '').toUpperCase()
                if (!intento) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}letra <letra o palabra>`, `❌ Uso: ${prefix}letra <letra ou palavra>`, `❌ Usage: ${prefix}letra <letter or word>`) }, { quoted: m })
                if (intento.length > 1) {
                    if (intento === juego.palabra) {
                        juegosAhorcado.delete(from)
                        return sendReply(sock, from, { text: `🎉 ${tr(lang, `¡Correcto! Era *${juego.palabra}*`, `Correto! Era *${juego.palabra}*`, `Correct! It was *${juego.palabra}*`)}` }, { quoted: m })
                    }
                    juego.intentosRestantes--
                } else if (!juego.adivinadas.includes(intento)) {
                    juego.adivinadas.push(intento)
                    if (!juego.palabra.includes(intento)) juego.intentosRestantes--
                }
                if (juego.intentosRestantes <= 0) {
                    juegosAhorcado.delete(from)
                    return sendReply(sock, from, { text: `💀 ${tr(lang, `Perdiste. Era *${juego.palabra}*`, `Você perdeu. Era *${juego.palabra}*`, `You lost. It was *${juego.palabra}*`)}` }, { quoted: m })
                }
                const oculto = juego.palabra.split('').map(c => juego.adivinadas.includes(c) ? c : '_').join(' ')
                if (!oculto.includes('_')) {
                    juegosAhorcado.delete(from)
                    return sendReply(sock, from, { text: `🎉 ${tr(lang, `¡Ganaste! Era *${juego.palabra}*`, `Você ganhou! Era *${juego.palabra}*`, `You won! It was *${juego.palabra}*`)}` }, { quoted: m })
                }
                await sendReply(sock, from, { text: `🎪 ${oculto}\n\n${tr(lang, `Intentos restantes: ${juego.intentosRestantes}`, `Tentativas restantes: ${juego.intentosRestantes}`, `Attempts left: ${juego.intentosRestantes}`)}` }, { quoted: m })
                return
            }

            // ---- Akinator (adivina el personaje) ----
            if (command === 'akinator') {
                if (juegosAkinator.has(from)) return sendReply(sock, from, { text: tr(lang, `❌ Ya hay un Akinator en curso. Respondé con ${prefix}aki <si/no/nose/probable/improbable>`, `❌ Já tem um Akinator em andamento. Responda com ${prefix}aki <sim/nao/naosei/provavel/improvavel>`, `❌ There's already an Akinator game going. Answer with ${prefix}aki <yes/no/dontknow/probably/probablynot>`) }, { quoted: m })
                await sendReply(sock, from, { text: tr(lang, '🔮 Pensando en tu personaje...', '🔮 Pensando no seu personagem...', '🔮 Thinking of your character...') }, { quoted: m })
                try {
                    const juego = await akiIniciar(lang)
                    juegosAkinator.set(from, juego)
                    await sendReply(sock, from, { text: tr(lang,
                        `🔮 *Akinator*\n\n${juego.pregunta}\n\nRespondé con: ${prefix}aki si / no / nose / probable / improbable`,
                        `🔮 *Akinator*\n\n${juego.pregunta}\n\nResponda com: ${prefix}aki sim / nao / naosei / provavel / improvavel`,
                        `🔮 *Akinator*\n\n${juego.pregunta}\n\nAnswer with: ${prefix}aki yes / no / dontknow / probably / probablynot`) }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: tr(lang, '❌ No pude conectar con Akinator ahora, probá de nuevo en un rato.', '❌ Não consegui conectar com o Akinator agora, tente de novo daqui a pouco.', '❌ Could not connect to Akinator right now, try again in a bit.') }, { quoted: m })
                }
            }

            if (command === 'aki') {
                const juego = juegosAkinator.get(from)
                if (!juego) return sendReply(sock, from, { text: tr(lang, `❌ No hay Akinator activo. Empezá uno con ${prefix}akinator`, `❌ Não tem Akinator ativo. Comece um com ${prefix}akinator`, `❌ No active Akinator. Start one with ${prefix}akinator`) }, { quoted: m })
                const mapaRespuestas = {
                    si: 0, sim: 0, yes: 0, y: 0, s: 0,
                    no: 1, n: 1,
                    nose: 2, naosei: 2, dontknow: 2, idk: 2,
                    probable: 3, provavel: 3, probably: 3,
                    improbable: 4, improvavel: 4, probablynot: 4
                }
                const clave = (args[0] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                if (!(clave in mapaRespuestas)) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}aki si|no|nose|probable|improbable`, `❌ Uso: ${prefix}aki sim|nao|naosei|provavel|improvavel`, `❌ Usage: ${prefix}aki yes|no|dontknow|probably|probablynot`) }, { quoted: m })
                try {
                    const resultado = await akiResponder(juego, mapaRespuestas[clave])
                    if (resultado.ganado) {
                        juegosAkinator.delete(from)
                        const textoGanado = tr(lang, `🔮 *¡Ya sé quién es!*\n\n${resultado.nombre}\n${resultado.descripcion || ''}`, `🔮 *Já sei quem é!*\n\n${resultado.nombre}\n${resultado.descripcion || ''}`, `🔮 *I know who it is!*\n\n${resultado.nombre}\n${resultado.descripcion || ''}`)
                        if (resultado.foto) {
                            try {
                                const res = await fetch(resultado.foto)
                                const buf = Buffer.from(await res.arrayBuffer())
                                await sock.sendMessage(from, { image: buf, caption: textoGanado }, { quoted: m })
                                return
                            } catch (e) {}
                        }
                        await sendReply(sock, from, { text: textoGanado }, { quoted: m })
                        return
                    }
                    await sendReply(sock, from, { text: `🔮 ${resultado.pregunta}\n\n${tr(lang, `Progreso: ${resultado.progreso}%`, `Progresso: ${resultado.progreso}%`, `Progress: ${resultado.progreso}%`)}` }, { quoted: m })
                } catch (e) {
                    juegosAkinator.delete(from)
                    await sendReply(sock, from, { text: tr(lang, '❌ Akinator se cortó, empezá de nuevo con ' + prefix + 'akinator', '❌ O Akinator caiu, comece de novo com ' + prefix + 'akinator', '❌ Akinator disconnected, start again with ' + prefix + 'akinator') }, { quoted: m })
                }
            }

            // ====================== WOLFRIC PROTOCOL: EASTER EGGS ======================
            // Comandos secretos: no aparecen en .menu ni en .help, la gente los descubre solos o por rumor.
            if (command === 'banana') {
                const mentioned = getMentioned()
                const target = mentioned.length ? mentioned[0] : sender
                const porcentaje = Math.floor(Math.random() * 100) + 1
                const frasesEs = [
                    `🍌 El nivel de banana de @${target.split('@')[0]} es *${porcentaje}%*.`,
                    `🍌 @${target.split('@')[0]} está *${porcentaje}%* banana hoy. No preguntes por qué.`,
                    `🍌 Un estudio no científico determinó que @${target.split('@')[0]} es *${porcentaje}%* banana.`,
                    porcentaje > 90 ? `🍌🍌🍌 @${target.split('@')[0]} ES *${porcentaje}%* BANANA. ALERTA MÁXIMA. 🍌🍌🍌` : `🍌 @${target.split('@')[0]} — nivel banana: *${porcentaje}%*.`
                ]
                const frasesPt = [
                    `🍌 O nível de banana de @${target.split('@')[0]} é *${porcentaje}%*.`,
                    `🍌 @${target.split('@')[0]} está *${porcentaje}%* banana hoje. Não pergunte por quê.`,
                    `🍌 Um estudo nada científico determinou que @${target.split('@')[0]} é *${porcentaje}%* banana.`,
                    porcentaje > 90 ? `🍌🍌🍌 @${target.split('@')[0]} É *${porcentaje}%* BANANA. ALERTA MÁXIMO. 🍌🍌🍌` : `🍌 @${target.split('@')[0]} — nível banana: *${porcentaje}%*.`
                ]
                const frasesEn = [
                    `🍌 @${target.split('@')[0]}'s banana level is *${porcentaje}%*.`,
                    `🍌 @${target.split('@')[0]} is *${porcentaje}%* banana today. Don't ask why.`,
                    `🍌 A totally unscientific study determined @${target.split('@')[0]} is *${porcentaje}%* banana.`,
                    porcentaje > 90 ? `🍌🍌🍌 @${target.split('@')[0]} IS *${porcentaje}%* BANANA. MAXIMUM ALERT. 🍌🍌🍌` : `🍌 @${target.split('@')[0]} — banana level: *${porcentaje}%*.`
                ]
                const frases = lang === 'pt' ? frasesPt : lang === 'en' ? frasesEn : frasesEs
                const idx = Math.floor(Math.random() * frases.length)
                await sendReply(sock, from, { text: frases[idx], mentions: [target] }, { quoted: m })
                return
            }

            if (command === 'respirar') {
                const mensajesEs = [
                    '🌬️ Pará un segundo.\n\nInhalá... 4 segundos.\nAguantá... 4 segundos.\nExhalá... 4 segundos.\n\nListo. Ya está. Ahora podés volver a farmear monedas en paz.',
                    '🌬️ Che, tranqui. Respirá hondo una vez. Ya. Ahora seguí jugando, pero un poco más zen.',
                    '🌬️ *[SISTEMA]* Se detectaron niveles altos de tryhardeo. Respirá 3 segundos antes de continuar.\n\n...\n\nBien. Ahora sí, a lo tuyo.'
                ]
                const mensajesPt = [
                    '🌬️ Pare um segundo.\n\nInspire... 4 segundos.\nSegure... 4 segundos.\nExpire... 4 segundos.\n\nPronto. Já pode voltar a farmar moedas em paz.',
                    '🌬️ Relaxa aí. Respira fundo uma vez. Já foi. Agora continua jogando, só que um pouco mais zen.',
                    '🌬️ *[SISTEMA]* Foram detectados níveis altos de tryhard. Respire 3 segundos antes de continuar.\n\n...\n\nBeleza. Agora sim, siga em frente.'
                ]
                const mensajesEn = [
                    '🌬️ Hold on a second.\n\nInhale... 4 seconds.\nHold... 4 seconds.\nExhale... 4 seconds.\n\nThere you go. Now go back to farming coins in peace.',
                    '🌬️ Chill out. Take one deep breath. There. Now keep playing, just a bit more zen.',
                    '🌬️ *[SYSTEM]* High tryhard levels detected. Breathe for 3 seconds before continuing.\n\n...\n\nGood. Now carry on.'
                ]
                const mensajes = lang === 'pt' ? mensajesPt : lang === 'en' ? mensajesEn : mensajesEs
                await enviarConGif(sock, from, mensajes[Math.floor(Math.random() * mensajes.length)], 'calm breathing relax', [], { quoted: m })
                return
            }

            if (command === 'sudo') {
                const resto = text.trim()
                const textoSudo = tr(lang,
                    `🔒 *[sudo]* Permiso denegado.\n\n@${sender.split('@')[0]} no está en el archivo sudoers de la vida real.${resto ? `\n\nEste incidente ("${resto}") será reportado.` : ''}`,
                    `🔒 *[sudo]* Permissão negada.\n\n@${sender.split('@')[0]} não está no arquivo sudoers da vida real.${resto ? `\n\nEste incidente ("${resto}") será reportado.` : ''}`,
                    `🔒 *[sudo]* Permission denied.\n\n@${sender.split('@')[0]} is not in the real-life sudoers file.${resto ? `\n\nThis incident ("${resto}") will be reported.` : ''}`)
                await sendReply(sock, from, { text: textoSudo, mentions: [sender] }, { quoted: m })
                return
            }

            if (command === 'autodestruir') {
                await sendReply(sock, from, { text: tr(lang, `💣 *SECUENCIA DE AUTODESTRUCCIÓN INICIADA*\n\n5...\n4...\n3...`, `💣 *SEQUÊNCIA DE AUTODESTRUIÇÃO INICIADA*\n\n5...\n4...\n3...`, `💣 *SELF-DESTRUCT SEQUENCE INITIATED*\n\n5...\n4...\n3...`) }, { quoted: m })
                await sleep(1800)
                await sendReply(sock, from, { text: '2...\n1...' }, { quoted: m })
                await sleep(1200)
                await sendReply(sock, from, { text: tr(lang, '💥 Mentira, era joda. Wolfric sigue de pie. 😄', '💥 Mentira, era brincadeira. O Wolfric continua de pé. 😄', "💥 Just kidding. Wolfric is still standing. 😄") }, { quoted: m })
                return
            }

            if (command === 'goku' || command === 'powerlevel') {
                const mentioned = getMentioned()
                const target = mentioned.length ? mentioned[0] : sender
                const nivel = Math.floor(Math.random() * 9000000) + 1
                const textoGoku = tr(lang,
                    `📟 *SCOUTER ACTIVADO*\n\n@${target.split('@')[0]}...\n\n... IT'S OVER *${nivel.toLocaleString('es-AR')}*!! 😱`,
                    `📟 *SCOUTER ATIVADO*\n\n@${target.split('@')[0]}...\n\n... IT'S OVER *${nivel.toLocaleString('pt-BR')}*!! 😱`,
                    `📟 *SCOUTER ACTIVATED*\n\n@${target.split('@')[0]}...\n\n... IT'S OVER *${nivel.toLocaleString('en-US')}*!! 😱`)
                await sendReply(sock, from, { text: textoGoku, mentions: [target] }, { quoted: m })
                return
            }

            if (command === '42') {
                await sendReply(sock, from, { text: tr(lang,
                    '🌌 La respuesta a la vida, el universo y todo lo demás es... *42*.\n\n(No preguntes cuál era la pregunta, ni la Guía del Autoestopista Galáctico lo sabe.)',
                    '🌌 A resposta para a vida, o universo e tudo mais é... *42*.\n\n(Não pergunte qual era a pergunta, nem o Guia do Mochileiro das Galáxias sabe.)',
                    "🌌 The answer to life, the universe and everything is... *42*.\n\n(Don't ask what the question was, not even the Hitchhiker's Guide to the Galaxy knows.)") }, { quoted: m })
                return
            }

            if (command === 'matrix') {
                await sendReply(sock, from, { text: tr(lang, '💊 *¿Pastilla roja o azul?*\n\nDa igual la que elijas — este bot corre en un Termux con batería al 48%, la realidad es la misma para todos.', '💊 *Pílula vermelha ou azul?*\n\nTanto faz qual você escolher — este bot roda num Termux com bateria em 48%, a realidade é a mesma para todos.', "💊 *Red pill or blue pill?*\n\nDoesn't matter which one you pick — this bot runs on a Termux at 48% battery, reality is the same for everyone.") }, { quoted: m })
                return
            }

            if (command === 'touchgrass') {
                const mentioned = getMentioned()
                const target = mentioned.length ? mentioned[0] : sender
                const textoTouch = tr(lang, `🌱 @${target.split('@')[0]}... andá a tocar pasto. En serio. El sol existe.`, `🌱 @${target.split('@')[0]}... vai tocar grama. Sério. O sol existe.`, `🌱 @${target.split('@')[0]}... go touch some grass. Seriously. The sun exists.`)
                await enviarConGif(sock, from, textoTouch, 'go outside touch grass', [target], { quoted: m })
                return
            }

            // ====================== GACHA ======================
            // ====================== ECONOMÍA ======================
            if (command === 'balance') {
                const user = getUsuario(sender)
                await sendReply(sock, from, { text: tr(lang, `💰 *${pushName}*, tienes *${user.coins}* monedas.`, `💰 *${pushName}*, você tem *${user.coins}* moedas.`, `💰 *${pushName}*, tienes *${user.coins}* coins.`) }, { quoted: m })
            }

            if (command === 'daily') {
                const user = getUsuario(sender)
                const ahora = Date.now()
                const unDia = 24 * 60 * 60 * 1000
                if (ahora - user.lastDaily < unDia) {
                    const restante = unDia - (ahora - user.lastDaily)
                    return sendReply(sock, from, { text: tr(lang, `⏳ Ya reclamaste tu recompensa diaria. Vuelve en *${clockString(restante)}*.`, `⏳ Você já pegou a recompensa diária. Volte em *${clockString(restante)}*.`, `⏳ You already claimed your daily reward. Come back in *${clockString(restante)}*.`) }, { quoted: m })
                }

                // Racha diaria: si reclamó dentro de la ventana de gracia (hasta 48h desde la última vez), la racha sigue.
                // Si dejó pasar más de 48h, la racha se corta y arranca de nuevo desde 1.
                const dosDias = 48 * 60 * 60 * 1000
                const seguiaRacha = user.lastDaily > 0 && (ahora - user.lastDaily) <= dosDias
                user.rachaDiaria = seguiaRacha ? user.rachaDiaria + 1 : 1
                if (user.rachaDiaria > user.rachaDiariaMejor) user.rachaDiariaMejor = user.rachaDiaria

                const premioBase = Math.floor(Math.random() * 100) + 50
                // La racha multiplica el premio base (tope en x2.5 a partir de los 30 días, para no romper la economía)
                const multiplicador = Math.min(1 + (user.rachaDiaria - 1) * 0.05, 2.5)
                const premio = Math.floor(premioBase * multiplicador)
                user.coins += premio
                user.lifetimeCoinsEarned += premio
                user.lastDaily = ahora

                // Hito alcanzado (barra visual + premio grande, solo se reclama una vez por hito)
                const hito = HITOS_RACHA_DIARIA.find(h => h.dias === user.rachaDiaria && !user.hitosRachaReclamados.includes(h.dias))
                let textoHito = ''
                if (hito) {
                    user.hitosRachaReclamados.push(hito.dias)
                    user.coins += hito.coins
                    user.lifetimeCoinsEarned += hito.coins
                    if (hito.titulo && !user.titles.includes(hito.titulo)) user.titles.push(hito.titulo)
                    textoHito = tr(lang,
                        `\n\n🏅 *¡HITO DE RACHA ALCANZADO: ${hito.dias} DÍAS!*\n🎁 +${hito.coins} monedas extra${hito.titulo ? `\n👑 Título desbloqueado: *${hito.titulo}* (equipalo con ${prefix}titleequip)` : ''}`,
                        `\n\n🏅 *META DE SEQUÊNCIA ALCANÇADA: ${hito.dias} DIAS!*\n🎁 +${hito.coins} moedas extras${hito.titulo ? `\n👑 Título desbloqueado: *${hito.titulo}* (equipe com ${prefix}titleequip)` : ''}`,
                        `\n\n🏅 *STREAK MILESTONE REACHED: ${hito.dias} DAYS!*\n🎁 +${hito.coins} extra coins${hito.titulo ? `\n👑 Title unlocked: *${hito.titulo}* (equip it with ${prefix}titleequip)` : ''}`)
                }

                const proximoHito = HITOS_RACHA_DIARIA.find(h => h.dias > user.rachaDiaria)
                const barra = barraProgresoRacha(user.rachaDiaria, proximoHito ? proximoHito.dias : user.rachaDiaria)

                guardarEconomia()
                const msgDaily = tr(lang,
                    `🎁 *${pushName}*, reclamaste tu recompensa diaria: *+${premio}* monedas.\n💰 Total: *${user.coins}*\n\n🔥 Racha diaria: *${user.rachaDiaria}* día${user.rachaDiaria === 1 ? '' : 's'} (mejor: ${user.rachaDiariaMejor})\n${barra}${proximoHito ? `\n🎯 Próximo hito: día ${proximoHito.dias} (+${proximoHito.coins}${proximoHito.titulo ? ` y título "${proximoHito.titulo}"` : ''})` : ''}${textoHito}`,
                    `🎁 *${pushName}*, você pegou a recompensa diária: *+${premio}* moedas.\n💰 Total: *${user.coins}*\n\n🔥 Sequência diária: *${user.rachaDiaria}* dia${user.rachaDiaria === 1 ? '' : 's'} (melhor: ${user.rachaDiariaMejor})\n${barra}${proximoHito ? `\n🎯 Próxima meta: dia ${proximoHito.dias} (+${proximoHito.coins}${proximoHito.titulo ? ` e título "${proximoHito.titulo}"` : ''})` : ''}${textoHito}`,
                    `🎁 *${pushName}*, you claimed your daily reward: *+${premio}* coins.\n💰 Total: *${user.coins}*\n\n🔥 Daily streak: *${user.rachaDiaria}* day${user.rachaDiaria === 1 ? '' : 's'} (best: ${user.rachaDiariaMejor})\n${barra}${proximoHito ? `\n🎯 Next milestone: day ${proximoHito.dias} (+${proximoHito.coins}${proximoHito.titulo ? ` and title "${proximoHito.titulo}"` : ''})` : ''}${textoHito}`)
                // Si cae un hito grande, el gif va DENTRO del mismo mensaje (sin botones, para no romper
                // el formato del video). En un día normal, va con botones como siempre (sin gif).
                if (hito && hito.dias >= 30) {
                    await enviarConGif(sock, from, msgDaily, hito.dias >= 1000 ? 'legendary epic reward' : 'level up celebration', [], { quoted: m })
                } else {
                    await enviarConBotones(sock, from, msgDaily, [
                        { text: tr(lang, 'Balance', 'Saldo', 'Balance'), id: 'balance' },
                        { text: tr(lang, 'Tienda', 'Loja', 'Shop'), id: 'tienda' },
                        { text: tr(lang, 'Menú', 'Menu', 'Menu'), id: 'menu' }
                    ], m)
                }
            }

            if (command === 'work') {
                const user = getUsuario(sender)
                const ahora = Date.now()
                const cooldown = 3 * 60 * 1000 // 3 minutos
                if (ahora - user.lastWork < cooldown) {
                    const restante = cooldown - (ahora - user.lastWork)
                    return sendReply(sock, from, { text: tr(lang, `⏳ Estás cansado de trabajar. Vuelve en *${clockString(restante)}*.`, `⏳ Você está cansado de trabalhar. Volte em *${clockString(restante)}*.`, `⏳ Estás cansado de trabajar. Vuelve en *${clockString(restante)}*.`) }, { quoted: m, sinGif: true })
                }
                const trabajos = lang === 'pt'
                    ? ['entregando pizza', 'programando um bot', 'vendendo lanches', 'passeando com cães', 'cortando a grama']
                    : ['repartiendo pizza', 'programando un bot', 'vendiendo tacos', 'paseando perros', 'cortando el césped']
                const trabajo = trabajos[Math.floor(Math.random() * trabajos.length)]
                const pago = Math.floor(Math.random() * 60) + 20
                user.coins += pago
                user.lifetimeCoinsEarned += pago
                user.lastWork = ahora
                marcarMisionDia(user, 'work')
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `💼 *${pushName}* estuvo ${trabajo} y ganó *+${pago}* monedas.\n💰 Total: *${user.coins}*`, `💼 *${pushName}* ficou ${trabajo} e ganhou *+${pago}* moedas.\n💰 Total: *${user.coins}*`, `💼 *${pushName}* estuvo ${trabajo} y ganó *+${pago}* coins.\n💰 Total: *${user.coins}*`) }, { quoted: m, sinGif: true })
            }

            if (command === 'train' || command === 'entrenar') {
                const user = getUsuario(sender)
                const ahora = Date.now()
                const cooldown = 4 * 60 * 1000
                if (ahora - (user.lastTrain || 0) < cooldown) {
                    const restante = cooldown - (ahora - user.lastTrain)
                    return sendReply(sock, from, { text: tr(lang, `⏳ Descansá un poco. Vuelve en *${clockString(restante)}*.`, `⏳ Descanse um pouco. Volte em *${clockString(restante)}*.`, `⏳ Descansá un poco. Vuelve en *${clockString(restante)}*.`) }, { quoted: m })
                }
                user.lastTrain = ahora
                marcarMisionDia(user, 'train')
                const exp = 8 + Math.floor(Math.random() * 7)
                const subio = frontierDarExp(user, exp)
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `🏋️ *${pushName}* entrenó y ganó *+${exp} EXP*.${subio ? `\n📈 Subiste a nivel *${user.level}*` : ''}\n_Gratis, pero rinde poco. Cooldown 4 min._`, `🏋️ *${pushName}* treinou e ganhou *+${exp} EXP*.${subio ? `\n📈 Você subiu para o nível *${user.level}*` : ''}\n_De graça, mas rende pouco. Cooldown 4 min._`, `🏋️ *${pushName}* entrenó y ganó *+${exp} EXP*.${subio ? `\n📈 Subiste a nivel *${user.level}*` : ''}\n_Gratis, pero rinde poco. Cooldown 4 min._`) }, { quoted: m })
            }

            if (command === 'casino') {
                const user = getUsuario(sender)
                const apuesta = Math.max(10, parseInt(args[0]) || 50)
                const dia = new Date().toISOString().slice(0, 10)
                if (user.casinoDia !== dia) { user.casinoDia = dia; user.casinoHoy = 0 }
                if ((user.casinoHoy || 0) >= 15) return sendReply(sock, from, { text: tr(lang, '❌ Límite diario del casino: 15 tiradas. Mañana se reinicia.', '❌ Limite diário do cassino: 15 jogadas. Amanhã reinicia.', '❌ Límite diario del casino: 15 tiradas. Mañana se reinicia.') }, { quoted: m })
                if (user.coins < apuesta) return sendReply(sock, from, { text: tr(lang, `❌ No te alcanza. Tienes $${user.coins}.\nUso: ${prefix}casino <monto>`, `❌ Saldo insuficiente. Você tem $${user.coins}.\nUso: ${prefix}casino <valor>`, `❌ No te alcanza. Tienes $${user.coins}.\nUsage: ${prefix}casino <monto>`) }, { quoted: m })
                if (apuesta > 5000) return sendReply(sock, from, { text: tr(lang, '❌ Máximo $5000 por tirada.', '❌ Máximo $5000 por jogada.', '❌ Máximo $5000 por tirada.') }, { quoted: m })
                marcarMisionDia(user, 'casino')
                user.casinoHoy = (user.casinoHoy || 0) + 1
                user.coins -= apuesta
                const simbolos = ['🍒', '🍋', '⭐', '💎', '7️⃣', '🐺']
                const a = simbolos[Math.floor(Math.random() * simbolos.length)]
                const b = simbolos[Math.floor(Math.random() * simbolos.length)]
                const c = simbolos[Math.floor(Math.random() * simbolos.length)]
                let premio = 0
                let result = tr(lang, 'Perdiste.', 'Você perdeu.', 'You lost.')
                if (a === b && b === c) {
                    premio = apuesta * (a === '🐺' || a === '7️⃣' ? 8 : 5)
                    result = 'JACKPOT'
                } else if (a === b || b === c || a === c) {
                    premio = Math.floor(apuesta * 1.8)
                    result = 'Doble'
                }
                user.coins += premio
                if (premio) user.lifetimeCoinsEarned += premio
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `🎰 *CASINO*\n[ ${a} | ${b} | ${c} ]\n\n${result}${premio ? `  +$${premio}` : `  -$${apuesta}`}\n💰 Total: *${user.coins}*\nTiradas hoy: ${user.casinoHoy}/15`, `🎰 *CASSINO*\n[ ${a} | ${b} | ${c} ]\n\n${result}${premio ? `  +$${premio}` : `  -$${apuesta}`}\n💰 Total: *${user.coins}*\nJogadas hoje: ${user.casinoHoy}/15`, `🎰 *CASINO*\n[ ${a} | ${b} | ${c} ]\n\n${result}${premio ? `  +$${premio}` : `  -$${apuesta}`}\n💰 Total: *${user.coins}*\nTiradas hoy: ${user.casinoHoy}/15`) }, { quoted: m })
            }

            if (command === 'apostar') {
                const user = getUsuario(sender)
                const lado = (args[0] || '').toLowerCase()
                const apuesta = Math.max(10, parseInt(args[1]) || 50)
                if (!['cara', 'cruz'].includes(lado)) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}apostar cara|cruz <monto>`, `❌ Uso: ${prefix}apostar cara|cruz <valor>`, `❌ Usage: ${prefix}apostar cara|cruz <monto>`) }, { quoted: m })
                if (user.coins < apuesta) return sendReply(sock, from, { text: tr(lang, `❌ No te alcanza. Tienes $${user.coins}.`, `❌ Saldo insuficiente. Você tem $${user.coins}.`, `❌ No te alcanza. Tienes $${user.coins}.`) }, { quoted: m })
                if (apuesta > 3000) return sendReply(sock, from, { text: tr(lang, '❌ Máximo $3000.', '❌ Máximo $3000.', '❌ Máximo $3000.') }, { quoted: m })
                user.coins -= apuesta
                const sale = Math.random() < 0.5 ? 'cara' : 'cruz'
                let txt = tr(lang, `🪙 Salió *${sale}*.`, `🪙 Saiu *${sale}*.`, `🪙 Salió *${sale}*.`)
                if (sale === lado) {
                    const gana = apuesta * 2
                    user.coins += gana
                    user.lifetimeCoinsEarned += gana
                    txt += tr(lang, ` Ganaste *$${gana}*.`, ` Você ganhou *$${gana}*.`, ` You won *$${gana}*.`)
                } else txt += tr(lang, ` Perdiste *$${apuesta}*.`, ` Você perdeu *$${apuesta}*.`, ` You lost *$${apuesta}*.`)
                marcarMisionDia(user, 'apostar')
                guardarEconomia()
                await sendReply(sock, from, { text: txt + `\n💰 Total: *${user.coins}*` }, { quoted: m })
            }

            if (command === 'heal' || command === 'curar') {
                const user = getUsuario(sender)
                const ahora = Date.now()
                if (ahora - (user.lastHeal || 0) < 10 * 60 * 1000) {
                    return sendReply(sock, from, { text: tr(lang, `⏳ Curación en cooldown. Falta *${clockString(10*60*1000 - (ahora - user.lastHeal))}*.`, `⏳ Cura em cooldown. Falta *${clockString(10*60*1000 - (ahora - user.lastHeal))}*.`, `⏳ Curación en cooldown. Falta *${clockString(10*60*1000 - (ahora - user.lastHeal))}*.`) }, { quoted: m })
                }
                if ((user.hp || 0) >= (user.maxHp || 100)) return sendReply(sock, from, { text: tr(lang, '❤️ Ya estás al máximo de HP.', '❤️ Você já está no máximo de HP.', `❤️ You're already al máximo de HP.`) }, { quoted: m })
                user.lastHeal = ahora
                const cura = 20 + Math.floor(Math.random() * 16)
                user.hp = Math.min(user.maxHp, (user.hp || 0) + cura)
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `💉 Recuperaste *+${cura} HP*.\n❤️ ${user.hp}/${user.maxHp}`, `💉 Você recuperou *+${cura} HP*.\n❤️ ${user.hp}/${user.maxHp}`, `💉 Recuperaste *+${cura} HP*.\n❤️ ${user.hp}/${user.maxHp}`) }, { quoted: m })
            }

            if (command === 'misiondia' || command === 'misionesdia') {
                const user = getUsuario(sender)
                const m0 = getMisionDia(user)
                await sendReply(sock, from, { text: textoMisionDia(m0, prefix) }, { quoted: m })
            }

            if (command === 'reclamarmision') {
                const user = getUsuario(sender)
                const m0 = getMisionDia(user)
                if (m0.reclamado) return sendReply(sock, from, { text: tr(lang, '✅ Ya reclamaste la misión de hoy.', '✅ Você já resgatou a missão de hoje.', '✅ Ya reclamaste la quest de hoy.') }, { quoted: m })
                if (!m0.work || !m0.train || !m0.casino) return sendReply(sock, from, { text: tr(lang, '❌ Completá las 3 tareas del día primero.\n', '❌ Complete as 3 tarefas do dia primeiro.\n', '❌ Completá las 3 tareas del day primero.\n') + textoMisionDia(m0, prefix) }, { quoted: m })
                m0.reclamado = true
                user.coins += 250
                user.lifetimeCoinsEarned += 250
                frontierDarExp(user, 40)
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, '🎯 Misión diaria reclamada.\n+$250 y +40 EXP.', '🎯 Missão diária resgatada.\n+$250 e +40 EXP.', '🎯 Quest diaria reclamada.\n+$250 y +40 EXP.') }, { quoted: m })
            }

            if (command === 'ranking' || command === 'rank') {
                const lista = Object.entries(economia).map(([id, u]) => ({ id, coins: u.coins || 0, level: u.level || 1, nombre: (u.frontier && u.frontier.nombre) || id.split('@')[0] }))
                lista.sort((a, b) => b.coins - a.coins)
                const top = lista.slice(0, 10).map((u, i) => `${i + 1}. ${u.nombre} · Nv.${u.level} · $${u.coins}`).join('\n')
                await sendReply(sock, from, { text: tr(lang, `📊 *Ranking semanal (monedas)*\n\n${top || 'Sin datos'}\n\n_Se ordena por saldo actual._`, `📊 *Ranking semanal (moedas)*\n\n${top || 'Sem dados'}\n\n_Ordenado pelo saldo atual._`, `📊 *Ranking weekly (coins)*\n\n${top || 'Sin datos'}\n\n_Se ordena por saldo actual._`) }, { quoted: m })
            }

            if (command === 'reglas') {
                const gcfg = isGroup ? getGrupoCfg(from) : {}
                const txt = gcfg.reglas || tr(lang, 'Sin reglas cargadas. Un admin puede usar *.setreglas texto*.', 'Sem regras carregadas. Um admin pode usar *.setreglas texto*.', 'Sin reglas cargadas. Un admin puede usar *.setreglas texto*.')
                return sendReply(sock, from, { text: tr(lang, `📜 *Reglas del grupo*\n\n${txt}`, `📜 *Regras do grupo*\n\n${txt}`, `📜 *Reglas del group*\n\n${txt}`) }, { quoted: m })
            }

            if (command === 'setreglas' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                gcfg.reglas = text || ''
                guardarGruposConfig()
                return sendReply(sock, from, { text: tr(lang, '✅ Reglas actualizadas.', '✅ Regras atualizadas.', '✅ Reglas actualizadas.') }, { quoted: m })
            }

            if (command === 'blacklist' && isOwner) {
                const sub = (args[0] || '').toLowerCase()
                const gcfg = isGroup ? getGrupoCfg(from) : null
                if (!gcfg) return sendReply(sock, from, { text: tr(lang, '❌ Usalo en un grupo.', '❌ Use em um grupo.', '❌ Use it en un group.') }, { quoted: m })
                if (!Array.isArray(gcfg.blacklist)) gcfg.blacklist = []
                if (sub === 'list') return sendReply(sock, from, { text: '🚫 Blacklist:\n' + (gcfg.blacklist.join('\n') || tr(lang, 'vacía', 'vazia', 'vacía')) }, { quoted: m })
                const mentioned = (m.message?.extendedTextMessage?.contextInfo?.mentionedJid) || []
                const target = mentioned[0] || args[1]
                if (!target) return sendReply(sock, from, { text: tr(lang, `Uso: ${prefix}blacklist add|remove|list @usuario`, `Uso: ${prefix}blacklist add|remove|list @usuario`, `Usage: ${prefix}blacklist add|remove|list @user`) }, { quoted: m })
                const id = normalizarJid(target)
                if (sub === 'add') {
                    if (!gcfg.blacklist.includes(id)) gcfg.blacklist.push(id)
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: tr(lang, `🚫 ${id} no puede usar el bot aquí.`, `🚫 ${id} não pode usar o bot aqui.`, `🚫 ${id} no puede usar el bot aquí.`) }, { quoted: m })
                }
                if (sub === 'remove') {
                    gcfg.blacklist = gcfg.blacklist.filter(x => x !== id)
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: tr(lang, `✅ ${id} quitado de la blacklist.`, `✅ ${id} removido da blacklist.`, `✅ ${id} quitado de la blacklist.`) }, { quoted: m })
                }
                return sendReply(sock, from, { text: tr(lang, `Uso: ${prefix}blacklist add|remove|list @usuario`, `Uso: ${prefix}blacklist add|remove|list @usuario`, `Usage: ${prefix}blacklist add|remove|list @user`) }, { quoted: m })
            }

            if (command === 'recordar' || command === 'remind') {
                const mins = parseInt(args[0])
                const nota = args.slice(1).join(' ') || 'Recordatorio'
                if (!mins || mins < 1 || mins > 720) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}recordar <minutos 1-720> texto`, `❌ Uso: ${prefix}remind <minutos 1-720> texto`, `❌ Usage: ${prefix}recordar <minutes 1-720> texto`) }, { quoted: m })
                const dest = from
                const who = sender
                setTimeout(async () => {
                    try { await sock.sendMessage(dest, { text: `⏰ Recordatorio para @${who.split('@')[0]}:\n${nota}`, mentions: [who] }) } catch (_) {}
                }, mins * 60 * 1000)
                return sendReply(sock, from, { text: tr(lang, `✅ Te aviso en *${mins}* min.`, `✅ Eu aviso em *${mins}* min.`, `✅ Te aviso en *${mins}* min.`) }, { quoted: m })
            }

            if (command === 'inventory') {
                const user = getUsuario(sender)
                if (!user.inventory.length) return sendReply(sock, from, { text: tr(lang, `📦 Tu inventario está vacío. Usa *${prefix}shop* para comprar algo.`, `📦 Seu inventário está vazio. Use *${prefix}shop* para comprar algo.`, `📦 Tu inventory está vacío. Use *${prefix}shop* para comprar algo.`) }, { quoted: m })
                const lista = user.inventory.map((it, i) => `${i + 1}. ${it}`).join('\n')
                await sendReply(sock, from, { text: tr(lang, `📦 *Inventario de ${pushName}*\n\n${lista}\n\nUsa *${prefix}usar <nombre>* para consumir un ítem.`, `📦 *Inventário de ${pushName}*\n\n${lista}\n\nUse *${prefix}usar <nome>* para consumir um item.`, `📦 *Inventario de ${pushName}*\n\n${lista}\n\nUse *${prefix}usar <name>* para consumir un item.`) }, { quoted: m })
            }

            if (command === 'inventario') {
                const user = getUsuario(sender)
                const fEquipada = frutaEquipadaObj(user)
                const estilo = ESTILOS_COMBATE.find(e => e.id === user.estiloEquipado)
                const misVentas = [...mercadoJugadores.entries()].filter(([, l]) => normalizarJid(l.vendedorJid) === normalizarJid(sender))

                let texto = `🎒 *INVENTARIO DE ${pushName.toUpperCase()}*\n\n`
                texto += `🍏 *Fruta equipada:* ${fEquipada ? `${fEquipada.nombre} [${fEquipada.categoria}]${fEquipada.despertada ? ' 🌟' : ''}` : 'Ninguna'}\n`
                texto += `   Colección completa: ${user.frutasPoseidas.length ? user.frutasPoseidas.map(f => f.nombre).join(', ') : 'vacía'}\n\n`
                texto += `🥋 *Estilo equipado:* ${estilo ? estilo.nombre : 'Ninguno'}\n`
                texto += `   Estilos aprendidos: ${user.estilosComprados.length ? user.estilosComprados.map(id => ESTILOS_COMBATE.find(e => e.id === id)?.nombre).join(', ') : 'ninguno'}\n\n`
                texto += `🎒 *Ítems (${user.inventory.length}):* ${user.inventory.length ? user.inventory.join(', ') : 'vacío'}\n\n`
                texto += `💰 Monedas: $${user.coins}   💎 Gemas: ${user.gems}   💀 Bounty: $${user.bounty}\n`
                texto += `🛡️ Guardias de robo activas: ${user.guardiasRobo}\n`
                if (misVentas.length) texto += `\n🏷️ *Tus publicaciones en el mercado:* ${misVentas.map(([id, l]) => `#${id} ${l.nombre} ($${l.precio})`).join(', ')}\n`
                texto += `\nUsa *${prefix}misfrutas*, *${prefix}estilos*, *${prefix}usar <item>* o *${prefix}mercado* para más detalle.`
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: ÍTEMS CONSUMIBLES (GDD V4.0 §3) ======================
            if (command === 'tienda') {
                let texto = tr(lang, `🛒 *TIENDA DE CONSUMIBLES — WOLFRIC PROTOCOL*\n\n`, `🛒 *LOJA DE CONSUMÍVEIS — WOLFRIC PROTOCOL*\n\n`, `🛒 *TIENDA DE CONSUMIBLES — WOLFRIC PROTOCOL*\n\n`)
                ITEMS_CONSUMIBLES.forEach(i => {
                    const precioTexto = i.precioGemas ? `💎 ${i.precioGemas} gemas` : `💰 $${i.precio}`
                    texto += `*${i.id}.* ${i.nombre} — ${precioTexto}\n📋 ${i.desc}\n\n`
                })
                texto += tr(lang, `Usa *${prefix}compraritem <número>* para comprar y *${prefix}usar <nombre>* para consumir.`, `Use *${prefix}compraritem <número>* para comprar e *${prefix}usar <nome>* para consumir.`, `Use *${prefix}compraritem <número>* para comprar y *${prefix}usar <name>* para consumir.`)
                await enviarConBotones(sock, from, texto, [
                    { text: tr(lang, 'Inventario', 'Inventário', 'Inventario'), id: 'inventario' },
                    { text: tr(lang, 'Balance', 'Saldo', 'Balance'), id: 'balance' },
                    { text: 'Daily', id: 'daily' }
                ], m)
            }

            if (command === 'compraritem') {
                const user = getUsuario(sender)
                const id = parseInt(args[0])
                const item = ITEMS_CONSUMIBLES.find(i => i.id === id)
                if (!item) return sendReply(sock, from, { text: tr(lang, `❌ Usa *${prefix}shop* para ver los números válidos.`, `❌ Use *${prefix}shop* para ver os números válidos.`, `❌ Use *${prefix}shop* para ver los números válidos.`) }, { quoted: m })
                if (item.precioGemas) {
                    if (user.gems < item.precioGemas) return sendReply(sock, from, { text: tr(lang, `❌ Necesitas 💎${item.precioGemas} gemas (tienes ${user.gems}).`, `❌ Você precisa de 💎${item.precioGemas} gemas (você tem ${user.gems}).`, `❌ You need 💎${item.precioGemas} gemas (tienes ${user.gems}).`) }, { quoted: m })
                    user.gems -= item.precioGemas
                } else {
                    if (user.coins < item.precio) return sendReply(sock, from, { text: tr(lang, `❌ Te faltan *${item.precio - user.coins}* monedas.`, `❌ Faltam *${item.precio - user.coins}* moedas.`, `❌ Te faltan *${item.precio - user.coins}* coins.`) }, { quoted: m })
                    user.coins -= item.precio
                }
                user.inventory.push(item.nombre)
                registrarUsoItem(item.nombre)
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `✅ Compraste *${item.nombre}*. Úsalo con *${prefix}usar ${item.nombre}*.`, `✅ Você comprou *${item.nombre}*. Use com *${prefix}use ${item.nombre}*.`, `✅ Compraste *${item.nombre}*. Úsalo con *${prefix}usar ${item.nombre}*.`) }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: RULETA ======================
            if (command === 'ruleta') {
                const user = getUsuario(sender)
                const COSTO_RULETA = 3000
                let usoGiroGratis = false
                if (user.girosRuletaGratis > 0) {
                    user.girosRuletaGratis--
                    usoGiroGratis = true
                } else {
                    if (user.coins < COSTO_RULETA) return sendReply(sock, from, { text: tr(lang, `❌ La Ruleta cuesta *$${COSTO_RULETA}* (o usá un giro gratis de un duplicado épico). Tienes $${user.coins}.`, `❌ A Roleta custa *$${COSTO_RULETA}* (ou use um giro grátis de duplicata épica). Você tem $${user.coins}.`, `❌ La Ruleta costs *$${COSTO_RULETA}* (o use un giro gratis de un duplicado épico). Tienes $${user.coins}.`) }, { quoted: m })
                    user.coins -= COSTO_RULETA
                }

                const roll = Math.random() * 100
                let texto = `🎡 *¡LA RULETA GIRA!* 🎡${usoGiroGratis ? ' (giro gratis 🎁)' : ''}\n\n`

                if (roll < 30) {
                    // Ítem barato al azar
                    const baratos = ITEMS_CONSUMIBLES.filter(i => !i.precioGemas && i.precio <= 2000)
                    const item = baratos[Math.floor(Math.random() * baratos.length)]
                    user.inventory.push(item.nombre)
                    texto += `🎒 Te tocó: *${item.nombre}*. Ya está en tu inventario.`
                } else if (roll < 50) {
                    // Consuelo en monedas
                    const consuelo = Math.floor(Math.random() * 1500) + 500
                    user.coins += consuelo
                    texto += `😐 No hubo suerte con nada especial... pero la máquina te devuelve *$${consuelo}*.`
                } else if (roll < 75) {
                    // Estilo barato al azar (que todavía no tengas)
                    const candidatos = ESTILOS_COMBATE.filter(e => e.precio <= 6000 && !user.estilosComprados.includes(e.id))
                    if (candidatos.length) {
                        const estilo = candidatos[Math.floor(Math.random() * candidatos.length)]
                        user.estilosComprados.push(estilo.id)
                        texto += `🥋 ¡Ganaste el estilo *${estilo.nombre}*! Equípalo con *${prefix}equiparestilo ${estilo.nombre}*.`
                    } else {
                        const consuelo = 1000
                        user.coins += consuelo
                        texto += `🥋 Ya tenías todos los estilos baratos disponibles — te devolvemos *$${consuelo}*.`
                    }
                } else if (roll < 95) {
                    // Fruta común o rara
                    const cat = Math.random() < 0.6 ? 'comun' : 'rara'
                    const nombre = FRUTAS[cat].nombres[Math.floor(Math.random() * FRUTAS[cat].nombres.length)]
                    otorgarFruta(user, nombre, cat)
                    texto += `🍏 ¡Ganaste la fruta *${nombre}* [${cat}]! Ya está en tu colección (*${prefix}misfrutas*).`
                } else if (roll < 99) {
                    // Épica
                    const nombre = FRUTAS.epica.nombres[Math.floor(Math.random() * FRUTAS.epica.nombres.length)]
                    otorgarFruta(user, nombre, 'epica')
                    texto += `🟣 ¡EXCELENTE TIRADA! Ganaste la fruta ÉPICA *${nombre}*!`
                } else {
                    // Jackpot: mítica
                    const nombre = FRUTAS.mitica.nombres[Math.floor(Math.random() * FRUTAS.mitica.nombres.length)]
                    otorgarFruta(user, nombre, 'mitica')
                    user.bounty += 100
                    user.ganoRuletaMitica = true
                    texto += `🌈🎰 *¡¡¡JACKPOT!!!* 🎰🌈\n¡Ganaste la fruta MÍTICA *${nombre}*! La suerte estuvo de tu lado.`
                }

                const nuevosTitulos = revisarTitulosAutomaticos(user, sender)
                guardarEconomia()
                if (nuevosTitulos.length) texto += `\n\n🎖️ *¡Nuevo título desbloqueado!* ${nuevosTitulos.join(', ')}`
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'usar' || command === 'item') {
                const user = getUsuario(sender)
                const query = text.trim().toLowerCase()
                if (!query) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}usar <nombre del ítem>`, `❌ Uso: ${prefix}use <nome do item>`, `❌ Usage: ${prefix}usar <name del item>`) }, { quoted: m })
                const idxInv = user.inventory.findIndex(it => it.toLowerCase().includes(query))
                if (idxInv === -1) return sendReply(sock, from, { text: tr(lang, '❌ No tienes ese ítem en tu inventario.', '❌ Você não tem esse item no inventário.', `❌ You don't have that item in your inventory.`) }, { quoted: m })
                const nombreInv = user.inventory[idxInv]
                const itemCat = ITEMS_CONSUMIBLES.find(i => nombreInv.toLowerCase().includes(i.nombre.toLowerCase()))
                if (!itemCat) return sendReply(sock, from, { text: tr(lang, '❌ Ese ítem no es consumible (es cosmético).', '❌ Esse item não é consumível (é cosmético).', '❌ That item is not consumable (it is cosmetic).') }, { quoted: m })

                const duelo = duelosActivos.get(from)
                const enDuelo = duelo && (normalizarJid(sender) === normalizarJid(duelo.p1) || normalizarJid(sender) === normalizarJid(duelo.p2))

                // --- Efectos que dependen del contexto (dentro o fuera de combate) ---
                const aplicarEfectoBase = () => {
                    let efectoTexto = ''
                    switch (itemCat.tipo) {
                        case 'curar':
                            if (enDuelo) { const slot = normalizarJid(sender) === normalizarJid(duelo.p1) ? 'p1' : 'p2'; setHp(duelo, slot, Math.min(user.maxHp, hpDe(duelo, slot) + itemCat.valor)) }
                            else user.hp = Math.min(user.maxHp, user.hp + itemCat.valor)
                            efectoTexto = `💚 Cura *${itemCat.valor}* HP.`
                            break
                        case 'energia':
                            if (enDuelo) { const slot = normalizarJid(sender) === normalizarJid(duelo.p1) ? 'p1' : 'p2'; setEn(duelo, slot, Math.min(user.maxEnergy, enDe(duelo, slot) + itemCat.valor)) }
                            else user.energy = Math.min(user.maxEnergy, user.energy + itemCat.valor)
                            efectoTexto = `🔋 Restaura *${itemCat.valor}⚡*.`
                            break
                        case 'buff_critico': {
                            const slot = normalizarJid(sender) === normalizarJid(duelo.p1) ? 'p1' : 'p2'
                            duelo.efectos[slot].proximoCriticoAsegurado = true
                            efectoTexto = `💉 Tu próximo *${prefix}attack* será crítico garantizado.`
                            break
                        }
                        case 'buff_escudo': {
                            const slot = normalizarJid(sender) === normalizarJid(duelo.p1) ? 'p1' : 'p2'
                            duelo.efectos[slot].proximoEscudoPct = itemCat.valor
                            efectoTexto = `🛡️ Bloquearás el ${Math.round(itemCat.valor * 100)}% del próximo golpe que recibas.`
                            break
                        }
                        case 'ticket_gacha': {
                            const resultado = tirarGachaFruta(0, { ticket: true })
                            if (!user.frutasObtenidas.includes(resultado.nombre)) user.frutasObtenidas.push(resultado.nombre)
                            if (resultado.categoria === 'divina') user.obtuvoSecreta = true
                            if (frutaPoseida(user, resultado.nombre) && (resultado.datos.dupRuletaGratis || resultado.datos.dupCoins)) {
                                const premioDup = (resultado.categoria === 'comun' || resultado.categoria === 'rara') ? 150 : 200
                                user.coins += premioDup
                                efectoTexto = `🎫 Duplicado de *${resultado.nombre}* → reembolso de $${premioDup}.`
                            } else {
                                otorgarFruta(user, resultado.nombre, resultado.categoria)
                                if (resultado.categoria === 'mitica') user.bounty += 100
                                if (resultado.categoria === 'divina') user.bounty += 500
                                efectoTexto = `🎫 Tirada gratis → obtuviste *${resultado.nombre}* [${resultado.categoria}]! (usa *${prefix}equiparfruta* para llevarla)`
                            }
                            break
                        }
                        case 'reset_stats': {
                            const gastados = Math.max(0, (user.stats.str - 10) + (user.stats.def - 10) + (user.stats.agi - 10) + (user.stats.int - 10))
                            user.stats = { str: 10, def: 10, agi: 10, int: 10 }
                            user.statPoints += gastados
                            efectoTexto = `🧬 Estadísticas reiniciadas. Recuperaste *${gastados}* puntos para repartir con *${prefix}statsup*.`
                            break
                        }
                        case 'boss_tracker': {
                            const anterior = bossSpawnChancePct
                            bossSpawnChancePct += itemCat.valor
                            setTimeout(() => { bossSpawnChancePct = Math.max(anterior, bossSpawnChancePct - itemCat.valor) }, itemCat.duracionMs)
                            efectoTexto = `📡 Probabilidad de aparición de Boss +${itemCat.valor}% durante 1 hora.`
                            break
                        }
                        case 'guardia': {
                            user.guardiasRobo += itemCat.valor
                            efectoTexto = `🛡️ Guardia de Seguridad activa: te protege de los próximos *${user.guardiasRobo}* intentos de robo.`
                            break
                        }
                        case 'buff_crit_temp': {
                            const slot = normalizarJid(sender) === normalizarJid(duelo.p1) ? 'p1' : 'p2'
                            duelo.efectos[slot].critBonusPct = itemCat.valor
                            duelo.efectos[slot].critBonusTurnos = itemCat.turnos
                            efectoTexto = `🍀 +${Math.round(itemCat.valor * 100)}% de probabilidad de crítico por ${itemCat.turnos} turnos.`
                            break
                        }
                        case 'buff_exploracion': {
                            user.buffExploracionRestante = (user.buffExploracionRestante || 0) + itemCat.valor
                            efectoTexto = `🧭 Tus próximas *${user.buffExploracionRestante}* exploraciones evitan eventos negativos.`
                            break
                        }
                        case 'curar_total': {
                            if (enDuelo) { const slot = normalizarJid(sender) === normalizarJid(duelo.p1) ? 'p1' : 'p2'; setHp(duelo, slot, user.maxHp) }
                            else user.hp = user.maxHp
                            user.itemsCurativosUsados = (user.itemsCurativosUsados || 0) + 1
                            efectoTexto = `❤️‍🩹 HP restaurada al máximo.`
                            break
                        }
                        case 'antidoto': {
                            if (enDuelo) {
                                const slot = normalizarJid(sender) === normalizarJid(duelo.p1) ? 'p1' : 'p2'
                                const est = duelo.efectos[slot]
                                est.dots = []; est.debuffAgiPct = 0; est.debuffAgiTurnos = 0; est.debuffDefPct = 0; est.debuffDefTurnos = 0
                                est.debuffStrPct = 0; est.debuffStrTurnos = 0; est.debuffIntPct = 0; est.debuffIntTurnos = 0
                                est.debuffDmgFlat = 0; est.debuffDmgFlatTurnos = 0; est.aturdidoTurnos = 0
                            } else {
                                user.debuffExpedicionStat = null
                                user.debuffExpedicionExpira = 0
                            }
                            user.itemsCurativosUsados = (user.itemsCurativosUsados || 0) + 1
                            efectoTexto = `🧪 Todos los estados negativos fueron eliminados.`
                            break
                        }
                        case 'buff_fortuna': {
                            user.buffFortunaRestante = (user.buffFortunaRestante || 0) + itemCat.usos
                            user.buffFortunaPct = itemCat.valor
                            efectoTexto = `🍀 +${Math.round(itemCat.valor * 100)}% de monedas en tus próximas *${user.buffFortunaRestante}* exploraciones/cacerías.`
                            break
                        }
                    }
                    return efectoTexto
                }

                if (itemCat.tipo === 'guardia' && enDuelo) {
                    return sendReply(sock, from, { text: tr(lang, `❌ *${itemCat.nombre}* no se puede usar durante un duelo.`, `❌ *${itemCat.nombre}* não pode ser usado durante um duelo.`, `❌ *${itemCat.nombre}* cannot be used during a duel.`) }, { quoted: m })
                }

                // Los buffs de combate solo tienen sentido dentro de un duelo activo
                if (['buff_critico', 'buff_escudo', 'buff_crit_temp'].includes(itemCat.tipo) && !enDuelo) {
                    return sendReply(sock, from, { text: tr(lang, `❌ *${itemCat.nombre}* solo se puede usar durante un duelo activo.`, `❌ *${itemCat.nombre}* só pode ser usado durante um duelo ativo.`, `❌ *${itemCat.nombre}* can only be used during an active duel.`) }, { quoted: m })
                }

                if (enDuelo) {
                    if (normalizarJid(sender) !== normalizarJid(duelo.turno)) return sendReply(sock, from, { text: tr(lang, '⏳ No es tu turno.', '⏳ Não é o seu turno.', '⏳ No es tu turno.') }, { quoted: m })
                    const esP1 = normalizarJid(sender) === normalizarJid(duelo.p1)
                    const slot = esP1 ? 'p1' : 'p2'
                    const rivalJid = esP1 ? duelo.p2 : duelo.p1
                    const inicio = procesarInicioTurno(duelo, slot, user)
                    let bloque = inicio.textos.length ? inicio.textos.join('\n') + '\n' : ''
                    if (hpDe(duelo, slot) <= 0) return finalizarDuelo(from, rivalJid, sender, `${bloque}\n☠️ @${sender.split('@')[0]} cayó por efectos de estado.`)
                    if (inicio.saltaTurno) { duelo.turno = rivalJid; return sendReply(sock, from, { text: `${bloque}\n➡️ ${tr(lang, 'Turno de', 'Vez de', 'Turn')}: @${rivalJid.split('@')[0]}`, mentions: [sender, rivalJid] }) }

                    user.inventory.splice(idxInv, 1)
                    const efectoTexto = aplicarEfectoBase()
                    guardarEconomia()
                    const rival = getUsuario(rivalJid)
                    const u1 = esP1 ? user : rival
                    const u2 = esP1 ? rival : user
                    duelo.turno = rivalJid
                    bloque += `🎒 @${sender.split('@')[0]} usó *${itemCat.nombre}*.\n${efectoTexto}\n\n${estadoCombateTexto(duelo, u1, u2)}\n➡️ ${tr(lang, 'Turno de', 'Vez de', 'Turn')}: @${rivalJid.split('@')[0]}`
                    await sendReply(sock, from, { text: bloque, mentions: [sender, rivalJid] })
                } else {
                    user.inventory.splice(idxInv, 1)
                    const efectoTexto = aplicarEfectoBase()
                    guardarEconomia()
                    await sendReply(sock, from, { text: tr(lang, `🎒 *${pushName}* usó *${itemCat.nombre}*.\n${efectoTexto}`, `🎒 *${pushName}* usou *${itemCat.nombre}*.\n${efectoTexto}`, `🎒 *${pushName}* used *${itemCat.nombre}*.\n${efectoTexto}`) }, { quoted: m })
                }
            }

            // ====================== WOLFRIC PROTOCOL: STATS ======================
            // ====================== WOLFRIC PROTOCOL: REGISTRO ======================
            if (command === 'crearperfil') {
                const user = getUsuario(sender)
                if (user.registrado) return sendReply(sock, from, { text: tr(lang, `✅ Ya tenés perfil creado, @${sender.split('@')[0]}.\n🆔 LID: ${sender}\nUsa *${prefix}stats* para verlo.`, `✅ Você já tem perfil, @${sender.split('@')[0]}.\n🆔 LID: ${sender}\nUse *${prefix}stats* para ver.`, `✅ You already have perfil creado, @${sender.split('@')[0]}.\n🆔 LID: ${sender}\nUse *${prefix}stats* para verlo.`), mentions: [sender] }, { quoted: m })

                user.registrado = true
                const f = frontierInicializar(user, pushName)
                f.regionActual = 'arca-inicial'
                f.regionesDescubiertas = ['arca-inicial']
                f.tutorial = { estado: 'pendiente', ruta: null, pasos: [], recompensaReclamada: false, creadoEn: Date.now() }
                const categoriasIniciales = ['comun', 'rara']
                const catInicial = categoriasIniciales[Math.floor(Math.random() * categoriasIniciales.length)]
                const nombreInicial = FRUTAS[catInicial].nombres[Math.floor(Math.random() * FRUTAS[catInicial].nombres.length)]
                otorgarFruta(user, nombreInicial, catInicial)
                user.coins += 300
                user.lifetimeCoinsEarned += 300
                const nivelesIniciales = frontierDarExp(user, 60)
                const fronteraInicial = frontierIntentarDesbloqueo(user)
                if (!user.logrosDesbloqueados.includes('Un gran comienzo')) user.logrosDesbloqueados.push('Un gran comienzo')
                guardarEconomia()

                const texto = lang === 'pt'
                    ? `${frontierTitulo('EXPLORADOR REGISTRADO', pushName, '🏙️')}

${frontierPanel('IDENTIDADE', [
    `🆔 LID: ${sender}`
], '⌁')}

${frontierPanel('CARGA DE BOAS-VINDAS', [
    `🍎 Fruta: ${nombreInicial} · ${catInicial}`,
    '🗡️ Punhos de Novato · arma inicial',
    '✨ Corte Básico · Arte inicial',
    '💰 +$300 créditos · 🏆 conquista Um grande começo',
    `📈 +60 EXP${nivelesIniciales ? ` · nível ${user.level}` : ''}${fronteraInicial ? ` · fronteira ${fronteraInicial.nombre} liberada` : ''}`
], '🎁')}

${frontierPanel('ARCA INICIAL', [
    `${prefix}start guide · monstro, fronteira e exploração.`,
    `${prefix}start skills · dungeon, Artes e equipamento.`,
    `${prefix}orientation · primeiro caminho recomendado.`
], '🚪')}

_O tutorial é opcional: o mundo fica aberto para você avançar do seu jeito._`
                    : `${frontierTitulo('EXPLORADOR REGISTRADO', pushName, '🏙️')}

${frontierPanel('IDENTIDAD', [
    `🆔 LID: ${sender}`
], '⌁')}

${frontierPanel('CARGA DE BIENVENIDA', [
    `🍎 Fruta: ${nombreInicial} · ${catInicial}`,
    '🗡️ Puños de Novato · arma inicial',
    '✨ Corte Básico · Arte inicial',
    '💰 +$300 créditos · 🏆 logro Un gran comienzo',
    `📈 +60 EXP${nivelesIniciales ? ` · nivel ${user.level}` : ''}${fronteraInicial ? ` · frontera ${fronteraInicial.nombre} habilitada` : ''}`
], '🎁')}

${frontierPanel('ARCA INICIAL', [
    `${prefix}start guide · entiende monstruos, fronteras y exploración.`,
    `${prefix}start skills · entiende mazmorras, Artes y equipo.`,
    `${prefix}orientation · recibe tu primer camino recomendado.`
], '🚪')}

_El tutorial es opcional: el mundo queda abierto para que avances a tu manera._`
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'stats') {
                const mentioned = getMentioned()
                const targetJid = mentioned.length ? mentioned[0] : sender
                const targetNombre = mentioned.length ? `@${targetJid.split('@')[0]}` : pushName
                const user = getUsuario(targetJid)
                const targetEsOwner = OWNERS.some(o => normalizarJid(o) === normalizarJid(targetJid))
                const targetEnOverdrive = overdriveActivo.has(normalizarJid(targetJid))
                const fEquipada = frutaEquipadaObj(user)
                const frutaTexto = fEquipada ? `${fEquipada.nombre} [${fEquipada.categoria}]${fEquipada.despertada ? tr(lang, ' 🌟 despertada', ' 🌟 despertada', ' 🌟 despertada') : ''}` : tr(lang, `Ninguna (usa ${prefix}fruitgacha)`, `Nenhuma (use ${prefix}fruitgacha)`, `Ninguna (use ${prefix}fruitgacha)`)

                // Si el jugador está en un duelo activo, el HP/EN mostrado es el HP/EN de combate en tiempo real (GDD V4.1 §2)
                let hpMostrado = user.hp, enMostrado = user.energy, notaDuelo = ''
                for (const duelo of duelosActivos.values()) {
                    const p1N = duelo.p1.split('@')[0].split(':')[0], p2N = duelo.p2.split('@')[0].split(':')[0]
                    const tN = targetJid.split('@')[0].split(':')[0]
                    if (tN === p1N) { hpMostrado = duelo.hp1; enMostrado = duelo.en1; notaDuelo = tr(lang, ' ⚔️ (en duelo)', ' ⚔️ (em duelo)', ' ⚔️ (en duel)') }
                    else if (tN === p2N) { hpMostrado = duelo.hp2; enMostrado = duelo.en2; notaDuelo = tr(lang, ' ⚔️ (en duelo)', ' ⚔️ (em duelo)', ' ⚔️ (en duel)') }
                }

                let tituloLinea = user.equippedTitle ? `🏆 Título: ${user.equippedTitle}` : ''
                if (targetEsOwner) {
                    tituloLinea = `🏆 Título: [SYSTEM ROOT] Arquitecto del Protocolo${targetEnOverdrive ? ' 🛑 (Protocolo Overdrive ACTIVO)' : ''}`
                }
                const gremioActual = gremioDe(targetJid)

                const texto = lang === 'pt'
                    ? `╔══════════════════════════════════╗
║   W O L F R I C   P R O T O C O L   ║
╚══════════════════════════════════╝
👤 Jogador: ${targetNombre}${notaDuelo}
${tituloLinea}
${gremioActual ? `🔰 Guild: [${gremioActual}]` : ''}
❤️ HP: [${renderBarra(hpMostrado, user.maxHp)}] ${Math.max(0, hpMostrado)}/${user.maxHp}
⚡ EN: [${renderBarra(enMostrado, user.maxEnergy)}] ${Math.max(0, enMostrado)}/${user.maxEnergy}
⭐ Nível: ${user.level}  (EXP: ${user.exp})

🍎 Fruta: ${frutaTexto}
💰 Moedas: $${user.coins}   💎 Gemas: ${user.gems}
💀 Bounty: $${user.bounty}   🍏 Frutas: ${user.frutasPoseidas.length}
🔥 Sequência: ${user.rachaActual} (melhor: ${user.rachaMejor})   🏆 Vitórias: ${user.wins}

❤️ HP: ${user.hp}/${user.maxHp}

📊 Atributos:
💪 STR: ${user.stats.str}   🛡️ DEF: ${user.stats.def}
🏃 AGI: ${user.stats.agi}   🧠 INT: ${user.stats.int}

🔧 Pontos livres: ${user.statPoints}
${user.statPoints > 0 ? `Use *${prefix}statsup <str/def/agi/int/hp> <quantidade>*` : ''}`
                    : `╔══════════════════════════════════╗
║   W O L F R I C   P R O T O C O L   ║
╚══════════════════════════════════╝
👤 Jugador: ${targetNombre}${notaDuelo}
${tituloLinea}
${gremioActual ? `🔰 Gremio: [${gremioActual}]` : ''}
❤️ HP: [${renderBarra(hpMostrado, user.maxHp)}] ${Math.max(0, hpMostrado)}/${user.maxHp}
⚡ EN: [${renderBarra(enMostrado, user.maxEnergy)}] ${Math.max(0, enMostrado)}/${user.maxEnergy}
⭐ Nivel: ${user.level}  (EXP: ${user.exp})

🍎 Fruta: ${frutaTexto}
💰 Monedas: $${user.coins}   💎 Gemas: ${user.gems}
💀 Bounty: $${user.bounty}   🍏 Frutas poseídas: ${user.frutasPoseidas.length}
🔥 Racha: ${user.rachaActual} (mejor: ${user.rachaMejor})   🏆 Victorias: ${user.wins}

❤️ HP: ${user.hp}/${user.maxHp}

📊 Atributos:
💪 STR: ${user.stats.str}   🛡️ DEF: ${user.stats.def}
🏃 AGI: ${user.stats.agi}   🧠 INT: ${user.stats.int}

🔧 Puntos sin asignar: ${user.statPoints}
${user.statPoints > 0 ? `Usa *${prefix}statsup <str/def/agi/int/hp> <cantidad>*` : ''}`

                await sendReply(sock, from, { text: texto, mentions: mentioned.length ? [targetJid] : [] }, { quoted: m })
            }

            if (command === 'statsup') {
                const user = getUsuario(sender)
                const stat = (args[0] || '').toLowerCase()
                const cantidad = parseInt(args[1])
                if (!['str', 'def', 'agi', 'int', 'hp'].includes(stat) || !cantidad || cantidad <= 0) {
                    return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}statsup <str/def/agi/int/hp> <cantidad>`, `❌ Uso: ${prefix}statsup <str/def/agi/int/hp> <quantidade>`, `❌ Usage: ${prefix}statsup <str/def/agi/int/hp> <amount>`) }, { quoted: m })
                }
                if (user.statPoints < cantidad) return sendReply(sock, from, { text: tr(lang, `❌ Solo tenés *${user.statPoints}* puntos disponibles.`, `❌ Você só tem *${user.statPoints}* pontos disponíveis.`, `❌ You only have *${user.statPoints}* points available.`) }, { quoted: m })
                user.statPoints -= cantidad
                if (stat === 'hp') {
                    user.maxHp += cantidad * 10
                    user.hp = user.maxHp
                    guardarEconomia()
                    return sendReply(sock, from, { text: tr(lang, `✅ +${cantidad} a *HP*. Máximo ahora: *${user.maxHp}*\nHP actual: ${user.hp}/${user.maxHp}\nPuntos restantes: ${user.statPoints}`, `✅ +${cantidad} em *HP*. Máximo agora: *${user.maxHp}*\nHP atual: ${user.hp}/${user.maxHp}\nPontos restantes: ${user.statPoints}`, `✅ +${cantidad} a *HP*. Máximo ahour: *${user.maxHp}*\nHP actual: ${user.hp}/${user.maxHp}\nPuntos restantes: ${user.statPoints}`) }, { quoted: m })
                }
                user.stats[stat] += cantidad
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `✅ +${cantidad} a *${stat.toUpperCase()}*. Ahora: ${user.stats[stat]}\nPuntos restantes: ${user.statPoints}`, `✅ +${cantidad} em *${stat.toUpperCase()}*. Agora: ${user.stats[stat]}\nPontos restantes: ${user.statPoints}`, `✅ +${cantidad} a *${stat.toUpperCase()}*. Ahour: ${user.stats[stat]}\nPuntos restantes: ${user.statPoints}`) }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: GACHA DE FRUTAS ======================
            if (command === 'fruitgacha') {
                const user = getUsuario(sender)
                if (user.coins < COSTO_GACHA_FRUTA) return sendReply(sock, from, { text: tr(lang, `❌ Necesitas $${COSTO_GACHA_FRUTA} monedas para desencriptar un paquete. Tienes $${user.coins}.`, `❌ Você precisa de $${COSTO_GACHA_FRUTA} moedas para abrir um pacote. Você tem $${user.coins}.`, `❌ You need $${COSTO_GACHA_FRUTA} coins para desencriptar un paquete. Tienes $${user.coins}.`) }, { quoted: m })
                user.coins -= COSTO_GACHA_FRUTA
                user.fruitGachaSpent += COSTO_GACHA_FRUTA
                const resultado = tirarGachaFruta(user.gachaPity)
                const pityAntes = user.gachaPity

                let mensajeExtra = ''
                if (['mitica', 'divina'].includes(resultado.categoria) || resultado.categoria === 'epica') {
                    user.gachaPity = 0
                } else {
                    user.gachaPity++
                }

                if (!user.frutasObtenidas.includes(resultado.nombre)) user.frutasObtenidas.push(resultado.nombre)
                if (resultado.categoria === 'divina') user.obtuvoSecreta = true

                if (frutaPoseida(user, resultado.nombre)) {
                    // Duplicado
                    if (resultado.datos.dupRuletaGratis) {
                        user.girosRuletaGratis = (user.girosRuletaGratis || 0) + 1
                        mensajeExtra = tr(lang, `\n🔁 ¡Duplicado épico! La red te regala un *giro gratis de Ruleta* (usalo con *${prefix}roulette*).`, `\n🔁 Duplicata épica! A rede te dá um *giro grátis de Roleta* (use *${prefix}roulette*).`, `\n🔁 Epic duplicate! The network gives you a *free Roulette spin* (use it with *${prefix}roulette*).`)
                    } else if (resultado.datos.dupCoins) {
                        user.coins += resultado.datos.dupCoins
                        mensajeExtra = tr(lang, `\n🔁 Tu código genético ya contenía esta fruta: el sistema la recicla como *$${resultado.datos.dupCoins}* monedas.`, `\n🔁 Você já tinha essa fruta: o sistema recicla em *$${resultado.datos.dupCoins}* moedas.`, `\n🔁 Tu code genético ya contenía esta fruit: el sistema la recicla como *$${resultado.datos.dupCoins}* coins.`)
                    } else {
                        mensajeExtra = tr(lang, `\n🔁 ¡Duplicado de una fruta ${resultado.categoria}! Queda registrado como logro en tu perfil.`, `\n🔁 Duplicata de uma fruta ${resultado.categoria}! Fica registrada no seu perfil.`, `\n🔁 Duplicate of a ${resultado.categoria} fruit! It is logged as an achievement on your profile.`)
                    }
                } else {
                    otorgarFruta(user, resultado.nombre, resultado.categoria)
                    if (resultado.categoria === 'mitica') user.bounty += 100
                    if (resultado.categoria === 'divina') user.bounty += 500
                    mensajeExtra = tr(lang, `\n🍏 Se agregó a tu colección. Equipalá con *${prefix}equipfruit ${resultado.nombre}* si no era tu única fruta.`, `\n🍏 Entrou na sua coleção. Equipe com *${prefix}equipfruit ${resultado.nombre}* se não for a única.`, `\n🍏 Se agregó a tu colección. Equipalá con *${prefix}equipfruit ${resultado.nombre}* si no era tu única fruit.`)
                }
                registrarUsoFruta(resultado.nombre)

                const nuevosTitulosGacha = revisarTitulosAutomaticos(user, sender)
                guardarEconomia()

                const emojis = { comun: '🟢', rara: '🔵', epica: '🟣', mitica: '🔴', divina: '🌈' }
                const narrativa = lang === 'pt' ? {
                    comun: 'O pacote abre sem resistência: um código instável, mas funcional.',
                    rara: 'A descriptografia demorou mais que o normal — sequências elementares estáveis surgem dos dados.',
                    epica: 'O firewall quase bloqueou o download! Um código anômalo de alta pureza passa.',
                    mitica: 'Alarmes silenciosos percorrem a rede: um fragmento do código-fonte original de Wolfric acabou de aparecer.',
                    divina: 'O servidor inteiro treme. Você está vendo uma anomalia quântica que não deveria existir.'
                } : {
                    comun: 'El paquete se descomprime sin resistencia: un código inestable pero funcional.',
                    rara: 'La desencriptación tardó más de lo normal — secuencias elementales estables emergen de los datos.',
                    epica: '¡El firewall casi rechaza la descarga! Un código anómalo de alta pureza se abre paso.',
                    mitica: 'Alarmas silenciosas recorren la red: un fragmento del código fuente original de Wolfric acaba de manifestarse.',
                    divina: 'El servidor entero tiembla. Estás presenciando una anomalía cuántica que no debería existir.'
                }
                let texto = `${frontierTitulo(tr(lang, '𝗚𝗔𝗖𝗛𝗔 𝗗𝗘 𝗙𝗥𝗨𝗧𝗔𝗦', '𝗚𝗔𝗖𝗛𝗔 𝗗𝗘 𝗙𝗥𝗨𝗧𝗔𝗦', '𝗚𝗔𝗖𝗛𝗔 𝗗𝗘 𝗙𝗥𝗨𝗧𝗔𝗦'), tr(lang, 'La fruta define tus habilidades y tu estilo de juego', 'A fruta define suas habilidades e seu estilo', 'La fruit define tus skills y tu style de juego'), '🍎')}\n\n${narrativa[resultado.categoria]}\n\n${frontierPanel(tr(lang, '𝗥𝗘𝗦𝗨𝗟𝗧𝗔𝗗𝗢', '𝗥𝗘𝗦𝗨𝗟𝗧𝗔𝗗𝗢', '𝗥𝗘𝗦𝗨𝗟𝗧𝗔𝗗𝗢'), [`${emojis[resultado.categoria]} ${tr(lang, 'Rareza', 'Raridade', 'Rareza')}: ${resultado.categoria.toUpperCase()}`, `🍏 Fruta: ${resultado.nombre}${mensajeExtra}`, tr(lang, `💰 Monedas restantes: $${user.coins}`, `💰 Moedas restantes: $${user.coins}`, `💰 Coins left: $${user.coins}`)], '🎲')}`
                if (pityAntes >= 50) texto += tr(lang, `\n🍀 Sistema de Lástima activo (tirada #${pityAntes + 1} sin Mítica/Secreta).`, `\n🍀 Pity ativo (jogada #${pityAntes + 1} sem Mítica/Secreta).`, `\n🍀 Sistema de Lástima activo (tirada #${pityAntes + 1} sin Mítica/Secreta).`)
                if (nuevosTitulosGacha.length) texto += tr(lang, `\n\n🎖️ *¡Nuevo título desbloqueado!* ${nuevosTitulosGacha.join(', ')}`, `\n\n🎖️ *Novo título desbloqueado!* ${nuevosTitulosGacha.join(', ')}`, `\n\n🎖️ *Nuevo title desbloqueado!* ${nuevosTitulosGacha.join(', ')}`)
                if (resultado.categoria === 'divina') {
                    texto = tr(lang, `🌈🌈🌈 *¡¡¡JACKPOT GLOBAL!!!* 🌈🌈🌈\n\nToda la red Wolfric detecta el evento: *${pushName}* acaba de desencriptar la fruta SECRETA *${resultado.nombre}* ⏳\n\n`, `🌈🌈🌈 *JACKPOT GLOBAL!!!* 🌈🌈🌈\n\nA rede Wolfric inteira detecta o evento: *${pushName}* descriptografou a fruta SECRETA *${resultado.nombre}* ⏳\n\n`, `🌈🌈🌈 *JACKPOT GLOBAL!!!* 🌈🌈🌈\n\nToda la red Wolfric detecta el event: *${pushName}* acaba de desencriptar la fruit SECRETA *${resultado.nombre}* ⏳\n\n`) + texto
                }

                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'fruitfree') {
                const user = getUsuario(sender)
                const ahora = Date.now()
                const unDia = 24 * 60 * 60 * 1000
                if (ahora - user.lastFruitFree < unDia) {
                    const restante = unDia - (ahora - user.lastFruitFree)
                    return sendReply(sock, from, { text: tr(lang, `⏳ Ya usaste tu tirada gratis de hoy. Vuelve en *${clockString(restante)}*.`, `⏳ Você já usou a jogada grátis de hoje. Volte em *${clockString(restante)}*.`, `⏳ You already used tu tirada gratis de hoy. Vuelve en *${clockString(restante)}*.`) }, { quoted: m })
                }
                user.lastFruitFree = ahora
                const resultado = tirarGachaFruta(0) // no acumula pity

                let mensajeExtra = ''
                if (!user.frutasObtenidas.includes(resultado.nombre)) user.frutasObtenidas.push(resultado.nombre)
                if (resultado.categoria === 'divina') user.obtuvoSecreta = true
                if (frutaPoseida(user, resultado.nombre)) {
                    if (resultado.datos.dupRuletaGratis) {
                        user.girosRuletaGratis = (user.girosRuletaGratis || 0) + 1
                        mensajeExtra = tr(lang, `\n🔁 ¡Duplicado épico! Ganaste un *giro gratis de Ruleta*.`, `\n🔁 Duplicata épica! Você ganhou um *giro grátis de Roleta*.`, `\n🔁 Epic duplicate! You won a *free Roulette spin*.`)
                    } else if (resultado.datos.dupCoins) {
                        user.coins += resultado.datos.dupCoins
                        mensajeExtra = tr(lang, `\n🔁 Duplicado, convertido en *$${resultado.datos.dupCoins}* monedas.`, `\n🔁 Duplicata convertida em *$${resultado.datos.dupCoins}* moedas.`, `\n🔁 Duplicado, convertido en *$${resultado.datos.dupCoins}* coins.`)
                    }
                } else {
                    otorgarFruta(user, resultado.nombre, resultado.categoria)
                    if (resultado.categoria === 'mitica') user.bounty += 100
                    if (resultado.categoria === 'divina') user.bounty += 500
                }
                guardarEconomia()

                const emojis = { comun: '🟢', rara: '🔵', epica: '🟣', mitica: '🔴', divina: '🌈' }
                await sendReply(sock, from, { text: tr(lang, `🎁 *PAQUETE PROMOCIONAL DIARIO*\n\nLa red Wolfric te concede una desencriptación gratuita.\n\n${emojis[resultado.categoria]} *Rareza:* ${resultado.categoria.toUpperCase()}\n🍏 *Fruta:* ${resultado.nombre}${mensajeExtra}`, `🎁 *PACOTE PROMOCIONAL DIÁRIO*\n\nA rede Wolfric te dá uma descriptografia grátis.\n\n${emojis[resultado.categoria]} *Raridade:* ${resultado.categoria.toUpperCase()}\n🍏 *Fruta:* ${resultado.nombre}${mensajeExtra}`, `🎁 *PAQUETE PROMOCIONAL DIARIO*\n\nLa red Wolfric te concede una desencriptación gratuita.\n\n${emojis[resultado.categoria]} *Rareza:* ${resultado.categoria.toUpperCase()}\n🍏 *Fruta:* ${resultado.nombre}${mensajeExtra}`) }, { quoted: m })
            }

            if (command === 'fruits') {
                let texto = `${frontierTitulo('𝗖𝗔𝗧𝗔́𝗟𝗢𝗚𝗢 𝗗𝗘 𝗙𝗥𝗨𝗧𝗔𝗦', 'Colecciona, equipa y despierta poderes', '🍎')}\n\n`
                for (const [cat, datos] of Object.entries(FRUTAS)) {
                    texto += `*${cat.toUpperCase()}*: ${datos.nombres.join(', ')}\n`
                }
                texto += tr(lang, `\nCosto por tirada: $${COSTO_GACHA_FRUTA}\nUsa *${prefix}fruitgacha* o *${prefix}fruitfree* (1 vez al día).\nUsa *${prefix}skillinfo <fruta>* para ver su Habilidad y Ultimate.`, `\nCusto por jogada: $${COSTO_GACHA_FRUTA}\nUse *${prefix}fruitgacha* ou *${prefix}fruitfree* (1 vez ao dia).\nUse *${prefix}skillinfo <fruta>* para ver Habilidade e Ultimate.`, `\nCosto por tirada: $${COSTO_GACHA_FRUTA}\nUse *${prefix}fruitgacha* o *${prefix}fruitfree* (1 vez al day).\nUse *${prefix}skillinfo <fruit>* para ver su Habilidad y Ultimate.`)
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'skillinfo') {
                const nombreFruta = text.trim()
                if (!nombreFruta) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}skillinfo <nombre de la fruta>`, `❌ Uso: ${prefix}skillinfo <nome da fruta>`, `❌ Usage: ${prefix}skillinfo <name de la fruit>`) }, { quoted: m })
                const clave = Object.keys(HABILIDADES_FRUTA).find(k => k.toLowerCase() === nombreFruta.toLowerCase())
                if (!clave) return sendReply(sock, from, { text: tr(lang, `❌ Esa fruta no existe. Usa *${prefix}fruits* para ver el catálogo.`, `❌ Essa fruta não existe. Use *${prefix}fruits* para ver o catálogo.`, `❌ Esa fruit no existe. Use *${prefix}fruits* para ver el catálogo.`) }, { quoted: m })
                const hab = HABILIDADES_FRUTA[clave]
                const texto = `${frontierTitulo(`𝗙𝗥𝗨𝗧𝗔 · ${clave.toUpperCase()}`, tr(lang,'Kit de combate','Kit de combate','Combat kit'), '🍏')}\n\n${frontierPanel(tr(lang,'𝗛𝗔𝗕𝗜𝗟𝗜𝗗𝗔𝗗 𝟭','𝗛𝗔𝗕𝗜𝗟𝗜𝗗𝗔𝗗𝗘 𝟭','𝗦𝗞𝗜𝗟𝗟 𝟭'), [`⚡ ${hab.habilidad1.nombre} · ${hab.habilidad1.costo}⚡`, describirHabilidad(hab.habilidad1, lang)], '◈')}\n\n${frontierPanel('𝗨𝗟𝗧𝗜𝗠𝗔𝗧𝗘', [`🌟 ${hab.ultimate.nombre} · ${hab.ultimate.costo}⚡`, tr(lang, `Despertar: nivel ${DESPERTAR_NIVEL_MIN} y $${hab.ultimate.costoDespertar}`, `Despertar: nível ${DESPERTAR_NIVEL_MIN} e $${hab.ultimate.costoDespertar}`, `Awaken: level ${DESPERTAR_NIVEL_MIN} and $${hab.ultimate.costoDespertar}`), describirHabilidad(hab.ultimate, lang)], '✦')}`
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: ESTILOS DE COMBATE (GDD V4.0 §4.1) ======================
            if (command === 'estilos') {
                const user = getUsuario(sender)
                let texto = `${frontierTitulo('𝗘𝗦𝗧𝗜𝗟𝗢𝗦 𝗗𝗘 𝗖𝗢𝗠𝗕𝗔𝗧𝗘', 'Pasivas para el ataque físico', '🥋')}\n\n`
                ESTILOS_COMBATE.forEach(e => {
                    const tiene = user.estilosComprados.includes(e.id)
                    const equipado = user.estiloEquipado === e.id
                    texto += `${equipado ? '👑' : tiene ? '✅' : '🔒'} *${e.nombre}* — Nvl. ${e.nivelMin} — $${e.precio}${e.requiereTodos ? ' (requiere TODOS los estilos anteriores)' : ''}\n📋 ${e.desc}\n\n`
                })
                texto += tr(lang, `Usa *${prefix}buystyle <nombre>* y *${prefix}equipstyle <nombre>*.`, `Use *${prefix}buystyle <nome>* e *${prefix}equipstyle <nome>*.`, `Use *${prefix}buystyle <name>* y *${prefix}equipstyle <name>*.`)
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'comprarestilo') {
                const user = getUsuario(sender)
                const nombreEstilo = text.trim().toLowerCase()
                const estilo = ESTILOS_COMBATE.find(e => e.nombre.toLowerCase() === nombreEstilo || e.id === nombreEstilo)
                if (!estilo) return sendReply(sock, from, { text: tr(lang, `❌ Estilo no encontrado. Usa *${prefix}styles* para ver el catálogo.`, `❌ Estilo não encontrado. Use *${prefix}styles* para ver o catálogo.`, `❌ Estilo no encontrado. Use *${prefix}styles* para ver el catálogo.`) }, { quoted: m })
                if (user.estilosComprados.includes(estilo.id)) return sendReply(sock, from, { text: tr(lang, `✅ Ya tienes *${estilo.nombre}*. Equípalo con *${prefix}equipstyle ${estilo.nombre}*.`, `✅ Você já tem *${estilo.nombre}*. Equipe com *${prefix}equipstyle ${estilo.nombre}*.`, `✅ Ya tienes *${estilo.nombre}*. Equípalo con *${prefix}equipstyle ${estilo.nombre}*.`) }, { quoted: m })
                if (user.level < estilo.nivelMin) return sendReply(sock, from, { text: tr(lang, `❌ Necesitas nivel *${estilo.nivelMin}* (tienes ${user.level}).`, `❌ Você precisa do nível *${estilo.nivelMin}* (você tem ${user.level}).`, `❌ You need level *${estilo.nivelMin}* (tienes ${user.level}).`) }, { quoted: m })
                if (estilo.requiereTodos) {
                    const faltantes = ESTILOS_COMBATE.filter(e => e.id !== estilo.id).filter(e => !user.estilosComprados.includes(e.id))
                    if (faltantes.length) return sendReply(sock, from, { text: tr(lang, `❌ *Godhuman* requiere TODOS los estilos anteriores. Te falta: ${faltantes.map(f => f.nombre).join(', ')}.`, `❌ *Godhuman* exige TODOS os estilos anteriores. Falta: ${faltantes.map(f => f.nombre).join(', ')}.`, `❌ *Godhuman* requiere TODOS los styles anteriores. Te falta: ${faltantes.map(f => f.nombre).join(', ')}.`) }, { quoted: m })
                }
                if (user.coins < estilo.precio) return sendReply(sock, from, { text: tr(lang, `❌ Necesitas $${estilo.precio} (tienes $${user.coins}).`, `❌ Você precisa de $${estilo.precio} (você tem $${user.coins}).`, `❌ You need $${estilo.precio} (tienes $${user.coins}).`) }, { quoted: m })
                user.coins -= estilo.precio
                user.estilosComprados.push(estilo.id)
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `🥋 *¡${estilo.nombre} aprendido!* Equípalo con *${prefix}equipstyle ${estilo.nombre}*.`, `🥋 *${estilo.nombre} aprendido!* Equipe com *${prefix}equipstyle ${estilo.nombre}*.`, `🥋 *${estilo.nombre} aprendido!* Equípalo con *${prefix}equipstyle ${estilo.nombre}*.`) }, { quoted: m })
            }

            if (command === 'equiparestilo') {
                const user = getUsuario(sender)
                const nombreEstilo = text.trim().toLowerCase()
                const estilo = ESTILOS_COMBATE.find(e => e.nombre.toLowerCase() === nombreEstilo || e.id === nombreEstilo)
                if (!estilo) return sendReply(sock, from, { text: tr(lang, `❌ Estilo no encontrado. Usa *${prefix}styles* para ver el catálogo.`, `❌ Estilo não encontrado. Use *${prefix}styles* para ver o catálogo.`, `❌ Estilo no encontrado. Use *${prefix}styles* para ver el catálogo.`) }, { quoted: m })
                if (!user.estilosComprados.includes(estilo.id)) return sendReply(sock, from, { text: tr(lang, `❌ No has comprado *${estilo.nombre}*. Usa *${prefix}buystyle ${estilo.nombre}*.`, `❌ Você não comprou *${estilo.nombre}*. Use *${prefix}buystyle ${estilo.nombre}*.`, `❌ No has comprado *${estilo.nombre}*. Use *${prefix}buystyle ${estilo.nombre}*.`) }, { quoted: m })
                user.estiloEquipado = estilo.id
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `🥋 Estilo equipado: *${estilo.nombre}*. Tus próximos *${prefix}attack* aplicarán sus efectos.`, `🥋 Estilo equipado: *${estilo.nombre}*. Seus próximos *${prefix}attack* vão aplicar os efeitos.`, `🥋 Estilo equipped: *${estilo.nombre}*. Tus próximos *${prefix}attack* aplicarán sus efectos.`) }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: COMBATE PvP ======================
            // Cierra un duelo por K.O., aplica recompensas/penalizaciones y sube de nivel al ganador.
            async function finalizarDuelo(chatId, ganadorJid, perdedorJid, motivo) {
                const ganador = getUsuario(ganadorJid)
                const perdedor = getUsuario(perdedorJid)
                const duelo = duelosActivos.get(chatId)
                duelosActivos.delete(chatId)
                perdedor.derrotas = (perdedor.derrotas || 0) + 1

                // ---- Sistema de Bounty: cuanto más vale el rival, más grande la recompensa ----
                const bountyRobado = Math.max(10, Math.floor(perdedor.bounty * 0.15))
                perdedor.bounty = Math.max(50, perdedor.bounty - bountyRobado)
                ganador.bounty += bountyRobado + 10 // +10 fijo por la victoria en sí

                const premio = Math.floor(Math.random() * 100) + 50 + Math.floor(perdedor.bounty * 0.5)
                ganador.coins += premio
                ganador.lifetimeCoinsEarned += premio
                perdedor.coins = Math.max(0, perdedor.coins - Math.floor(perdedor.coins * 0.1))
                ganador.exp += 35
                ganador.wins++
                ganador.statPoints += 1 // punto garantizado por victoria, además de los que da subir de nivel
                ganador.rachaActual++
                if (ganador.rachaActual > ganador.rachaMejor) ganador.rachaMejor = ganador.rachaActual
                perdedor.rachaActual = 0
                sumarPuntosGuerra(ganadorJid, 15)
                let subioNivel = false
                // subir de nivel: cada (nivel*100) exp = 1 nivel = 3 puntos de stat
                while (ganador.exp >= ganador.level * 20) {
                    ganador.exp -= ganador.level * 20
                    ganador.level++
                    ganador.statPoints += 3
                    subioNivel = true
                }

                // Títulos "Asesino Implacable" (ganar en <3 turnos) e "Intocable" (ganar sin recibir daño)
                if (duelo) {
                    const slotGanador = normalizarJidGlobal(ganadorJid) === normalizarJidGlobal(duelo.p1) ? 'p1' : 'p2'
                    if (duelo.turnos > 0 && duelo.turnos < 3) ganador.ganoDueloRapido = true
                    if (duelo.sinDaño[slotGanador]) ganador.ganoDueloSinDaño = true
                }

                const nuevosTitulos = revisarTitulosAutomaticos(ganador, ganadorJid)
                guardarEconomia()
                let texto = lang === 'pt'
                    ? `${motivo}\n\n🏆 *@${ganadorJid.split('@')[0]} venceu o duelo!* +${premio} moedas, +35 EXP, +1 ponto de atributo${subioNivel ? ` (subiu para *nível ${ganador.level}*! +3 pontos extra)` : ''}.\n💀 Você tirou *$${bountyRobado}* de Bounty de @${perdedorJid.split('@')[0]} (seu Bounty agora: $${ganador.bounty}).\n🔥 Sequência atual: *${ganador.rachaActual}*${ganador.rachaActual === ganador.rachaMejor && ganador.rachaActual > 1 ? ' (recorde pessoal!)' : ''}\nUse *${prefix}statsup <str/def/agi/int> <quantidade>* para distribuir.`
                    : `${motivo}\n\n🏆 *¡@${ganadorJid.split('@')[0]} ganó el duelo!* +${premio} monedas, +35 EXP, +1 punto de estadística${subioNivel ? ` (¡y subió a *nivel ${ganador.level}*! +3 puntos extra)` : ''}.\n💀 Le arrebataste *$${bountyRobado}* de Bounty a @${perdedorJid.split('@')[0]} (tu Bounty ahora: $${ganador.bounty}).\n🔥 Racha actual: *${ganador.rachaActual}*${ganador.rachaActual === ganador.rachaMejor && ganador.rachaActual > 1 ? ' (¡récord personal!)' : ''}\nUsa *${prefix}statsup <str/def/agi/int> <cantidad>* para repartirlos.`
                if (nuevosTitulos.length) texto += tr(lang, `\n\n🎖️ *¡Nuevo título desbloqueado!* ${nuevosTitulos.join(', ')}\nÚsalo con *${prefix}titleequip <nombre>*`, `\n\n🎖️ *Novo título desbloqueado!* ${nuevosTitulos.join(', ')}\nUse *${prefix}titleequip <nome>*`, `\n\n🎖️ *Nuevo title desbloqueado!* ${nuevosTitulos.join(', ')}\nÚsalo con *${prefix}titleequip <name>*`)
                await sendReply(sock, chatId, { text: texto, mentions: [ganadorJid, perdedorJid] }, { quoted: m })
            }

            if (command === 'duel') {
                if (!isGroup) return sendReply(sock, from, { text: tr(lang, '❌ Los duelos solo funcionan en grupos.', '❌ Os duelos só funcionam em grupos.', '❌ Duels only work in groups.') }, { quoted: m })
                if (pvpDeshabilitado) return sendReply(sock, from, { text: tr(lang, '🚫 El PvP está deshabilitado globalmente en este momento.', '🚫 O PvP está desativado globalmente agora.', '🚫 PvP is disabled globally right now.') }, { quoted: m })
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Etiqueta a quién retas. Ej: ${prefix}duel @usuario`, `❌ Marque quem você desafia. Ex: ${prefix}duel @usuario`, `❌ Tag who you are challenging. Ex: ${prefix}duel @user`) }, { quoted: m })
                if (normalizarJid(mentioned[0]) === normalizarJid(sender)) return sendReply(sock, from, { text: tr(lang, '❌ No puedes retarte a ti mismo.', '❌ Você não pode desafiar a si mesmo.', `❌ You can't retarte a ti mismo.`) }, { quoted: m })
                if (duelosActivos.has(from)) return sendReply(sock, from, { text: tr(lang, '❌ Ya hay un duelo activo en este chat.', '❌ Já existe um duelo ativo neste chat.', `❌ There is already an active duel in this chat.`) }, { quoted: m })

                duelosPendientes.set(from, { retador: sender, retado: mentioned[0], timestamp: Date.now() })
                setTimeout(() => {
                    const pendiente = duelosPendientes.get(from)
                    if (pendiente && pendiente.timestamp === duelosPendientes.get(from)?.timestamp) duelosPendientes.delete(from)
                }, 5 * 60 * 1000)

                await sendReply(sock, from, { text: tr(lang, `⚔️ *${pushName}* reta a un duelo a @${mentioned[0].split('@')[0]}!\n\nUsa *${prefix}acceptduel* para aceptar (expira en 5 min).`, `⚔️ *${pushName}* desafia @${mentioned[0].split('@')[0]} para um duelo!\n\nUse *${prefix}acceptduel* para aceitar (expira em 5 min).`, `⚔️ *${pushName}* reta a un duel a @${mentioned[0].split('@')[0]}!\n\nUse *${prefix}acceptduel* para aceptar (expira en 5 min).`), mentions: [sender, mentioned[0]] }, { quoted: m })
            }

            if (command === 'acceptduel') {
                if (!isGroup) return
                const pendiente = duelosPendientes.get(from)
                if (!pendiente) return sendReply(sock, from, { text: tr(lang, '❌ No hay ningún duelo pendiente en este chat.', '❌ Não há duelo pendente neste chat.', `❌ There is no pending duel in this chat.`) }, { quoted: m })
                if (normalizarJid(sender) !== normalizarJid(pendiente.retado)) return sendReply(sock, from, { text: tr(lang, '❌ Ese duelo no es para ti.', '❌ Esse duelo não é para você.', '❌ That duel is not for you.') }, { quoted: m })

                const u1 = getUsuario(pendiente.retador)
                const u2 = getUsuario(pendiente.retado)
                // Iniciativa por AGI (GDD V4.1 §2.2) — empate: gana quien inició el duelo
                const primerTurno = u1.stats.agi >= u2.stats.agi ? pendiente.retador : pendiente.retado

                const statsNormalizados = normalizarStatsParaDuelo(u1, u2)
                const duelo = {
                    p1: pendiente.retador, p2: pendiente.retado,
                    hp1: u1.maxHp, hp2: u2.maxHp,
                    en1: u1.maxEnergy, en2: u2.maxEnergy,
                    turno: primerTurno, timestamp: Date.now(),
                    efectos: { p1: nuevoEstadoCombate(), p2: nuevoEstadoCombate() },
                    turnos: 0, sinDaño: { p1: true, p2: true },
                    statsNormalizados,
                    lang
                }
                duelosActivos.set(from, duelo)
                duelosPendientes.delete(from)

                await sendReply(sock, from, {
                    text: `${frontierTitulo(tr(lang, '𝗗𝗨𝗘𝗟𝗢 𝗜𝗡𝗜𝗖𝗜𝗔𝗗𝗢', '𝗗𝗨𝗘𝗟𝗢 𝗜𝗡𝗜𝗖𝗜𝗔𝗗𝗢', '𝗗𝗨𝗘𝗟 𝗦𝗧𝗔𝗥𝗧𝗘𝗗'), `@${pendiente.retador.split('@')[0]} VS @${pendiente.retado.split('@')[0]}`, '⚔️')}\n\n${estadoCombateTexto(duelo, u1, u2)}\n➡️ ${tr(lang, 'Turno de', 'Vez de', 'Turn')}: @${primerTurno.split('@')[0]}\n\n${frontierPanel(tr(lang, '𝗔𝗖𝗖𝗜𝗢𝗡𝗘𝗦', '𝗔𝗖̧𝗢̃𝗘𝗦', '𝗔𝗖𝗧𝗜𝗢𝗡𝗦'), [`${prefix}attack · ${tr(lang, 'golpe físico', 'golpe físico', 'physical hit')}`, `${prefix}arte · Arte`, `${prefix}useskill · fruta`, `${prefix}ultimate · ${tr(lang, 'fruta despertada', 'fruta despertada', 'awakened fruit')}`, `${prefix}defend · ${tr(lang, 'escudo', 'escudo', 'shield')}`], '🎯')}${statsNormalizados ? tr(lang, '\n\n⚖️ Gran diferencia de nivel detectada: los stats de combate se ajustaron para que sea un duelo parejo (solo durante esta pelea).', '\n\n⚖️ Grande diferença de nível: os stats foram ajustados só neste duelo.', '\n\n⚖️ Big level gap detected: combat stats were adjusted so this duel stays fair (only for this fight).') : ''}`,
                    mentions: [pendiente.retador, pendiente.retado]
                }, { quoted: m })
            }

            if (command === 'attack' || command === 'useskill' || command === 'ultimate' || command === 'arte' || command === 'usararte' || command === 'defender' || command === 'atacar' || command === 'habilidad') {
                const cmdReal = (command === 'atacar') ? 'attack' : (command === 'habilidad') ? 'useskill' : (command === 'usararte') ? 'arte' : command
                const duelo = duelosActivos.get(from)
                if (!duelo) return sendReply(sock, from, { text: tr(lang, `❌ No hay duelo activo. Usa *${prefix}duel @usuario* para empezar uno.`, `❌ Não há duelo ativo. Use *${prefix}duel @usuario* para começar.`, `❌ There is no active duel. Use *${prefix}duel @user* to start one.`) }, { quoted: m })
                if (normalizarJid(sender) !== normalizarJid(duelo.turno)) return sendReply(sock, from, { text: tr(lang, '⏳ No es tu turno.', '⏳ Não é o seu turno.', '⏳ No es tu turno.') }, { quoted: m })

                const esP1 = normalizarJid(sender) === normalizarJid(duelo.p1)
                const slotAtacante = esP1 ? 'p1' : 'p2'
                const slotDefensor = esP1 ? 'p2' : 'p1'
                const atacanteJid = esP1 ? duelo.p1 : duelo.p2
                const defensorJid = esP1 ? duelo.p2 : duelo.p1
                const atacante = getUsuario(atacanteJid)
                const defensor = getUsuario(defensorJid)
                const u1 = esP1 ? atacante : defensor
                const u2 = esP1 ? defensor : atacante
                const overdrive = overdriveActivo.has(normalizarJid(atacanteJid))

                // ---- Inicio de turno: regenera energía y procesa dots/aturdimiento/debuffs ----
                const inicio = procesarInicioTurno(duelo, slotAtacante, atacante)
                let bloque = inicio.textos.length ? inicio.textos.join('\n') + '\n' : ''

                if (hpDe(duelo, slotAtacante) <= 0) {
                    // murió por dot al inicio de su propio turno
                    return finalizarDuelo(from, defensorJid, atacanteJid, `${bloque}\n☠️ @${atacanteJid.split('@')[0]} cayó por efectos de estado.`)
                }

                if (inicio.saltaTurno) {
                    duelo.turno = defensorJid
                    return sendReply(sock, from, { text: `${bloque}\n${estadoCombateTexto(duelo, u1, u2)}\n➡️ ${tr(lang, 'Turno de', 'Vez de', 'Turn')}: @${defensorJid.split('@')[0]}`, mentions: [atacanteJid, defensorJid] })
                }

                // ---- Mina (Bomba): si estaba marcado y ataca físicamente, explota ----
                if (cmdReal === 'attack' && duelo.efectos[slotAtacante].reflejoTurnos > 0) {
                    const autoDaño = Math.max(5, Math.floor(atacante.maxHp * 0.08))
                    setHp(duelo, slotAtacante, Math.max(0, hpDe(duelo, slotAtacante) - autoDaño))
                    duelo.efectos[slotAtacante].reflejoTurnos = 0
                    bloque += `💣 ¡La mina colocada explota! @${atacanteJid.split('@')[0]} recibe *${autoDaño}* de daño reflejado.\n`
                    if (hpDe(duelo, slotAtacante) <= 0) {
                        return finalizarDuelo(from, defensorJid, atacanteJid, `${bloque}\n☠️ @${atacanteJid.split('@')[0]} cayó por la explosión.`)
                    }
                }

                if (cmdReal === 'defender') {
                    duelo.efectos[slotAtacante].proximoEscudoPct = Math.max(duelo.efectos[slotAtacante].proximoEscudoPct || 0, 0.35)
                    setEn(duelo, slotAtacante, Math.min(atacante.maxEnergy, enDe(duelo, slotAtacante) + 10))
                    duelo.turnos++
                    duelo.turno = defensorJid
                    const textoDefensa = `${frontierPanel('𝗣𝗢𝗦𝗜𝗖𝗜𝗢́𝗡 𝗗𝗘𝗙𝗘𝗡𝗦𝗜𝗩𝗔', [`@${atacanteJid.split('@')[0]} prepara un escudo de datos.`, 'El próximo impacto recibido se reduce 35%.', '+10⚡ recuperadas.'], '🛡️')}\n\n${estadoCombateTexto(duelo, u1, u2)}\n➡️ ${tr(lang, 'Turno de', 'Vez de', 'Turn')}: @${defensorJid.split('@')[0]}`
                    return sendReply(sock, from, { text: textoDefensa, mentions: [atacanteJid, defensorJid] }, { quoted: m })
                }

                let habilidad, esFisico = false, fruitaUsada = null, arteUsada = null
                if (cmdReal === 'attack') {
                    esFisico = true
                    habilidad = { nombre: 'Golpe', poder: 8, weaponAtk: frontierArma(atacante).atk, efectos: [] }
                } else if (cmdReal === 'arte') {
                    arteUsada = frontierArteEquipada(atacante)
                    habilidad = frontierArteHabilidad(atacante)
                    const costoArte = habilidad.costo || 0
                    const enArte = enDe(duelo, slotAtacante)
                    if (!overdrive && enArte < costoArte) return sendReply(sock, from, { text: tr(lang, `❌ Your Art *${arteUsada.nombre}* needs ${costoArte}⚡ and you have ${enArte}⚡.`, `❌ Sua Arte *${arteUsada.nombre}* precisa de ${costoArte}⚡ e você tem ${enArte}⚡.`, `❌ Your Art *${arteUsada.nombre}* needs ${costoArte}⚡ and you have ${enArte}⚡.`) }, { quoted: m })
                    if (!overdrive) setEn(duelo, slotAtacante, enArte - costoArte)
                    atacante.contadorHabilidades[`arte_${arteUsada.id}`] = (atacante.contadorHabilidades[`arte_${arteUsada.id}`] || 0) + 1
                } else {
                    fruitaUsada = frutaEquipadaObj(atacante)
                    if (!fruitaUsada) return sendReply(sock, from, { text: tr(lang, `❌ No tienes ninguna fruta equipada. Usa *${prefix}equiparfruta <nombre>* o ataca normal con .attack.`, `❌ Você não tem fruta equipada. Use *${prefix}equipfruit <nome>* ou ataque com .attack.`, `❌ You don't have ninguna fruit equipped. Use *${prefix}equiparfruit <name>* o ataca normal con .attack.`) }, { quoted: m })
                    const catalogo = HABILIDADES_FRUTA[fruitaUsada.nombre]
                    if (!catalogo) return sendReply(sock, from, { text: tr(lang, '❌ Esa fruta todavía no tiene habilidades configuradas.', '❌ Essa fruta ainda não tem habilidades configuradas.', '❌ Esa fruit not yet tiene skills configuradas.') }, { quoted: m })
                    if (cmdReal === 'ultimate') {
                        if (!fruitaUsada.despertada) return sendReply(sock, from, { text: tr(lang, `❌ Tu fruta no está *despertada*. Usa *${prefix}despertar* para desbloquear la Habilidad Ultimate.`, `❌ Sua fruta não está *despertada*. Use *${prefix}awaken* para liberar a Ultimate.`, `❌ Tu fruit no está *despertada*. Use *${prefix}despertar* para desbloquear la Habilidad Ultimate.`) }, { quoted: m })
                        habilidad = catalogo.ultimate
                        // Control Absoluto: el jugador elige el modo con un argumento
                        if (fruitaUsada.nombre === 'Control') {
                            const modo = (text || '').trim().toLowerCase()
                            if (!['dano', 'daño', 'redirigir', 'stats'].includes(modo)) {
                                return sendReply(sock, from, { text: tr(lang, `🧠 *Control Absoluto* necesita que elijas un modo:\n• *${prefix}ultimate dano* — reduce -20 de daño al rival por 2 turnos\n• *${prefix}ultimate redirigir* — vuelve su próxima habilidad contra sí mismo\n• *${prefix}ultimate stats* — baja el 20% de todos sus stats por 2 turnos`, `🧠 *Control Absoluto* necesita que elijas un modo:\n• *${prefix}ultimate dano* — reduce -20 de daño al rival por 2 turnos\n• *${prefix}ultimate redirigir* — vuelve su próxima habilidad contra sí mismo\n• *${prefix}ultimate stats* — baja el 20% de todos sus stats por 2 turnos`, `🧠 *Control Absoluto* necesita que elijas un modo:\n• *${prefix}ultimate dano* — reduce -20 de daño al rival por 2 turnos\n• *${prefix}ultimate redirigir* — vuelve su próxima habilidad contra sí mismo\n• *${prefix}ultimate stats* — baja el 20% de todos sus stats por 2 turnos`) }, { quoted: m })
                            }
                            if (modo === 'dano' || modo === 'daño') {
                                habilidad = { ...catalogo.ultimate, efectos: [{ tipo: 'debuff_dmg_flat', valor: 20, turnos: 2 }] }
                            } else if (modo === 'redirigir') {
                                habilidad = { ...catalogo.ultimate, efectos: [{ tipo: 'marcar_redirigir' }] }
                            } else {
                                habilidad = { ...catalogo.ultimate, efectos: [{ tipo: 'debuff_all_stats', pct: 0.20, turnos: 2 }] }
                            }
                        }
                        if (fruitaUsada.nombre === 'Vacio') {
                            const modo = (text || '').trim().toLowerCase()
                            if (!['vaciar', 'vida', 'ko', 'redirigir'].includes(modo)) {
                                return sendReply(sock, from, { text: tr(lang, `⬛ *Vacío sin Límites* elige un modo:\n• *${prefix}ultimate vaciar*\n• *${prefix}ultimate vida*\n• *${prefix}ultimate ko*\n• *${prefix}ultimate redirigir*`, `⬛ *Vacío sin Límites* elige un modo:\n• *${prefix}ultimate vaciar*\n• *${prefix}ultimate vida*\n• *${prefix}ultimate ko*\n• *${prefix}ultimate redirigir*`, `⬛ *Vacío sin Límites* elige un modo:\n• *${prefix}ultimate vaciar*\n• *${prefix}ultimate vida*\n• *${prefix}ultimate ko*\n• *${prefix}ultimate redirigir*`) }, { quoted: m })
                            }
                            if (modo === 'vaciar') habilidad = { ...catalogo.ultimate, efectos: [{ tipo: 'stat_cero_permanente' }] }
                            else if (modo === 'vida') habilidad = { ...catalogo.ultimate, efectos: [{ tipo: 'intercambiar_vida' }] }
                            else if (modo === 'ko') habilidad = { ...catalogo.ultimate, efectos: [{ tipo: 'ko_racha_useskill', prob: 0.15, usos: 5, autoObjetivo: true }] }
                            else habilidad = { ...catalogo.ultimate, efectos: [{ tipo: 'redirigir_bonus', pct: 0.10, autoObjetivo: true }] }
                        }
                        atacante.contadorHabilidades[`${fruitaUsada.nombre}_ultimate`] = (atacante.contadorHabilidades[`${fruitaUsada.nombre}_ultimate`] || 0) + 1
                    } else {
                        habilidad = catalogo.habilidad1
                    }
                    habilidad = { ...habilidad, weaponAtk: Math.floor(frontierArma(atacante).atk * 0.25) }
                    atacante.contadorHabilidades[fruitaUsada.nombre] = (atacante.contadorHabilidades[fruitaUsada.nombre] || 0) + 1
                    const costoEnergia = habilidad.costo
                    const enActual = enDe(duelo, slotAtacante)
                    if (!overdrive && enActual < costoEnergia) return sendReply(sock, from, { text: tr(lang, `❌ No tienes suficiente energía (necesitas ${costoEnergia}⚡, tienes ${enActual}⚡).`, `❌ Você não tem energia suficiente (precisa de ${costoEnergia}⚡, tem ${enActual}⚡).`, `❌ You don't have suficiente energy (you need ${costoEnergia}⚡, tienes ${enActual}⚡).`) }, { quoted: m })
                    if (!overdrive) setEn(duelo, slotAtacante, enActual - costoEnergia)
                    if (!overdrive && fruitaUsada.nombre === 'Vacio' && cmdReal === 'ultimate') {
                        setHp(duelo, slotAtacante, Math.max(1, hpDe(duelo, slotAtacante) - 10))
                        bloque += `⬛ *Vacío sin Límites* te cuesta *10 HP* propios.\n`
                    }

                    // Control / Vacío: la habilidad de fruta marcada se vuelve contra quien la usa
                    if (duelo.efectos[slotAtacante].habilidadRedirigida) {
                        duelo.efectos[slotAtacante].habilidadRedirigida = false
                        const bonusVacio = duelo.efectos[slotAtacante].redirigirBonusDmgPct || 0
                        duelo.efectos[slotAtacante].redirigirBonusDmgPct = 0
                        const autoDaño = Math.max(5, Math.floor((habilidad.poder || 15) * 1.3 * (1 + bonusVacio)))
                        setHp(duelo, slotAtacante, Math.max(0, hpDe(duelo, slotAtacante) - autoDaño))
                        duelo.turnos++
                        bloque += `🧠 ¡la habilidad de @${atacanteJid.split('@')[0]} se vuelve contra sí mismo/a! Recibe *${autoDaño}* de daño.\n`
                        bloque += `\n${estadoCombateTexto(duelo, u1, u2)}`
                        if (hpDe(duelo, slotAtacante) <= 0) return finalizarDuelo(from, defensorJid, atacanteJid, bloque)
                        duelo.turno = defensorJid
                        bloque += `\n➡️ ${tr(lang, 'Turno de', 'Vez de', 'Turn')}: @${defensorJid.split('@')[0]}`
                        return sendReply(sock, from, { text: bloque, mentions: [atacanteJid, defensorJid] })
                    }

                    if (cmdReal === 'useskill' && duelo.efectos[slotAtacante].vacioKoUsosRestantes > 0) {
                        duelo.efectos[slotAtacante].vacioKoUsosRestantes--
                        if (Math.random() < duelo.efectos[slotAtacante].vacioKoProb) {
                            setHp(duelo, slotDefensor, 0)
                            duelo.turnos++
                            bloque += `⬛ *Vacío*: ¡K.O. INSTANTÁNEO! @${defensorJid.split('@')[0]} queda fuera.\n`
                            bloque += `\n${estadoCombateTexto(duelo, u1, u2)}`
                            return finalizarDuelo(from, atacanteJid, defensorJid, bloque)
                        }
                    }

                }

                // Si el duelo tiene stats normalizados por diferencia de nivel, se usan solo para este cálculo.
                // También se aplica el debuff temporal de expedición (herida leve por un evento de mar/isla) si está activo.
                const atacanteParaCalculo = { ...atacante, stats: aplicarDebuffExpedicion(duelo.statsNormalizados ? duelo.statsNormalizados[slotAtacante] : atacante.stats, atacante) }
                const defensorParaCalculo = { ...defensor, stats: aplicarDebuffExpedicion(duelo.statsNormalizados ? duelo.statsNormalizados[slotDefensor] : defensor.stats, defensor) }
                const resultado = resolverHabilidad(duelo, slotAtacante, atacanteJid, defensorJid, atacanteParaCalculo, defensorParaCalculo, habilidad, esFisico)
                duelo.turnos++
                if (resultado.daño > 0) duelo.sinDaño[slotDefensor] = false
                let daño = resultado.daño

                // Overdrive [SYSTEM ROOT]: daño garantizado e invulnerabilidad para Arquitectos del Protocolo
                if (overdrive) {
                    daño = 9999
                    setHp(duelo, slotDefensor, 0)
                    setHp(duelo, slotAtacante, hpDe(duelo, slotAtacante)) // invulnerable, no recibe nada
                }

                const nombreHabilidad = esFisico ? `atacó con *${frontierArma(atacante).nombre}* 👊` : arteUsada ? `usó *${arteUsada.nombre}* ✨` : `usó *${habilidad.nombre}* (${fruitaUsada.nombre} 🍎)`
                bloque += `⚔️ @${atacanteJid.split('@')[0]} ${nombreHabilidad} sobre @${defensorJid.split('@')[0]}!\n`
                if (resultado.mensajes.length) bloque += resultado.mensajes.join('\n') + '\n'

                // ---- Auto-Destrucción (Bomba ultimate): el propio atacante casi muere ----
                if (resultado.atacanteMuereAuto && !overdrive) {
                    setHp(duelo, slotAtacante, 1)
                    bloque += `💥 @${atacanteJid.split('@')[0]} se autodestruye y queda con 1 HP.\n`
                }

                // ---- Resurrección pasiva (Fénix) ----
                let defensorRevivio = false
                if (hpDe(duelo, slotDefensor) <= 0 && duelo.efectos[slotDefensor].reviveDisponible) {
                    duelo.efectos[slotDefensor].reviveDisponible = false
                    setHp(duelo, slotDefensor, Math.floor(defensor.maxHp * 0.5))
                    setEn(duelo, slotDefensor, Math.floor(defensor.maxEnergy * 0.5))
                    defensorRevivio = true
                    bloque += `🔥 *¡RESURRECCIÓN!* @${defensorJid.split('@')[0]} revive con 50% HP/⚡.\n`
                }

                bloque += `\n${estadoCombateTexto(duelo, u1, u2)}`

                if (hpDe(duelo, slotAtacante) <= 0) {
                    return finalizarDuelo(from, defensorJid, atacanteJid, bloque)
                }

                if (hpDe(duelo, slotDefensor) <= 0 && !defensorRevivio) {
                    return finalizarDuelo(from, atacanteJid, defensorJid, bloque)
                }

                // ---- Turno extra (Tiempo: Dilatación) ----
                if (resultado.extraTurno && !overdrive) {
                    bloque += `\n🔁 @${atacanteJid.split('@')[0]} conserva el turno.`
                } else {
                    duelo.turno = defensorJid
                    bloque += `\n➡️ ${tr(lang, 'Turno de', 'Vez de', 'Turn')}: @${defensorJid.split('@')[0]}`
                }

                bloque += `\n\n${frontierPanel('𝗣𝗥𝗢́𝗫𝗜𝗠𝗔𝗦 𝗔𝗖𝗖𝗜𝗢𝗡𝗘𝗦', [`${prefix}attack · golpe`, `${prefix}arte · Arte equipado`, `${prefix}useskill · fruta`, `${prefix}ultimate · ultimate`, `${prefix}defender · escudo`], '🎯')}`
                await sendReply(sock, from, { text: bloque, mentions: [atacanteJid, defensorJid] })
            }

            if (command === 'despertar') {
                const user = getUsuario(sender)
                const fEquipada = frutaEquipadaObj(user)
                if (!fEquipada) return sendReply(sock, from, { text: tr(lang, `❌ No tienes ninguna fruta equipada. Usa *${prefix}equiparfruta <nombre>*.`, `❌ Você não tem fruta equipada. Use *${prefix}equipfruit <nome>*.`, `❌ You don't have ninguna fruit equipped. Use *${prefix}equiparfruit <name>*.`) }, { quoted: m })
                if (fEquipada.despertada) return sendReply(sock, from, { text: tr(lang, `✅ Tu fruta *${fEquipada.nombre}* ya está despertada.`, `✅ Sua fruta *${fEquipada.nombre}* já está despertada.`, `✅ Tu fruit *${fEquipada.nombre}* ya está despertada.`) }, { quoted: m })
                const catalogo = HABILIDADES_FRUTA[fEquipada.nombre]
                if (!catalogo?.ultimate) return sendReply(sock, from, { text: tr(lang, '❌ Esa fruta todavía no tiene Habilidad Ultimate configurada.', '❌ Essa fruta ainda não tem Ultimate configurada.', '❌ Esa fruit not yet tiene Habilidad Ultimate configurada.') }, { quoted: m })
                if (user.level < DESPERTAR_NIVEL_MIN) return sendReply(sock, from, { text: tr(lang, `❌ Necesitas nivel *${DESPERTAR_NIVEL_MIN}* para despertar tu fruta (tienes nivel ${user.level}).`, `❌ Você precisa do nível *${DESPERTAR_NIVEL_MIN}* para despertar a fruta (você tem nível ${user.level}).`, `❌ You need level *${DESPERTAR_NIVEL_MIN}* para despertar tu fruit (tienes level ${user.level}).`) }, { quoted: m })
                const costo = catalogo.ultimate.costoDespertar || 1000
                if (user.coins < costo) return sendReply(sock, from, { text: tr(lang, `❌ Despertar *${fEquipada.nombre}* cuesta *$${costo}* monedas (tienes $${user.coins}).`, `❌ Despertar *${fEquipada.nombre}* custa *$${costo}* moedas (você tem $${user.coins}).`, `❌ Despertar *${fEquipada.nombre}* costs *$${costo}* coins (tienes $${user.coins}).`) }, { quoted: m })

                user.coins -= costo
                fEquipada.despertada = true
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `🌟 *¡DESPERTAR COMPLETADO!* 🌟\n\nTu fruta *${fEquipada.nombre}* ha despertado.\nHabilidad Ultimate desbloqueada: *${catalogo.ultimate.nombre}* (${catalogo.ultimate.costo}⚡)\n\nÚsala en combate con *${prefix}ultimate*.`, `🌟 *DESPERTAR COMPLETADO!* 🌟\n\nTu fruta *${fEquipada.nombre}* ha despertado.\nHabilidad Ultimate desbloqueada: *${catalogo.ultimate.nombre}* (${catalogo.ultimate.costo}⚡)\n\nÚsala en combate con *${prefix}ultimate*.`, `🌟 *DESPERTAR COMPLETADO!* 🌟\n\nTu fruta *${fEquipada.nombre}* ha despertado.\nHabilidad Ultimate desbloqueada: *${catalogo.ultimate.nombre}* (${catalogo.ultimate.costo}⚡)\n\nÚsala en combate con *${prefix}ultimate*.`) }, { quoted: m })
            }

            if (command === 'equiparfruta') {
                const user = getUsuario(sender)
                const nombreBuscado = text.trim().toLowerCase()
                if (!nombreBuscado) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}equipfruit <nombre>. Usa *${prefix}myfruits* para ver tu colección.`, `❌ Uso: ${prefix}equipfruit <nome>. Use *${prefix}myfruits* para ver sua coleção.`, `❌ Usage: ${prefix}equipfruit <name>. Use *${prefix}myfruits* para ver tu colección.`) }, { quoted: m })
                const f = frutaPoseida(user, nombreBuscado)
                if (!f) return sendReply(sock, from, { text: tr(lang, `❌ No posees esa fruta. Usa *${prefix}myfruits* para ver tu colección.`, `❌ Você não tem essa fruta. Use *${prefix}myfruits* para ver sua coleção.`, `❌ No posees esa fruit. Use *${prefix}myfruits* para ver tu colección.`) }, { quoted: m })
                user.fruitEquipada = f.nombre
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `🍏 Fruta equipada: *${f.nombre}* [${f.categoria}]${f.despertada ? ' 🌟 despertada' : ''}.`, `🍏 Fruta equipada: *${f.nombre}* [${f.categoria}]${f.despertada ? ' 🌟 despertada' : ''}.`, `🍏 Fruta equipped: *${f.nombre}* [${f.categoria}]${f.despertada ? ' 🌟 despertada' : ''}.`) }, { quoted: m })
            }

            if (command === 'misfrutas') {
                const user = getUsuario(sender)
                if (!user.frutasPoseidas.length) return sendReply(sock, from, { text: tr(lang, `📭 No tienes frutas todavía. Usa *${prefix}fruitgacha*.`, `📭 Você ainda não tem frutas. Use *${prefix}fruitgacha*.`, `📭 You don't have fruits still. Use *${prefix}fruitgacha*.`) }, { quoted: m })
                let texto = `${frontierTitulo(tr(lang, '𝗧𝗨 𝗖𝗢𝗟𝗘𝗖𝗖𝗜𝗢́𝗡 𝗗𝗘 𝗙𝗥𝗨𝗧𝗔𝗦', '𝗦𝗨𝗔 𝗖𝗢𝗟𝗘𝗖̧𝗔̃𝗢 𝗗𝗘 𝗙𝗥𝗨𝗧𝗔𝗦', '𝗧𝗨 𝗖𝗢𝗟𝗘𝗖𝗖𝗜𝗢́𝗡 𝗗𝗘 𝗙𝗥𝗨𝗧𝗔𝗦'), tr(lang, 'Una fruta equipada, muchas posibilidades', 'Uma fruta equipada, várias possibilidades', 'Una fruit equipped, muchas posibilidades'), '🍏')}\n\n`
                user.frutasPoseidas.forEach(f => {
                    const equipada = f.nombre === user.fruitEquipada
                    texto += `${equipada ? '👑' : '▫️'} *${f.nombre}* [${f.categoria}]${f.despertada ? ' 🌟' : ''}\n`
                })
                texto += tr(lang, `\nUsa *${prefix}equipfruit <nombre>* para cambiar de fruta equipada.`, `\nUse *${prefix}equipfruit <nome>* para trocar a fruta equipada.`, `\nUse *${prefix}equipfruit <name>* para cambiar de fruit equipped.`)
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'forfeit') {
                const duelo = duelosActivos.get(from)
                if (!duelo) return sendReply(sock, from, { text: tr(lang, '❌ No hay duelo activo.', '❌ Não há duelo ativo.', `❌ There's no duel activo.`) }, { quoted: m })
                if (normalizarJid(sender) !== normalizarJid(duelo.p1) && normalizarJid(sender) !== normalizarJid(duelo.p2)) return
                const ganadorJid = normalizarJid(sender) === normalizarJid(duelo.p1) ? duelo.p2 : duelo.p1
                duelosActivos.delete(from)
                const ganador = getUsuario(ganadorJid)
                const perdedor = getUsuario(sender)
                perdedor.derrotas = (perdedor.derrotas || 0) + 1
                ganador.wins++
                ganador.exp += 20
                ganador.statPoints += 1
                ganador.rachaActual++
                if (ganador.rachaActual > ganador.rachaMejor) ganador.rachaMejor = ganador.rachaActual
                perdedor.rachaActual = 0
                sumarPuntosGuerra(ganadorJid, 15)
                const bountyRobado = Math.max(5, Math.floor(perdedor.bounty * 0.08))
                perdedor.bounty = Math.max(50, perdedor.bounty - bountyRobado)
                ganador.bounty += bountyRobado
                perdedor.coins = Math.max(0, perdedor.coins - Math.floor(perdedor.coins * 0.1))
                let subioNivel = false
                while (ganador.exp >= ganador.level * 20) {
                    ganador.exp -= ganador.level * 20
                    ganador.level++
                    ganador.statPoints += 3
                    subioNivel = true
                }
                const nuevosTitulos = revisarTitulosAutomaticos(ganador, ganadorJid)
                guardarEconomia()
                let texto = `🏳️ @${sender.split('@')[0]} abandonó el duelo. ¡Gana @${ganadorJid.split('@')[0]}!\n+20 EXP, +1 punto de estadística${subioNivel ? ` (¡subió a *nivel ${ganador.level}*!)` : ''}, +$${bountyRobado} de Bounty.`
                if (nuevosTitulos.length) texto += `\n🎖️ *¡Nuevo título desbloqueado!* ${nuevosTitulos.join(', ')}`
                await sendReply(sock, from, { text: texto, mentions: [sender, ganadorJid] }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: DUELOS 2 VS 2 ======================
            async function finalizar2v2(chatId, equipoGanador, equipoPerdedor, motivo) {
                duelos2v2Activos.delete(chatId)
                const premio = Math.floor(Math.random() * 80) + 60
                let texto = `${motivo}\n\n🏆 *¡Equipo ganador!* ${equipoGanador.map(j => `@${j.split('@')[0]}`).join(' + ')}\n`
                equipoGanador.forEach(jid => {
                    const u = getUsuario(jid)
                    u.coins += premio
                    u.lifetimeCoinsEarned += premio
                    u.exp += 25
                    u.victorias2v2++
                    u.bounty += 15
                })
                equipoPerdedor.forEach(jid => {
                    const u = getUsuario(jid)
                    u.coins = Math.max(0, u.coins - Math.floor(u.coins * 0.05))
                })
                // Todos los que jugaron (ganen o pierdan) suman a su contador de partidas 2vs2 y al progreso del evento
                const todosLosJugadores = [...equipoGanador, ...equipoPerdedor]
                let titulosTexto = '', eventoTexto = ''
                todosLosJugadores.forEach(jid => {
                    const u = getUsuario(jid)
                    u.partidas2v2Jugadas = (u.partidas2v2Jugadas || 0) + 1
                    const premioEvento = otorgarProgresoEventoAmigo(u)
                    if (premioEvento) eventoTexto += `\n\n@${jid.split('@')[0]}: ${premioEvento}`
                    const nuevos = revisarTitulosAutomaticos(u, jid)
                    if (nuevos.length) titulosTexto += `\n🎖️ @${jid.split('@')[0]}: ${nuevos.join(', ')}`
                })
                guardarEconomia()
                texto += `+${premio} monedas, +25 EXP, +15 Bounty cada uno.`
                await sendReply(sock, chatId, { text: texto + titulosTexto + eventoTexto, mentions: todosLosJugadores })
            }

            if (command === 'duel2v2') {
                if (!isGroup) return sendReply(sock, from, { text: tr(lang, '❌ El 2vs2 solo funciona en grupos.', '❌ O 2vs2 só funciona em grupos.', '❌ 2vs2 only works in groups.') }, { quoted: m })
                const mentioned = getMentioned()
                if (mentioned.length < 3) return sendReply(sock, from, { text: tr(lang, `❌ Usage: ${prefix}duel2v2 @teammate @rival1 @rival2`, `❌ Uso: ${prefix}duel2v2 @parceiro @rival1 @rival2`, `❌ Usage: ${prefix}duel2v2 @compañero @rival1 @rival2`) }, { quoted: m })
                if (duelos2v2Activos.has(from) || duelos2v2Pendientes.has(from)) return sendReply(sock, from, { text: tr(lang, '❌ Ya hay un 2vs2 en curso o pendiente en este chat.', '❌ Já existe um 2vs2 em andamento ou pendente neste chat.', `❌ There is already a 2vs2 running or pending in this chat.`) }, { quoted: m })
                const [companero, rival1, rival2] = mentioned
                const equipoA = [sender, companero]
                const equipoB = [rival1, rival2]
                if (new Set([...equipoA, ...equipoB].map(normalizarJid)).size < 4) return sendReply(sock, from, { text: tr(lang, '❌ Los 4 jugadores tienen que ser distintos.', '❌ Os 4 jogadores precisam ser diferentes.', '❌ All 4 players have to be different.') }, { quoted: m })

                duelos2v2Pendientes.set(from, { equipoA, equipoB, timestamp: Date.now() })
                setTimeout(() => { const p = duelos2v2Pendientes.get(from); if (p && Date.now() - p.timestamp >= 5 * 60 * 1000) duelos2v2Pendientes.delete(from) }, 5 * 60 * 1000)
                await sendReply(sock, from, { text: lang === 'pt'
                    ? `${frontierTitulo('𝗗𝗘𝗦𝗔𝗙𝗜𝗢 𝟮 𝗩𝗦 𝟮', 'Estratégia também se joga em time', '🤝')}\n\n${frontierPanel('𝗖𝗢𝗠𝗣𝗢𝗦𝗜𝗖̧𝗔̃𝗢', [`🔵 Time A: @${sender.split('@')[0]} + @${companero.split('@')[0]}`, `🔴 Time B: @${rival1.split('@')[0]} + @${rival2.split('@')[0]}`], '⚔️')}\n\nQualquer um do Time B aceita com *${prefix}acceptduel2v2*.\n\n${frontierPanel('𝗔𝗖̧𝗢̃𝗘𝗦', [`${prefix}atacar2v2 · golpe físico`, `${prefix}arte2v2 · Arte equipada`, `${prefix}habilidad2v2 · fruta`, `${prefix}ultimate2v2 · ultimate`, `${prefix}defender2v2 · escudo`, `${prefix}item2v2 <nome> · consumível`, `${prefix}forfeit2v2 · desistir`], '🎯')}`
                    : lang === 'en'
                    ? `${frontierTitulo('𝟮 𝗩𝗦 𝟮 𝗖𝗛𝗔𝗟𝗟𝗘𝗡𝗚𝗘', 'Team fights need a plan too', '🤝')}\n\n${frontierPanel('𝗟𝗜𝗡𝗘𝗨𝗣', [`🔵 Team A: @${sender.split('@')[0]} + @${companero.split('@')[0]}`, `🔴 Team B: @${rival1.split('@')[0]} + @${rival2.split('@')[0]}`], '⚔️')}\n\nAnyone on Team B can accept with *${prefix}acceptduel2v2*.\n\n${frontierPanel('𝗔𝗖𝗧𝗜𝗢𝗡𝗦', [`${prefix}atacar2v2 · physical hit`, `${prefix}arte2v2 · equipped Art`, `${prefix}habilidad2v2 · fruit`, `${prefix}ultimate2v2 · ultimate`, `${prefix}defender2v2 · shield`, `${prefix}item2v2 <name> · consumable`, `${prefix}forfeit2v2 · forfeit`], '🎯')}`
                    : `${frontierTitulo('𝗥𝗘𝗧𝗢 𝟮 𝗩𝗦 𝟮', 'La estrategia también se juega en equipo', '🤝')}\n\n${frontierPanel('𝗖𝗢𝗠𝗣𝗢𝗦𝗜𝗖𝗜𝗢́𝗡', [`🔵 Equipo A: @${sender.split('@')[0]} + @${companero.split('@')[0]}`, `🔴 Equipo B: @${rival1.split('@')[0]} + @${rival2.split('@')[0]}`], '⚔️')}\n\nCualquiera del Equipo B puede aceptar con *${prefix}acceptduel2v2*.\n\n${frontierPanel('𝗔𝗖𝗖𝗜𝗢𝗡𝗘𝗦', [`${prefix}atacar2v2 · golpe físico`, `${prefix}arte2v2 · Arte equipado`, `${prefix}habilidad2v2 · fruta`, `${prefix}ultimate2v2 · ultimate`, `${prefix}defender2v2 · escudo`, `${prefix}item2v2 <nombre> · consumible`, `${prefix}forfeit2v2 · rendición`], '🎯')}`, mentions: [...equipoA, ...equipoB] }, { quoted: m })
            }

            if (command === 'acceptduel2v2') {
                const pendiente = duelos2v2Pendientes.get(from)
                if (!pendiente) return sendReply(sock, from, { text: tr(lang, '❌ No hay ningún 2vs2 pendiente en este chat.', '❌ Não há 2vs2 pendente neste chat.', `❌ There is no pending 2vs2 in this chat.`) }, { quoted: m })
                if (!pendiente.equipoB.some(j => normalizarJid(j) === normalizarJid(sender))) return sendReply(sock, from, { text: tr(lang, '❌ That challenge is not for you.', '❌ Esse desafio não é para você.', '❌ That challenge is not for you.') }, { quoted: m })

                const todos = [...pendiente.equipoA, ...pendiente.equipoB]
                const hp = {}, en = {}, estados = {}
                todos.forEach(jid => { const u = getUsuario(jid); hp[jid] = u.maxHp; en[jid] = u.maxEnergy; estados[jid] = nuevoEstadoCombate() })
                // Orden de turnos: alterna entre equipos (A1, B1, A2, B2)
                const orden = [pendiente.equipoA[0], pendiente.equipoB[0], pendiente.equipoA[1], pendiente.equipoB[1]]

                duelos2v2Activos.set(from, { equipoA: pendiente.equipoA, equipoB: pendiente.equipoB, hp, en, estados, orden, turnoIdx: 0, timestamp: Date.now(), lang })
                duelos2v2Pendientes.delete(from)
                await sendReply(sock, from, { text: lang === 'pt'
                    ? `${frontierTitulo('𝗖𝗢𝗠𝗕𝗔𝗧𝗘 𝟮 𝗩𝗦 𝟮', 'A ordem alterna entre os dois times', '🤝')}\n\n➡️ Turno de: @${orden[0].split('@')[0]}\n\n${frontierPanel('𝗔𝗖̧𝗢̃𝗘𝗦', [`${prefix}atacar2v2 · golpe`, `${prefix}arte2v2 · Arte`, `${prefix}habilidad2v2 · fruta`, `${prefix}ultimate2v2 · ultimate`, `${prefix}defender2v2 · escudo`, `${prefix}item2v2 <nome> · item`], '🎯')}`
                    : lang === 'en'
                    ? `${frontierTitulo('𝟮 𝗩𝗦 𝟮 𝗙𝗜𝗚𝗛𝗧', 'Turns swap between both teams', '🤝')}\n\n➡️ Turn: @${orden[0].split('@')[0]}\n\n${frontierPanel('𝗔𝗖𝗧𝗜𝗢𝗡𝗦', [`${prefix}atacar2v2 · hit`, `${prefix}arte2v2 · Art`, `${prefix}habilidad2v2 · fruit`, `${prefix}ultimate2v2 · ultimate`, `${prefix}defender2v2 · shield`, `${prefix}item2v2 <name> · item`], '🎯')}`
                    : `${frontierTitulo('𝗖𝗢𝗠𝗕𝗔𝗧𝗘 𝟮 𝗩𝗦 𝟮', 'El orden alterna entre ambos equipos', '🤝')}\n\n➡️ Turno de: @${orden[0].split('@')[0]}\n\n${frontierPanel('𝗔𝗖𝗖𝗜𝗢𝗡𝗘𝗦', [`${prefix}atacar2v2 · golpe`, `${prefix}arte2v2 · Arte`, `${prefix}habilidad2v2 · fruta`, `${prefix}ultimate2v2 · ultimate`, `${prefix}defender2v2 · escudo`, `${prefix}item2v2 <nombre> · objeto`], '🎯')}`, mentions: todos }, { quoted: m })
            }

            if (command === 'atacar2v2' || command === 'arte2v2' || command === 'habilidad2v2' || command === 'ultimate2v2' || command === 'defender2v2') {
                const dg = duelos2v2Activos.get(from)
                if (!dg) return sendReply(sock, from, { text: tr(lang, `❌ No hay ningún 2vs2 activo. Usa *${prefix}duel2v2*.`, `❌ Não há 2vs2 ativo. Use *${prefix}duel2v2*.`, `❌ There's no ningún 2vs2 activo. Use *${prefix}duel2v2*.`) }, { quoted: m })
                let intentos = 0
                while (dg.hp[dg.orden[dg.turnoIdx % 4]] <= 0 && intentos < 4) { dg.turnoIdx++; intentos++ }
                const turnoActual = dg.orden[dg.turnoIdx % 4]
                if (normalizarJid(sender) !== normalizarJid(turnoActual)) return sendReply(sock, from, { text: tr(lang, `⏳ No es tu turno. Le toca a @${turnoActual.split('@')[0]}.`, `⏳ Não é o seu turno. É a vez de @${turnoActual.split('@')[0]}.`, `⏳ No es tu turno. Le toca a @${turnoActual.split('@')[0]}.`), mentions: [turnoActual] }, { quoted: m })

                const esEquipoA = dg.equipoA.some(j => normalizarJid(j) === normalizarJid(sender))
                const atacante = getUsuario(sender)

                // ---- Inicio de turno: energía + dots/aturdimiento/debuffs ----
                const inicio = procesarInicioTurno2v2(dg, sender, atacante)
                let bloque = inicio.textos.length ? inicio.textos.join('\n') + '\n' : ''
                if (dg.hp[sender] <= 0) {
                    bloque += `\n☠️ @${sender.split('@')[0]} cayó por efectos de estado.`
                    await sendReply(sock, from, { text: bloque, mentions: [sender] })
                    const vivosA1 = dg.equipoA.filter(j => dg.hp[j] > 0), vivosB1 = dg.equipoB.filter(j => dg.hp[j] > 0)
                    if (!vivosA1.length || !vivosB1.length) return finalizar2v2(from, vivosA1.length ? dg.equipoA : dg.equipoB, vivosA1.length ? dg.equipoB : dg.equipoA, bloque)
                    dg.turnoIdx++
                    return
                }
                if (inicio.saltaTurno) {
                    dg.turnoIdx++
                    return sendReply(sock, from, { text: bloque }, { quoted: m })
                }

                const rivales = (esEquipoA ? dg.equipoB : dg.equipoA).filter(j => dg.hp[j] > 0)
                const objetivo = rivales[Math.floor(Math.random() * rivales.length)]
                const objetivoUser = getUsuario(objetivo)

                let habilidad, esFisico = false, fEquipada = null, arteUsada = null
                if (command === 'atacar2v2') {
                    esFisico = true
                    habilidad = { nombre: 'Golpe', poder: 8, weaponAtk: frontierArma(atacante).atk, efectos: [] }
                } else if (command === 'defender2v2') {
                    dg.estados[sender].proximoEscudoPct = Math.max(dg.estados[sender].proximoEscudoPct || 0, 0.35)
                    dg.en[sender] = Math.min(atacante.maxEnergy, (dg.en[sender] || 0) + 10)
                    dg.turnoIdx++
                    let intentosDef = 0
                    while (dg.hp[dg.orden[dg.turnoIdx % 4]] <= 0 && intentosDef < 4) { dg.turnoIdx++; intentosDef++ }
                    const siguienteDef = dg.orden[dg.turnoIdx % 4]
                    const bloqueDef = `${frontierPanel('𝗣𝗢𝗦𝗜𝗖𝗜𝗢́𝗡 𝗗𝗘𝗙𝗘𝗡𝗦𝗜𝗩𝗔', [`@${sender.split('@')[0]} prepara un escudo de datos.`, 'El próximo impacto recibido se reduce 35%.', '+10⚡ recuperadas.'], '🛡️')}\n\n➡️ Turno de: @${siguienteDef.split('@')[0]}`
                    return sendReply(sock, from, { text: bloqueDef, mentions: [...dg.equipoA, ...dg.equipoB] }, { quoted: m })
                } else if (command === 'arte2v2') {
                    arteUsada = frontierArteEquipada(atacante)
                    habilidad = frontierArteHabilidad(atacante)
                    const costoArte = habilidad.costo || 0
                    if ((dg.en[sender] || 0) < costoArte) return sendReply(sock, from, { text: tr(lang, `❌ Your Art *${arteUsada.nombre}* needs ${costoArte}⚡ and you have ${dg.en[sender] || 0}⚡.`, `❌ Sua Arte *${arteUsada.nombre}* precisa de ${costoArte}⚡ e você tem ${dg.en[sender] || 0}⚡.`, `❌ Your Art *${arteUsada.nombre}* needs ${costoArte}⚡ and you have ${dg.en[sender] || 0}⚡.`) }, { quoted: m })
                    dg.en[sender] -= costoArte
                } else {
                    fEquipada = frutaEquipadaObj(atacante)
                    if (!fEquipada) return sendReply(sock, from, { text: tr(lang, `❌ No tenés ninguna fruta equipada. Usa *${prefix}atacar2v2* o *${prefix}equiparfruta*.`, `❌ Você não tem fruta equipada. Use *${prefix}attack2v2* ou *${prefix}equipfruit*.`, `❌ You don't have any fruit equipped. Use *${prefix}atacar2v2* o *${prefix}equiparfruit*.`) }, { quoted: m })
                    const catalogo = HABILIDADES_FRUTA[fEquipada.nombre]
                    if (!catalogo) return sendReply(sock, from, { text: tr(lang, '❌ Esa fruta todavía no tiene habilidades configuradas.', '❌ Essa fruta ainda não tem habilidades configuradas.', '❌ Esa fruit not yet tiene skills configuradas.') }, { quoted: m })

                    if (command === 'ultimate2v2') {
                        if (!fEquipada.despertada) return sendReply(sock, from, { text: tr(lang, `❌ Tu fruta no está *despertada*. Usa *${prefix}despertar*.`, `❌ Sua fruta não está *despertada*. Use *${prefix}awaken*.`, `❌ Tu fruit no está *despertada*. Use *${prefix}despertar*.`) }, { quoted: m })
                        habilidad = catalogo.ultimate
                        if (fEquipada.nombre === 'Control') {
                            const modo = (text || '').trim().toLowerCase()
                            if (!['dano', 'daño', 'redirigir', 'stats'].includes(modo)) {
                                return sendReply(sock, from, { text: tr(lang, `🧠 *Control Absoluto* necesita un modo:\n• *${prefix}ultimate2v2 dano*\n• *${prefix}ultimate2v2 redirigir*\n• *${prefix}ultimate2v2 stats*`, `🧠 *Control Absoluto* necesita un modo:\n• *${prefix}ultimate2v2 dano*\n• *${prefix}ultimate2v2 redirigir*\n• *${prefix}ultimate2v2 stats*`, `🧠 *Control Absoluto* necesita un modo:\n• *${prefix}ultimate2v2 dano*\n• *${prefix}ultimate2v2 redirigir*\n• *${prefix}ultimate2v2 stats*`) }, { quoted: m })
                            }
                            if (modo === 'dano' || modo === 'daño') habilidad = { ...catalogo.ultimate, efectos: [{ tipo: 'debuff_dmg_flat', valor: 20, turnos: 2 }] }
                            else if (modo === 'redirigir') habilidad = { ...catalogo.ultimate, efectos: [{ tipo: 'marcar_redirigir' }] }
                            else habilidad = { ...catalogo.ultimate, efectos: [{ tipo: 'debuff_all_stats', pct: 0.20, turnos: 2 }] }
                        }
                    } else {
                        habilidad = catalogo.habilidad1
                    }
                    habilidad = { ...habilidad, weaponAtk: Math.floor(frontierArma(atacante).atk * 0.25) }
                    atacante.contadorHabilidades[fEquipada.nombre] = (atacante.contadorHabilidades[fEquipada.nombre] || 0) + 1

                    const costoEnergia = habilidad.costo
                    if ((dg.en[sender] ?? 0) < costoEnergia) return sendReply(sock, from, { text: tr(lang, `❌ No tenés suficiente energía (necesitas ${costoEnergia}⚡, tenés ${dg.en[sender] ?? 0}⚡). Usa *${prefix}atacar2v2* mientras se recarga.`, `❌ Você não tem energia suficiente (precisa de ${costoEnergia}⚡, tem ${dg.en[sender] ?? 0}⚡). Use *${prefix}attack2v2* enquanto recarrega.`, `❌ You don't have suficiente energy (you need ${costoEnergia}⚡, you have ${dg.en[sender] ?? 0}⚡). Use *${prefix}atacar2v2* mientras se recarga.`) }, { quoted: m })
                    dg.en[sender] -= costoEnergia

                    // Control: la habilidad marcada se vuelve contra quien la usa
                    if (dg.estados[sender].habilidadRedirigida) {
                        dg.estados[sender].habilidadRedirigida = false
                        const autoDaño = Math.max(5, Math.floor((habilidad.poder || 15) * 1.3))
                        dg.hp[sender] = Math.max(0, dg.hp[sender] - autoDaño)
                        bloque += `🧠 *Control*: ¡la habilidad de @${sender.split('@')[0]} se vuelve contra sí mismo/a! Recibe *${autoDaño}* de daño.\n`
                        const vivosA2 = dg.equipoA.filter(j => dg.hp[j] > 0), vivosB2 = dg.equipoB.filter(j => dg.hp[j] > 0)
                        await sendReply(sock, from, { text: bloque, mentions: [sender] })
                        if (!vivosA2.length || !vivosB2.length) return finalizar2v2(from, vivosA2.length ? dg.equipoA : dg.equipoB, vivosA2.length ? dg.equipoB : dg.equipoA, bloque)
                        dg.turnoIdx++
                        return
                    }
                }

                const resultado = resolverHabilidad2v2(dg, sender, objetivo, atacante, objetivoUser, habilidad, esFisico)
                const nombreHabilidad = esFisico ? `atacó con *${frontierArma(atacante).nombre}* 👊` : arteUsada ? `usó *${arteUsada.nombre}* ✨` : `usó *${habilidad.nombre}* (${fEquipada.nombre} 🍎)`
                bloque += `⚔️ @${sender.split('@')[0]} ${nombreHabilidad} sobre @${objetivo.split('@')[0]}!\n`
                if (resultado.mensajes.length) bloque += resultado.mensajes.join('\n') + '\n'
                if (resultado.atacanteMuereAuto) { dg.hp[sender] = 1; bloque += `💥 @${sender.split('@')[0]} se autodestruye y queda con 1 HP.\n` }

                // Resurrección pasiva (Fénix)
                if (dg.hp[objetivo] <= 0 && dg.estados[objetivo].reviveDisponible) {
                    dg.estados[objetivo].reviveDisponible = false
                    dg.hp[objetivo] = Math.floor(objetivoUser.maxHp * 0.5)
                    dg.en[objetivo] = Math.floor(objetivoUser.maxEnergy * 0.5)
                    bloque += `🔥 *¡RESURRECCIÓN!* @${objetivo.split('@')[0]} revive con 50% HP/⚡.\n`
                }

                if (dg.hp[objetivo] <= 0) bloque += `☠️ @${objetivo.split('@')[0]} queda fuera de combate.\n`

                const vivosA = dg.equipoA.filter(j => dg.hp[j] > 0)
                const vivosB = dg.equipoB.filter(j => dg.hp[j] > 0)
                if (!vivosA.length || !vivosB.length) {
                    await sendReply(sock, from, { text: bloque, mentions: [sender, objetivo] })
                    return finalizar2v2(from, vivosA.length ? dg.equipoA : dg.equipoB, vivosA.length ? dg.equipoB : dg.equipoA, bloque)
                }

                dg.turnoIdx++
                intentos = 0
                while (dg.hp[dg.orden[dg.turnoIdx % 4]] <= 0 && intentos < 4) { dg.turnoIdx++; intentos++ }
                const siguienteTurno = dg.orden[dg.turnoIdx % 4]
                bloque += `\n\n${frontierPanel('𝗘𝗦𝗧𝗔𝗗𝗢 𝟮 𝗩𝗦 𝟮', [`🔵 A: ${dg.equipoA.map(j => `@${j.split('@')[0]} (${Math.max(0, dg.hp[j])})`).join(' | ')}`, `🔴 B: ${dg.equipoB.map(j => `@${j.split('@')[0]} (${Math.max(0, dg.hp[j])})`).join(' | ')}`, `➡️ Turno: @${siguienteTurno.split('@')[0]}`], '🤝')}`
                await sendReply(sock, from, { text: bloque, mentions: [...dg.equipoA, ...dg.equipoB] })
            }

            if (command === 'item2v2') {
                const dg = duelos2v2Activos.get(from)
                if (!dg) return sendReply(sock, from, { text: tr(lang, `❌ No hay ningún 2vs2 activo.`, `❌ Não há 2vs2 ativo.`, `❌ There's no ningún 2vs2 activo.`) }, { quoted: m })
                let intentos = 0
                while (dg.hp[dg.orden[dg.turnoIdx % 4]] <= 0 && intentos < 4) { dg.turnoIdx++; intentos++ }
                const turnoActual = dg.orden[dg.turnoIdx % 4]
                if (normalizarJid(sender) !== normalizarJid(turnoActual)) return sendReply(sock, from, { text: tr(lang, `⏳ No es tu turno. Le toca a @${turnoActual.split('@')[0]}.`, `⏳ Não é o seu turno. É a vez de @${turnoActual.split('@')[0]}.`, `⏳ No es tu turno. Le toca a @${turnoActual.split('@')[0]}.`), mentions: [turnoActual] }, { quoted: m })

                const user = getUsuario(sender)
                const query = text.trim().toLowerCase()
                if (!query) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}item2v2 <nombre del ítem>`, `❌ Uso: ${prefix}item2v2 <nome do item>`, `❌ Usage: ${prefix}item2v2 <name del item>`) }, { quoted: m })
                const idxInv = user.inventory.findIndex(it => it.toLowerCase().includes(query))
                if (idxInv === -1) return sendReply(sock, from, { text: tr(lang, '❌ No tenés ese ítem en tu inventario.', '❌ Você não tem esse item no inventário.', `❌ You don't have that item in your inventory.`) }, { quoted: m })
                const nombreInv = user.inventory[idxInv]
                const itemCat = ITEMS_CONSUMIBLES.find(i => nombreInv.toLowerCase().includes(i.nombre.toLowerCase()))
                if (!itemCat || !['curar', 'energia', 'buff_critico', 'buff_escudo'].includes(itemCat.tipo)) return sendReply(sock, from, { text: tr(lang, '❌ Ese ítem no se puede usar en combate.', '❌ Esse item não pode ser usado em combate.', '❌ That item cannot be used in combat.') }, { quoted: m })

                user.inventory.splice(idxInv, 1)
                let efectoTexto = ''
                if (itemCat.tipo === 'curar') { dg.hp[sender] = Math.min(user.maxHp, dg.hp[sender] + itemCat.valor); efectoTexto = `💚 Cura *${itemCat.valor}* HP.` }
                else if (itemCat.tipo === 'energia') { dg.en[sender] = Math.min(user.maxEnergy, (dg.en[sender] || 0) + itemCat.valor); efectoTexto = `🔋 Restaura *${itemCat.valor}⚡*.` }
                else if (itemCat.tipo === 'buff_critico') { dg.estados[sender].proximoCriticoAsegurado = true; efectoTexto = `💉 Tu próximo golpe será crítico garantizado.` }
                else if (itemCat.tipo === 'buff_escudo') { dg.estados[sender].proximoEscudoPct = itemCat.valor; efectoTexto = `🛡️ Bloquearás el ${Math.round(itemCat.valor * 100)}% del próximo golpe.` }
                guardarEconomia()

                dg.turnoIdx++
                let intentos2 = 0
                while (dg.hp[dg.orden[dg.turnoIdx % 4]] <= 0 && intentos2 < 4) { dg.turnoIdx++; intentos2++ }
                const siguienteTurno = dg.orden[dg.turnoIdx % 4]
                const bloque = `${frontierPanel('𝗖𝗢𝗡𝗦𝗨𝗠𝗜𝗕𝗟𝗘 𝗨𝗦𝗔𝗗𝗢', [`🎒 @${sender.split('@')[0]} · ${itemCat.nombre}`, efectoTexto, `➡️ Turno: @${siguienteTurno.split('@')[0]}`], '🎒')}`
                await sendReply(sock, from, { text: bloque, mentions: [...dg.equipoA, ...dg.equipoB] })
            }

            if (command === 'forfeit2v2') {
                const dg = duelos2v2Activos.get(from)
                if (!dg) return sendReply(sock, from, { text: tr(lang, '❌ No hay ningún 2vs2 activo.', '❌ Não há 2vs2 ativo.', `❌ There's no ningún 2vs2 activo.`) }, { quoted: m })
                const esEquipoA = dg.equipoA.some(j => normalizarJid(j) === normalizarJid(sender))
                const esEquipoB = dg.equipoB.some(j => normalizarJid(j) === normalizarJid(sender))
                if (!esEquipoA && !esEquipoB) return
                return finalizar2v2(from, esEquipoA ? dg.equipoB : dg.equipoA, esEquipoA ? dg.equipoA : dg.equipoB, `🏳️ @${sender.split('@')[0]} rindió a su equipo.`)
            }

            // ====================== WOLFRIC PROTOCOL: MERCADO DE JUGADORES ======================
            // ====================== WOLFRIC PROTOCOL: COMPRADOR CERCANO ======================
            if (command === 'comprador') {
                let texto = `🧍 *COMPRADOR CERCANO*\n\nUn comprador ambulante te ofrece monedas al instante por lo que no uses. Paga poco, pero no hay que esperar a nadie.\n\n`
                texto += `🍏 *Frutas:*\n`
                Object.entries(PRECIOS_COMPRADOR_FRUTA).forEach(([cat, precio]) => { texto += `• ${cat}: $${precio}\n` })
                texto += `\n🎒 *Ítems:* ~30% de su precio de tienda.\n\n`
                texto += `Usa *${prefix}venderrapido fruta <nombre>* o *${prefix}venderrapido item <nombre>*.\n(Para mejor precio, probá el *${prefix}mercado* de jugadores o un *${prefix}trade*.)`
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'venderrapido') {
                const user = getUsuario(sender)
                const tipo = (args[0] || '').toLowerCase()
                if (!['fruta', 'item'].includes(tipo)) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}venderrapido <fruta/item> <nombre>`, `❌ Uso: ${prefix}quicksell <fruit/item> <nome>`, `❌ Usage: ${prefix}venderrapido <fruit/item> <name>`) }, { quoted: m })
                const nombreBuscado = args.slice(1).join(' ').trim()
                if (!nombreBuscado) return sendReply(sock, from, { text: tr(lang, `❌ Especificá qué querés vender. Ej: ${prefix}venderrapido fruta Arena`, `❌ Diga o que quer vender. Ex: ${prefix}quicksell fruit Arena`, `❌ Especificá qué querés vender. Ex: ${prefix}venderrapido fruit Arena`) }, { quoted: m })

                if (tipo === 'fruta') {
                    const f = frutaPoseida(user, nombreBuscado)
                    if (!f) return sendReply(sock, from, { text: tr(lang, '❌ No poseés esa fruta.', '❌ Você não tem essa fruta.', '❌ No poseés esa fruit.') }, { quoted: m })
                    const precio = precioCompradorFruta(f.categoria)
                    user.frutasPoseidas = user.frutasPoseidas.filter(x => x.nombre !== f.nombre)
                    if (user.fruitEquipada === f.nombre) user.fruitEquipada = user.frutasPoseidas[0]?.nombre || null
                    user.coins += precio
                    user.lifetimeCoinsEarned += precio
                    guardarEconomia()
                    await sendReply(sock, from, { text: tr(lang, `🧍 El Comprador Cercano te paga *$${precio}* por *${f.nombre}* [${f.categoria}].`, `🧍 O Comprador Próximo paga *$${precio}* por *${f.nombre}* [${f.categoria}].`, `🧍 El Comprador Cercano te paga *$${precio}* por *${f.nombre}* [${f.categoria}].`) }, { quoted: m })
                } else {
                    const idx = user.inventory.findIndex(it => it.toLowerCase().includes(nombreBuscado.toLowerCase()))
                    if (idx === -1) return sendReply(sock, from, { text: tr(lang, '❌ No tenés ese ítem en tu inventario.', '❌ Você não tem esse item no inventário.', `❌ You don't have that item in your inventory.`) }, { quoted: m })
                    const nombreReal = user.inventory[idx]
                    const itemCat = ITEMS_CONSUMIBLES.find(i => nombreReal.toLowerCase().includes(i.nombre.toLowerCase()))
                    const precio = precioCompradorItem(itemCat)
                    user.inventory.splice(idx, 1)
                    user.coins += precio
                    user.lifetimeCoinsEarned += precio
                    guardarEconomia()
                    await sendReply(sock, from, { text: tr(lang, `🧍 El Comprador Cercano te paga *$${precio}* por *${nombreReal}*.`, `🧍 O Comprador Próximo paga *$${precio}* por *${nombreReal}*.`, `🧍 El Comprador Cercano te paga *$${precio}* por *${nombreReal}*.`) }, { quoted: m })
                }
            }

            if (command === 'vender') {
                const user = getUsuario(sender)
                const tipo = (args[0] || '').toLowerCase() === 'fruit' ? 'fruta' : (args[0] || '').toLowerCase()
                if (!['fruta', 'item'].includes(tipo)) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}sell <fruit/item> <nombre> <precio>`, `❌ Uso: ${prefix}sell <fruit/item> <nome> <preço>`, `❌ Usage: ${prefix}sell <fruit/item> <name> <precio>`) }, { quoted: m })
                const precio = parseInt(args[args.length - 1])
                if (!precio || precio <= 0) return sendReply(sock, from, { text: tr(lang, `❌ Especifica un precio válido al final. Ej: ${prefix}sell item "Poción Neón Grande" 1500`, `❌ Coloque um preço válido no final. Ex: ${prefix}sell item "Poción Neón Grande" 1500`, `❌ Especifica un precio válido al final. Ex: ${prefix}sell item "Poción Neón Grande" 1500`) }, { quoted: m })
                const nombreBuscado = args.slice(1, -1).join(' ').trim()
                if (!nombreBuscado) return sendReply(sock, from, { text: tr(lang, `❌ Especifica qué querés vender. Ej: ${prefix}sell fruit Oscuridad 50000`, `❌ Diga o que quer vender. Ex: ${prefix}sell fruit Oscuridad 50000`, `❌ Especifica qué querés vender. Ex: ${prefix}sell fruit Oscuridad 50000`) }, { quoted: m })

                let entrada = {}
                if (tipo === 'fruta') {
                    const f = frutaPoseida(user, nombreBuscado)
                    if (!f) return sendReply(sock, from, { text: tr(lang, '❌ No posees esa fruta.', '❌ Você não tem essa fruta.', '❌ No posees esa fruit.') }, { quoted: m })
                    user.frutasPoseidas = user.frutasPoseidas.filter(x => x.nombre !== f.nombre)
                    if (user.fruitEquipada === f.nombre) user.fruitEquipada = user.frutasPoseidas[0]?.nombre || null
                    entrada = { tipo: 'fruta', nombre: f.nombre, categoria: f.categoria, despertada: f.despertada }
                } else {
                    const idx = user.inventory.findIndex(it => it.toLowerCase().includes(nombreBuscado.toLowerCase()))
                    if (idx === -1) return sendReply(sock, from, { text: tr(lang, '❌ No tenés ese ítem en tu inventario.', '❌ Você não tem esse item no inventário.', `❌ You don't have that item in your inventory.`) }, { quoted: m })
                    const nombreReal = user.inventory[idx]
                    user.inventory.splice(idx, 1)
                    entrada = { tipo: 'item', nombre: nombreReal }
                }

                const id = mercadoIdCounter++
                mercadoJugadores.set(id, { vendedorJid: sender, precio, timestamp: Date.now(), ...entrada })
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `🏷️ *Publicado en el mercado #${id}*\n\n${entrada.nombre} — 💰 $${precio}\n\nMientras esté en venta no podés usarlo. Cancelá con *${prefix}marketcancel ${id}* si te arrepentís.`, `🏷️ *Publicado no mercado #${id}*\n\n${entrada.nombre} — 💰 $${precio}\n\nEnquanto estiver à venda você não pode usar. Cancele com *${prefix}marketcancel ${id}*.`, `🏷️ *Publicado en el market #${id}*\n\n${entrada.nombre} — 💰 $${precio}\n\nMientras esté en venta you can't usarlo. Cancelá con *${prefix}marketcancel ${id}* si te arrepentís.`) }, { quoted: m })
            }

            if (command === 'mercado') {
                if (!mercadoJugadores.size) return sendReply(sock, from, { text: tr(lang, '📭 El mercado de jugadores está vacío ahora mismo.', '📭 O mercado de jogadores está vazio agora.', '📭 El market de players está vacío ahour mismo.') }, { quoted: m })
                let texto = tr(lang, `🏪 *MERCADO DE JUGADORES*\n\n`, `🏪 *MERCADO DE JOGADORES*\n\n`, `🏪 *MERCADO DE JUGADORES*\n\n`)
                for (const [id, l] of mercadoJugadores.entries()) {
                    texto += `*#${id}* — ${l.tipo === 'fruta' ? `🍏 ${l.nombre} [${l.categoria}]` : `🎒 ${l.nombre}`} — 💰 $${l.precio} (vende @${l.vendedorJid.split('@')[0]})\n`
                }
                texto += tr(lang, `\nUsa *${prefix}marketbuy <id>* para comprar.`, `\nUse *${prefix}marketbuy <id>* para comprar.`, `\nUse *${prefix}marketbuy <id>* para comprar.`)
                await sendReply(sock, from, { text: texto, mentions: [...mercadoJugadores.values()].map(l => l.vendedorJid) }, { quoted: m })
            }

            if (command === 'comprarmercado') {
                const id = parseInt(args[0])
                const listado = mercadoJugadores.get(id)
                if (!listado) return sendReply(sock, from, { text: tr(lang, '❌ Esa publicación no existe o ya se vendió.', '❌ Essa publicação não existe ou já foi vendida.', '❌ Esa publicación no existe o ya se vendió.') }, { quoted: m })
                if (normalizarJid(listado.vendedorJid) === normalizarJid(sender)) return sendReply(sock, from, { text: tr(lang, '❌ No podés comprarte tu propia publicación. Usa .marketcancel si te arrepentiste.', '❌ Você não pode comprar a própria publicação. Use .marketcancel se mudou de ideia.', `❌ You can't comprarte tu propia publicación. Use .marketcancel si te arrepentiste.`) }, { quoted: m })

                const comprador = getUsuario(sender)
                if (comprador.coins < listado.precio) return sendReply(sock, from, { text: tr(lang, `❌ Te faltan *${listado.precio - comprador.coins}* monedas.`, `❌ Faltam *${listado.precio - comprador.coins}* moedas.`, `❌ Te faltan *${listado.precio - comprador.coins}* coins.`) }, { quoted: m })
                const vendedor = getUsuario(listado.vendedorJid)

                comprador.coins -= listado.precio
                const pctImpuesto = Math.max(0, Math.min(50, Number(botConfig.impuestoMercadoPct) || 0)) / 100
                const comision = Math.floor(listado.precio * pctImpuesto)
                vendedor.coins += (listado.precio - comision)
                vendedor.lifetimeCoinsEarned += (listado.precio - comision)
                registrarDineroDestruido(comision)

                if (listado.tipo === 'fruta') {
                    const f = otorgarFruta(comprador, listado.nombre, listado.categoria)
                    f.despertada = listado.despertada || false
                } else {
                    comprador.inventory.push(listado.nombre)
                }
                comprador.tradesCompleted = (comprador.tradesCompleted || 0) + 1
                vendedor.tradesCompleted = (vendedor.tradesCompleted || 0) + 1
                mercadoJugadores.delete(id)
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `✅ @${sender.split('@')[0]} le compró *${listado.nombre}* a @${listado.vendedorJid.split('@')[0]} por *$${listado.precio}* (comisión de red: $${comision}).`, `✅ @${sender.split('@')[0]} comprou *${listado.nombre}* de @${listado.vendedorJid.split('@')[0]} por *$${listado.precio}* (taxa da rede: $${comision}).`, `✅ @${sender.split('@')[0]} le compró *${listado.nombre}* a @${listado.vendedorJid.split('@')[0]} por *$${listado.precio}* (coquest de red: $${comision}).`), mentions: [sender, listado.vendedorJid] }, { quoted: m })
            }

            if (command === 'cancelarventa') {
                const id = parseInt(args[0])
                const listado = mercadoJugadores.get(id)
                if (!listado) return sendReply(sock, from, { text: tr(lang, '❌ Esa publicación no existe.', '❌ Essa publicação não existe.', '❌ Esa publicación no existe.') }, { quoted: m })
                if (normalizarJid(listado.vendedorJid) !== normalizarJid(sender)) return sendReply(sock, from, { text: tr(lang, '❌ Esa publicación no es tuya.', '❌ Essa publicação não é sua.', '❌ Esa publicación no es tuya.') }, { quoted: m })

                const user = getUsuario(sender)
                if (listado.tipo === 'fruta') {
                    const f = otorgarFruta(user, listado.nombre, listado.categoria)
                    f.despertada = listado.despertada || false
                } else {
                    user.inventory.push(listado.nombre)
                }
                mercadoJugadores.delete(id)
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `↩️ Retiraste *${listado.nombre}* del mercado. Ya está de vuelta en tu poder.`, `↩️ Você tirou *${listado.nombre}* do mercado. Já voltou para você.`, `↩️ You pulled *${listado.nombre}* from the market. It is back with you.`) }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: TRADING ======================
            if (command === 'trade') {
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}trade @usuario <monto_monedas> [nombre_fruta]`, `❌ Uso: ${prefix}trade @usuario <valor> [nome_fruta]`, `❌ Usage: ${prefix}trade @user <monto_coins> [name_fruit]`) }, { quoted: m })
                const monto = parseInt(args.find(a => !a.startsWith('@') && !isNaN(parseInt(a))))
                if (!monto || monto <= 0) return sendReply(sock, from, { text: tr(lang, `❌ Especifica cuántas monedas ofreces. Ej: ${prefix}trade @usuario 5000 Oscuridad`, `❌ Diga quantas moedas você oferece. Ex: ${prefix}trade @usuario 5000 Oscuridad`, `❌ Especifica cuántas coins ofreces. Ex: ${prefix}trade @user 5000 Oscuridad`) }, { quoted: m })

                const objetivoJid = mentioned[0]
                const objetivo = getUsuario(objetivoJid)
                const nombreFrutaPedida = args.find(a => !a.startsWith('@') && isNaN(parseInt(a)))
                const frutaObjetivo = nombreFrutaPedida ? frutaPoseida(objetivo, nombreFrutaPedida) : objetivo.frutasPoseidas.find(f => ['mitica', 'divina'].includes(f.categoria))
                if (!frutaObjetivo || !['mitica', 'divina'].includes(frutaObjetivo.categoria)) {
                    return sendReply(sock, from, { text: tr(lang, '❌ Esa persona no tiene esa fruta, o no es tradeable (solo Míticas y Secretas se pueden tradear).', '❌ Essa pessoa não tem essa fruta, ou ela não é tradeable (só Míticas e Secretas).', '❌ That person does not have that fruit, or it is not tradeable (only Mythic and Secret can be traded).') }, { quoted: m })
                }
                const ofertante = getUsuario(sender)
                if (ofertante.coins < monto) return sendReply(sock, from, { text: tr(lang, '❌ No tienes esa cantidad de monedas.', '❌ Você não tem essa quantidade de moedas.', `❌ You don't have esa amount de coins.`) }, { quoted: m })

                const id = tradeIdCounter++
                tradesActivos.set(id, { from: sender, to: objetivoJid, coins: monto, fruta: frutaObjetivo.nombre, chatId: from, timestamp: Date.now() })
                setTimeout(() => {
                    if (tradesActivos.has(id)) {
                        tradesActivos.delete(id)
                    }
                }, 10 * 60 * 1000)

                await sendReply(sock, from, { text: tr(lang, `🤝 *Oferta de Trade #${id}*\n\n@${sender.split('@')[0]} ofrece *$${monto}* monedas por la fruta *${frutaObjetivo.nombre}* de @${objetivoJid.split('@')[0]}.\n\n@${objetivoJid.split('@')[0]} usa *${prefix}accepttrade ${id}* o *${prefix}canceltrade ${id}*.\n⏳ Expira en 10 minutos.`, `🤝 *Oferta de Trade #${id}*\n\n@${sender.split('@')[0]} ofrece *$${monto}* moedas por la fruta *${frutaObjetivo.nombre}* de @${objetivoJid.split('@')[0]}.\n\n@${objetivoJid.split('@')[0]} usa *${prefix}accepttrade ${id}* o *${prefix}canceltrade ${id}*.\n⏳ Expira en 10 minutos.`, `🤝 *Oferta de Trade #${id}*\n\n@${sender.split('@')[0]} ofrece *$${monto}* coins por la fruta *${frutaObjetivo.nombre}* de @${objetivoJid.split('@')[0]}.\n\n@${objetivoJid.split('@')[0]} usa *${prefix}accepttrade ${id}* o *${prefix}canceltrade ${id}*.\n⏳ Expira en 10 minutos.`), mentions: [sender, objetivoJid] }, { quoted: m })
            }

            if (command === 'accepttrade') {
                const id = parseInt(args[0])
                const trade = tradesActivos.get(id)
                if (!trade) return sendReply(sock, from, { text: tr(lang, '❌ Ese trade no existe o ya expiró.', '❌ Esse trade não existe ou já expirou.', '❌ That trade does not exist or already expired.') }, { quoted: m })
                if (normalizarJid(sender) !== normalizarJid(trade.to)) return sendReply(sock, from, { text: tr(lang, '❌ Esa oferta no es para ti.', '❌ Essa oferta não é para você.', '❌ Esa oferta no es para ti.') }, { quoted: m })

                const ofertante = getUsuario(trade.from)
                const receptor = getUsuario(trade.to)
                if (ofertante.coins < trade.coins) return sendReply(sock, from, { text: tr(lang, '❌ El ofertante ya no tiene suficientes monedas. Trade cancelado.', '❌ Quem ofereceu já não tem moedas suficientes. Trade cancelado.', '❌ El ofertante ya no tiene suficientes coins. Trade cancelado.') }, { quoted: m })
                const frutaAEntregar = frutaPoseida(receptor, trade.fruta)
                if (!frutaAEntregar || !['mitica', 'divina'].includes(frutaAEntregar.categoria)) return sendReply(sock, from, { text: tr(lang, '❌ Ya no tienes esa fruta. Trade cancelado.', '❌ Você já não tem essa fruta. Trade cancelado.', '❌ Ya no tienes esa fruit. Trade cancelado.') }, { quoted: m })

                const comision = Math.floor(trade.coins * 0.05)
                ofertante.coins -= trade.coins
                receptor.coins += (trade.coins - comision)
                receptor.lifetimeCoinsEarned += (trade.coins - comision)

                // Mover la fruta del receptor al ofertante (colección multi-fruta)
                receptor.frutasPoseidas = receptor.frutasPoseidas.filter(f => f.nombre !== frutaAEntregar.nombre)
                if (receptor.fruitEquipada === frutaAEntregar.nombre) receptor.fruitEquipada = receptor.frutasPoseidas[0]?.nombre || null
                otorgarFruta(ofertante, frutaAEntregar.nombre, frutaAEntregar.categoria)
                ofertante.bounty += frutaAEntregar.categoria === 'divina' ? 500 : 100

                ofertante.tradesCompleted++
                receptor.tradesCompleted++
                const nuevosTitulosOf = revisarTitulosAutomaticos(ofertante, trade.from)
                const nuevosTitulosRe = revisarTitulosAutomaticos(receptor, trade.to)
                guardarEconomia()
                tradesActivos.delete(id)

                let texto = `✅ *Trade #${id} completado!*\n\n@${trade.from.split('@')[0]} recibió la fruta *${frutaAEntregar.nombre}*.\n@${trade.to.split('@')[0]} recibió *$${trade.coins - comision}* monedas (comisión de red: $${comision}).`
                if (nuevosTitulosOf.length || nuevosTitulosRe.length) texto += `\n\n🎖️ Títulos desbloqueados: ${[...nuevosTitulosOf, ...nuevosTitulosRe].join(', ')}`
                await sendReply(sock, from, { text: texto, mentions: [trade.from, trade.to] }, { quoted: m })
            }

            if (command === 'canceltrade') {
                const id = parseInt(args[0])
                const trade = tradesActivos.get(id)
                if (!trade) return sendReply(sock, from, { text: tr(lang, '❌ Ese trade no existe o ya expiró.', '❌ Esse trade não existe ou já expirou.', '❌ That trade does not exist or already expired.') }, { quoted: m })
                if (normalizarJid(sender) !== normalizarJid(trade.from) && normalizarJid(sender) !== normalizarJid(trade.to)) return
                tradesActivos.delete(id)
                await sendReply(sock, from, { text: tr(lang, `❌ Trade #${id} canceled.`, `❌ Trade #${id} canceled.`, `❌ Trade #${id} canceled.`) }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: ROOT ACCESS (ADMIN) — GDD V4.2 ======================
            // Nombres oficiales del GDD: admin_overdrive_on/off, admin_set_asset, admin_set_stats, admin_event_control.
            // Se mantienen los alias cortos (overdrive_on, setasset, setstats, eventcontrol) por compatibilidad.
            if ((command === 'admin_overdrive_on' || command === 'overdrive_on') && isOwner) {
                overdriveActivo.add(normalizarJid(sender))
                registrarAccionRoot(sender, 'admin_overdrive_on', '', null)
                await sendReply(sock, from, { text: tr(lang, '🛑 *[SYSTEM ROOT]* Protocolo Overdrive ACTIVADO para el Arquitecto del Protocolo.\nRecursos ilimitados, invulnerabilidad, sin cooldowns y comandos root desbloqueados.\n📋 Acción registrada en el log de auditoría.', '🛑 *[SYSTEM ROOT]* Protocolo Overdrive ATIVADO para o Arquiteto do Protocolo.\nRecursos ilimitados, invulnerabilidade, sem cooldowns e comandos root liberados.\n📋 Ação registrada no log de auditoria.', '🛑 *[SYSTEM ROOT]* Overdrive Protocol ON for the Protocol Architect.\nUnlimited resources, invulnerability, no cooldowns and root commands unlocked.\n📋 Action logged in the audit trail.') }, { quoted: m })
                // Aviso discreto a los demás dueños activos (GDD §2.1) — con delay anti-baneo, uno por uno
                for (const owner of OWNERS) {
                    if (normalizarJid(owner) !== normalizarJid(sender)) {
                        const destino = owner.includes('@') ? owner : `${owner}@s.whatsapp.net`
                        await sendReply(sock, destino, { text: tr(lang, `🔔 @${sender.split('@')[0]} turned on Overdrive Protocol in ${from}.`, `🔔 @${sender.split('@')[0]} turned on Overdrive Protocol in ${from}.`, `🔔 @${sender.split('@')[0]} turned on Overdrive Protocol in ${from}.`) }).catch(() => {})
                    }
                }
            }

            if ((command === 'admin_overdrive_off' || command === 'overdrive_off') && isOwner) {
                overdriveActivo.delete(normalizarJid(sender))
                registrarAccionRoot(sender, 'admin_overdrive_off', '', null)
                await sendReply(sock, from, { text: tr(lang, '✅ Protocolo Overdrive desactivado. Restricciones normales restauradas.', '✅ Protocolo Overdrive desativado. Restrições normais restauradas.', '✅ Protocolo Overdrive off. Restricciones normales restauradas.') }, { quoted: m })
            }

            if ((command === 'admin_set_asset' || command === 'setasset') && isOwner) {
                if (!overdriveActivo.has(normalizarJid(sender))) return sendReply(sock, from, { text: tr(lang, `❌ Necesitas activar *${prefix}admin_overdrive_on* primero (Modo Overdrive Requerido — GDD V4.2 §4).`, `❌ Ative *${prefix}admin_overdrive_on* primeiro (Modo Overdrive necessário — GDD V4.2 §4).`, `❌ You need activar *${prefix}admin_overdrive_on* primero (Modo Overdrive Requerido — GDD V4.2 §4).`) }, { quoted: m })
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}admin_set_asset @usuario <fruta/item/monedas/gemas> <nombre_o_cantidad> <cantidad> add/remove`, `❌ Uso: ${prefix}admin_set_asset @usuario <fruta/item/monedas/gemas> <nome_ou_quantidade> <quantidade> add/remove`, `❌ Usage: ${prefix}admin_set_asset @user <fruit/item/coins/gemas> <name_o_amount> <amount> add/remove`) }, { quoted: m })

                const tipo = (args.find(a => ['fruta', 'item', 'monedas', 'coins', 'gemas'].includes((a || '').toLowerCase())) || '').toLowerCase()
                const modo = args.some(a => a.toLowerCase() === 'remove') ? 'remove' : 'add'
                const cantidad = parseInt([...args].reverse().find(a => !isNaN(parseInt(a)) && a !== '')) || 0
                if (!tipo || !Number.isFinite(cantidad) || cantidad <= 0) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}admin_set_asset @usuario <fruta/item/monedas/gemas> <nombre_o_cantidad> <cantidad> add/remove`, `❌ Uso: ${prefix}admin_set_asset @usuario <fruta/item/monedas/gemas> <nome_ou_quantidade> <quantidade> add/remove`, `❌ Usage: ${prefix}admin_set_asset @user <fruit/item/coins/gemas> <name_o_amount> <amount> add/remove`) }, { quoted: m })

                const target = getUsuario(mentioned[0])
                let detalle = ''
                let esDestructivo = modo === 'remove'

                if (tipo === 'monedas' || tipo === 'coins') {
                    target.coins = modo === 'add' ? target.coins + cantidad : Math.max(0, target.coins - cantidad)
                    detalle = `${modo === 'add' ? '+' : '-'}${cantidad} monedas → Total: $${target.coins}`
                } else if (tipo === 'gemas') {
                    target.gems = modo === 'add' ? target.gems + cantidad : Math.max(0, target.gems - cantidad)
                    detalle = `${modo === 'add' ? '+' : '-'}${cantidad} 💎 gemas → Total: ${target.gems}`
                } else if (tipo === 'fruta') {
                    // nombre_activo = el argumento de texto que no es @mención, "fruta", cantidad numérica, ni add/remove
                    const nombreFruta = args.find(a => !a.startsWith('@') && a.toLowerCase() !== 'fruta' && isNaN(parseInt(a)) && !['add', 'remove'].includes(a.toLowerCase()))
                    if (!nombreFruta) return sendReply(sock, from, { text: tr(lang, '❌ Especifica el nombre de la fruta. Ej: .admin_set_asset @user fruta Oscuridad 1 add', '❌ Informe o nome da fruta. Ex: .admin_set_asset @user fruta Oscuridad 1 add', '❌ Specify the fruit name. Ex: .admin_set_asset @user fruit Oscuridad 1 add') }, { quoted: m })
                    const catInfo = Object.entries(FRUTAS).find(([, d]) => d.nombres.some(n => n.toLowerCase() === nombreFruta.toLowerCase()))
                    if (!catInfo) return sendReply(sock, from, { text: tr(lang, `❌ "${nombreFruta}" no es una fruta válida del catálogo (${prefix}fruits).`, `❌ "${nombreFruta}" não é uma fruta válida do catálogo (${prefix}fruits).`, `❌ "${nombreFruta}" isn't a valid catalog fruit (${prefix}fruits).`) }, { quoted: m })
                    const nombreReal = catInfo[1].nombres.find(n => n.toLowerCase() === nombreFruta.toLowerCase())
                    if (modo === 'add') {
                        otorgarFruta(target, nombreReal, catInfo[0])
                        detalle = `Fruta otorgada: ${nombreReal} [${catInfo[0]}]`
                    } else {
                        target.frutasPoseidas = target.frutasPoseidas.filter(f => f.nombre !== nombreReal)
                        if (target.fruitEquipada === nombreReal) target.fruitEquipada = target.frutasPoseidas[0]?.nombre || null
                        detalle = `Fruta removida: ${nombreReal}`
                    }
                } else if (tipo === 'item') {
                    const nombreItem = args.find(a => !a.startsWith('@') && a.toLowerCase() !== 'item' && isNaN(parseInt(a)) && !['add', 'remove'].includes(a.toLowerCase()))
                    if (!nombreItem) return sendReply(sock, from, { text: tr(lang, '❌ Especifica el nombre del ítem. Ej: .admin_set_asset @user item PocionNeonGrande 5 remove', '❌ Informe o nome do item. Ex: .admin_set_asset @user item PocionNeonGrande 5 remove', '❌ Specify the item name. Ex: .admin_set_asset @user item PocionNeonGrande 5 remove') }, { quoted: m })
                    if (modo === 'add') {
                        for (let i = 0; i < cantidad; i++) target.inventory.push(nombreItem)
                        detalle = `+${cantidad}x ${nombreItem} en inventario`
                    } else {
                        let quitados = 0
                        for (let i = 0; i < cantidad; i++) {
                            const idx = target.inventory.indexOf(nombreItem)
                            if (idx === -1) break
                            target.inventory.splice(idx, 1); quitados++
                        }
                        detalle = `-${quitados}x ${nombreItem} del inventario`
                    }
                }

                guardarEconomia()
                registrarAccionRoot(sender, 'admin_set_asset', `${tipo} ${cantidad} ${modo}`, mentioned[0])
                let texto = `🔧 *[SYSTEM ROOT]* @${mentioned[0].split('@')[0]}: ${detalle}`
                if (esDestructivo) texto = `⚠️ *ADVERTENCIA: acción destructiva ejecutada.*\n${texto}`
                await sendReply(sock, from, { text: texto, mentions: [mentioned[0]] }, { quoted: m })
            }

            if ((command === 'admin_set_stats' || command === 'setstats') && isOwner) {
                if (!overdriveActivo.has(normalizarJid(sender))) return sendReply(sock, from, { text: tr(lang, `❌ Necesitas activar *${prefix}admin_overdrive_on* primero (Modo Overdrive Requerido — GDD V4.2 §4).`, `❌ Ative *${prefix}admin_overdrive_on* primeiro (Modo Overdrive necessário — GDD V4.2 §4).`, `❌ You need activar *${prefix}admin_overdrive_on* primero (Modo Overdrive Requerido — GDD V4.2 §4).`) }, { quoted: m })
                const mentioned = getMentioned()
                const stat = (args.find(a => ['str', 'def', 'agi', 'int', 'hp', 'energia', 'energía', 'nivel', 'level', 'exp'].includes((a || '').toLowerCase())) || '').toLowerCase()
                const valor = parseInt(args.find(a => !isNaN(parseInt(a))))
                if (!mentioned.length || !stat || isNaN(valor) || valor < 0 || (['nivel', 'level'].includes(stat) && valor < 1)) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}admin_set_stats @usuario <str/def/agi/int/hp/energia/nivel/exp> <valor válido>`, `❌ Uso: ${prefix}admin_set_stats @usuario <str/def/agi/int/hp/energia/nivel/exp> <valor válido>`, `❌ Usage: ${prefix}admin_set_stats @user <str/def/agi/int/hp/energia/level/exp> <value válido>`) }, { quoted: m })

                const target = getUsuario(mentioned[0])
                const valorAnterior = ['str', 'def', 'agi', 'int'].includes(stat) ? target.stats[stat]
                    : stat === 'hp' ? target.hp
                        : (stat === 'energia' || stat === 'energía') ? target.energy
                            : (stat === 'nivel' || stat === 'level') ? target.level
                                : target.exp
                const esDestructivo = valor < valorAnterior

                if (['str', 'def', 'agi', 'int'].includes(stat)) {
                    target.stats[stat] = valor
                } else if (stat === 'hp') {
                    target.hp = Math.min(valor, target.maxHp)
                    sincronizarDueloConStats(mentioned[0], 'hp', target.hp)
                } else if (stat === 'energia' || stat === 'energía') {
                    target.energy = Math.min(valor, target.maxEnergy)
                    sincronizarDueloConStats(mentioned[0], 'energia', target.energy)
                } else if (stat === 'level' || stat === 'nivel') {
                    target.level = valor
                } else if (stat === 'exp') {
                    target.exp = valor
                }
                guardarEconomia()
                registrarAccionRoot(sender, 'admin_set_stats', `${stat}=${valor}`, mentioned[0])
                let texto = `🔧 *[SYSTEM ROOT]* @${mentioned[0].split('@')[0]}: ${stat.toUpperCase()} = ${valor}${esDestructivo ? ` (antes: ${valorAnterior})` : ''}`
                if (esDestructivo) texto = `⚠️ *ADVERTENCIA: valor reducido de ${valorAnterior} a ${valor}.*\n${texto}`
                texto += `\n📋 Si el jugador está en duelo activo, su HP/⚡ de combate se sincronizó en tiempo real.`
                await sendReply(sock, from, { text: texto, mentions: [mentioned[0]] }, { quoted: m })
            }

            if ((command === 'admin_event_control' || command === 'eventcontrol') && isOwner) {
                if (!overdriveActivo.has(normalizarJid(sender))) return sendReply(sock, from, { text: tr(lang, `❌ Necesitas activar *${prefix}admin_overdrive_on* primero (Modo Overdrive Requerido — GDD V4.2 §4).`, `❌ Ative *${prefix}admin_overdrive_on* primeiro (Modo Overdrive necessário — GDD V4.2 §4).`, `❌ You need activar *${prefix}admin_overdrive_on* primero (Modo Overdrive Requerido — GDD V4.2 §4).`) }, { quoted: m })
                const evento = (args[0] || '').toLowerCase()
                if (evento === 'boss_spawn_chance') {
                    const pct = parseFloat(args[1])
                    if (isNaN(pct) || pct < 0 || pct > 100) return sendReply(sock, from, { text: tr(lang, '❌ Uso: .admin_event_control boss_spawn_chance <0-100>', '❌ Uso: .admin_event_control boss_spawn_chance <0-100>', '❌ Usage: .admin_event_control boss_spawn_chance <0-100>') }, { quoted: m })
                    bossSpawnChancePct = pct
                    registrarAccionRoot(sender, 'admin_event_control', `boss_spawn_chance ${pct}`, null)
                    return sendReply(sock, from, { text: tr(lang, `🔧 *[SYSTEM ROOT]* Probabilidad de aparición de Boss: ${pct}% por mensaje.`, `🔧 *[SYSTEM ROOT]* Chance de spawn de Boss: ${pct}% por mensagem.`, `🔧 *[SYSTEM ROOT]* Boss spawn chance: ${pct}% per message.`) }, { quoted: m })
                }
                if (evento === 'boss_cooldown') {
                    const minutos = parseFloat(args[1])
                    if (isNaN(minutos) || minutos < 0) return sendReply(sock, from, { text: tr(lang, '❌ Uso: .admin_event_control boss_cooldown <minutos> (0 = sin cooldown)', '❌ Uso: .admin_event_control boss_cooldown <minutos> (0 = sem cooldown)', '❌ Usage: .admin_event_control boss_cooldown <minutes> (0 = no cooldown)') }, { quoted: m })
                    bossCooldownMs = minutos * 60 * 1000
                    registrarAccionRoot(sender, 'admin_event_control', `boss_cooldown ${minutos}min`, null)
                    return sendReply(sock, from, { text: tr(lang, `🔧 *[SYSTEM ROOT]* Cooldown de aparición de Boss: ${minutos} minutos.`, `🔧 *[SYSTEM ROOT]* Cooldown de spawn de Boss: ${minutos} minutos.`, `🔧 *[SYSTEM ROOT]* Cooldown de aparición de Boss: ${minutos} minutes.`) }, { quoted: m })
                }
                if (evento === 'pvp_disable') {
                    pvpDeshabilitado = (args[1] || '').toLowerCase() === 'true'
                    registrarAccionRoot(sender, 'admin_event_control', `pvp_disable ${pvpDeshabilitado}`, null)
                    return sendReply(sock, from, { text: `🔧 *[SYSTEM ROOT]* PvP global: ${pvpDeshabilitado ? 'DESHABILITADO' : 'HABILITADO'}` }, { quoted: m })
                }
                if (evento === 'global_message') {
                    const mensaje = args.slice(1).join(' ')
                    registrarAccionRoot(sender, 'admin_event_control', `global_message: ${mensaje}`, null)
                    return sendReply(sock, from, { text: `📢 *[MENSAJE GLOBAL DEL SISTEMA]*\n\n${mensaje}` }, { quoted: m })
                }
                return sendReply(sock, from, { text: tr(lang, `❌ Evento no reconocido. Disponibles: boss_spawn_chance <0-100>, boss_cooldown <minutos>, pvp_disable true/false, global_message <texto>`, `❌ Evento no reconocido. Disponibles: boss_spawn_chance <0-100>, boss_cooldown <minutos>, pvp_disable true/false, global_message <texto>`, `❌ Evento no reconocido. Disponibles: boss_spawn_chance <0-100>, boss_cooldown <minutos>, pvp_disable true/false, global_message <texto>`) }, { quoted: m })
            }


            // ====================== WOLFRIC FRONTIER: ADMINISTRACIÓN DE TEMPORADA ======================
            if (command === 'admin_frontier_status' && isOwner) {
                return sendReply(sock, from, { text: `${frontierTitulo('𝗙𝗥𝗢𝗡𝗧𝗜𝗘𝗥 𝗔𝗗𝗠𝗜𝗡', 'Estado de mantenimiento', '🔧')}\n\n${frontierPanel('𝗘𝗦𝗧𝗔𝗗𝗢', [`Temporada: ${frontierMundo.temporada.nombre}`, `Estado: ${frontierMundo.temporada.estado}`, `Encuentros Guardianes activos: ${frontierSoberanosActivos.size}`, `Resonancias activas: ${frontierResonanciasActivas.size}`, `Eventos globales: ${frontierMundo.eventos.length}`], '🛠️')}` }, { quoted: m })
            }
            if (command === 'admin_frontier_season' && isOwner) {
                if (!overdriveActivo.has(normalizarJid(sender))) return sendReply(sock, from, { text: `❌ Activa primero *${prefix}admin_overdrive_on*.` }, { quoted: m })
                const nombre = text.trim(); if (!nombre) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}admin_frontier_season <nombre>`, `❌ Uso: ${prefix}admin_frontier_season <nombre>`, `❌ Usage: ${prefix}admin_frontier_season <nombre>`) }, { quoted: m })
                frontierMundo.temporada.nombre = nombre; frontierMundo.temporada.inicio = Date.now(); frontierMundo.temporada.estado = 'activa'; frontierMundoGuardar(); registrarAccionRoot(sender, 'admin_frontier_season', nombre, null)
                return sendReply(sock, from, { text: `🔧 Temporada Frontier actualizada: *${nombre}*.` }, { quoted: m })
            }
            if (command === 'admin_frontier_reset' && isOwner) {
                if (!overdriveActivo.has(normalizarJid(sender))) return sendReply(sock, from, { text: `❌ Activa primero *${prefix}admin_overdrive_on*.` }, { quoted: m })
                const chatObjetivo = text.trim() || from; frontierSoberanosActivos.delete(chatObjetivo); frontierResonanciasActivas.delete(chatObjetivo); frontierGuardarSoberanos(); frontierGuardarResonancias(); registrarAccionRoot(sender, 'admin_frontier_reset', chatObjetivo, null)
                return sendReply(sock, from, { text: `🔧 Encuentros Frontier reiniciados para *${chatObjetivo}*. Los perfiles y recompensas no fueron borrados.` }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: TÍTULOS ======================
            if (command === 'titles') {
                const user = getUsuario(sender)
                if (!user.titles.length) return sendReply(sock, from, { text: tr(lang, `🏆 No tienes ningún título todavía. Usa *${prefix}titlelist* para ver cómo conseguirlos.`, `🏆 No tienes ningún título todavía. Usa *${prefix}titlelist* para ver cómo conseguirlos.`, `🏆 You do not have any title yet. Use *${prefix}titlelist* to see how to get them.`) }, { quoted: m })
                const lista = user.titles.map(t => t === user.equippedTitle ? `👑 ${t} (equipado)` : `• ${t}`).join('\n')
                await sendReply(sock, from, { text: tr(lang, `🏆 *Tus títulos:*\n\n${lista}\n\nUsa *${prefix}titleequip <nombre>* para equipar uno.`, `🏆 *Tus títulos:*\n\n${lista}\n\nUsa *${prefix}titleequip <nombre>* para equipar uno.`, `🏆 *Tus titles:*\n\n${lista}\n\nUsa *${prefix}titleequip <nombre>* para equipar uno.`) }, { quoted: m })
            }

            if (command === 'titleequip') {
                const user = getUsuario(sender)
                const nombreTitulo = text.trim()
                if (!nombreTitulo) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}titleequip <nombre del título>`, `❌ Uso: ${prefix}titleequip <nombre del título>`, `❌ Usage: ${prefix}titleequip <nombre del title>`) }, { quoted: m })
                if (!user.titles.includes(nombreTitulo)) return sendReply(sock, from, { text: tr(lang, '❌ No tienes ese título.', '❌ Você não tem esse título.', `❌ You don't have ese title.`) }, { quoted: m })
                user.equippedTitle = nombreTitulo
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `👑 Título equipado: *${nombreTitulo}*`, `👑 Título equipado: *${nombreTitulo}*`, `👑 Title equipped: *${nombreTitulo}*`) }, { quoted: m })
            }

            if (command === 'titlelist') {
                let texto = `🏆 *CATÁLOGO DE TÍTULOS*\n\n`
                TITULOS.forEach(t => {
                    texto += `*${t.nombre}*\n📋 ${t.logro}\n⚡ Comando: .${t.comando}\n\n`
                })
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: LOGROS (separado de Títulos) ======================
            if (command === 'logros' || command === 'logro') {
                const user = getUsuario(sender)
                const desbloqueados = user.logrosDesbloqueados || []
                const secciones = [...new Set(LOGROS.map(l => l.seccion))]
                let texto = `🏅 *LOGROS DE WOLFRIC PROTOCOL* (${desbloqueados.length}/${LOGROS.length})\n\nSe guardan solos, no se equipan — es tu historial de todo lo que hiciste en el bot.\n\n`
                secciones.forEach(sec => {
                    texto += `▬▬▬ *${sec.toUpperCase()}* ▬▬▬\n`
                    LOGROS.filter(l => l.seccion === sec).forEach(l => {
                        const tiene = desbloqueados.includes(l.nombre)
                        texto += `${tiene ? '✅' : '🔒'} *${l.nombre}*\n   📋 ${l.como}\n   🎁 ${l.premio}\n`
                    })
                    texto += `\n`
                })
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: MISIONES ======================
            if (command === 'misiones' || command === 'mision') {
                const user = getUsuario(sender)
                actualizarMisiones(user)
                const avisos = reclamarMisionesCompletas(user)
                guardarEconomia()

                let texto = `📜 *MISIONES DE ${pushName.toUpperCase()}*\n\n`
                texto += `☀️ *DIARIAS* (se renuevan cada 24h)\n`
                user.misionesDiarias.forEach(m => {
                    const progreso = Math.min(m.meta, (user[m.campo] || 0) - m.inicio)
                    texto += `${m.reclamada ? '✅' : '⏳'} *${m.nombre}* — ${m.desc}\n   Progreso: ${progreso}/${m.meta}\n`
                })
                texto += `\n📅 *SEMANALES* (se renuevan cada 7 días)\n`
                user.misionesSemanales.forEach(m => {
                    const progreso = Math.min(m.meta, (user[m.campo] || 0) - m.inicio)
                    texto += `${m.reclamada ? '✅' : '⏳'} *${m.nombre}* — ${m.desc}\n   Progreso: ${progreso}/${m.meta}\n`
                })
                texto += `\nLas recompensas se acreditan solas apenas completás una misión.`
                if (avisos.length) texto = avisos.join('\n') + `\n\n` + texto
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'granttitle' && isOwner) {
                const mentioned = getMentioned()
                const nombreTitulo = args.filter(a => !a.startsWith('@')).join(' ')
                const tituloValido = TITULOS.find(t => t.nombre.toLowerCase() === nombreTitulo.toLowerCase())
                if (!mentioned.length || !tituloValido) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}granttitle @usuario <nombre exacto del título>`, `❌ Uso: ${prefix}granttitle @usuario <nombre exacto del título>`, `❌ Usage: ${prefix}granttitle @user <nombre exacto del title>`) }, { quoted: m })
                const target = getUsuario(mentioned[0])
                if (target.titles.includes(tituloValido.nombre)) return sendReply(sock, from, { text: tr(lang, '❌ Ya tiene ese título.', '❌ Já tem esse título.', '❌ Ya tiene ese title.') }, { quoted: m })
                target.titles.push(tituloValido.nombre)
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `🎖️ *[ROOT]* Título *${tituloValido.nombre}* otorgado a @${mentioned[0].split('@')[0]}.`, `🎖️ *[ROOT]* Título *${tituloValido.nombre}* otorgado a @${mentioned[0].split('@')[0]}.`, `🎖️ *[ROOT]* Título *${tituloValido.nombre}* otorgado a @${mentioned[0].split('@')[0]}.`), mentions: [mentioned[0]] }, { quoted: m })
            }

            // Comandos especiales de título (solo funcionan si el usuario lo tiene desbloqueado)
            const comandosDeTitulo = TITULOS.map(t => t.comando)
            if (comandosDeTitulo.includes(command)) {
                const user = getUsuario(sender)
                const titulo = TITULOS.find(t => t.comando === command)
                if (!user.titles.includes(titulo.nombre)) return sendReply(sock, from, { text: tr(lang, `❌ Necesitas el título *${titulo.nombre}* para usar este comando.`, `❌ Você precisa do título *${titulo.nombre}* pra usar este comando.`, `❌ You need the title *${titulo.nombre}* to use this command.`) }, { quoted: m })

                if (command === 'provocar') {
                    const mentioned = getMentioned()
                    if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}provocar @usuario`, `❌ Uso: ${prefix}provocar @usuario`, `❌ Usage: ${prefix}provocar @user`) }, { quoted: m })
                    await sendReply(sock, from, { text: tr(lang, `😏 *${pushName}* provoca a @${mentioned[0].split('@')[0]}. Su AGI baja un 5% en el próximo duelo.`, `😏 *${pushName}* provoca @${mentioned[0].split('@')[0]}. A AGI dele cai 5% no próximo duelo.`, `😏 *${pushName}* taunts @${mentioned[0].split('@')[0]}. Their AGI drops 5% in the next duel.`), mentions: [sender, mentioned[0]] }, { quoted: m })
                }
                if (command === 'arena_stats') {
                    await sendReply(sock, from, { text: tr(lang, `⚔️ *Récord de Arena de ${pushName}*\n🏆 Victorias: ${user.wins}`, `⚔️ *Recorde de Arena de ${pushName}*\n🏆 Vitórias: ${user.wins}`, `⚔️ *${pushName}'s Arena record*\n🏆 Wins: ${user.wins}`) }, { quoted: m })
                }
                if (command === 'apuesta_alta') {
                    const monto = parseInt(args[0])
                    if (!monto || monto <= 0 || monto > user.coins) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}apuesta_alta <monto> (debes tener esa cantidad)`, `❌ Uso: ${prefix}apuesta_alta <monto> (debes tener esa cantidad)`, `❌ Usage: ${prefix}apuesta_alta <amount> (you must have that much)`) }, { quoted: m })
                    const gana = Math.random() < 0.48
                    if (gana) { user.coins += monto; user.lifetimeCoinsEarned += monto } else { user.coins -= monto }
                    guardarEconomia()
                    await sendReply(sock, from, { text: gana ? tr(lang, `🎰 ¡Ganaste! +${monto} monedas.\n💰 Total: ${user.coins}`, `🎰 Você ganhou! +${monto} moedas.\n💰 Total: ${user.coins}`, `🎰 You won! +${monto} coins.\n💰 Total: ${user.coins}`) : tr(lang, `🎰 Perdiste ${monto} monedas.\n💰 Total: ${user.coins}`, `🎰 Você perdeu ${monto} moedas.\n💰 Total: ${user.coins}`, `🎰 You lost ${monto} coins.\n💰 Total: ${user.coins}`) }, { quoted: m })
                }
                if (command === 'mercado_negro') {
                    let texto = tr(lang, `🏴 *MERCADO NEGRO*\n\nAcceso temporal a la tienda de ítems consumibles. Usa *${prefix}tienda* para ver los precios normales y *${prefix}compraritem <número>* para comprar.\n\n`, `🏴 *MERCADO NEGRO*\n\nAcesso temporário à loja de itens consumíveis. Use *${prefix}shop* pra ver os preços normais e *${prefix}buyitem <número>* pra comprar.\n\n`, `🏴 *BLACK MARKET*\n\nTemporary access to the consumable item shop. Use *${prefix}shop* to see normal prices and *${prefix}buyitem <number>* to buy.\n\n`)
                    ITEMS_CONSUMIBLES.forEach(item => { texto += `*${item.id}.* ${item.nombre}\n` })
                    await sendReply(sock, from, { text: texto }, { quoted: m })
                }
                if (command === 'lluviamonedas') {
                    await sendReply(sock, from, { text: tr(lang, `💸 *${pushName}* activó lluvia de monedas. (Efecto grupal en desarrollo — por ahora es cosmético)`, `💸 *${pushName}* activó lluvia de moedas. (Efecto grupal en desarrollo — por ahora es cosmético)`, `💸 *${pushName}* activó lluvia de coins. (Efecto grupal en desarrollo — por ahora es cosmético)`) }, { quoted: m })
                }
                if (command === 'mendigar') {
                    const premio = Math.floor(Math.random() * 100)
                    user.coins += premio
                    guardarEconomia()
                    await sendReply(sock, from, { text: tr(lang, `🥺 Te compadecen y te dan *${premio}* monedas.`, `🥺 Te compadecen y te dan *${premio}* moedas.`, `🥺 Te compadecen y te dan *${premio}* coins.`) }, { quoted: m })
                }
                if (['juicio_final', 'bendecir', 'intimidar', 'saquear', 'crashear_matrix'].includes(command)) {
                    await sendReply(sock, from, { text: tr(lang, `✨ *${titulo.nombre}* activado: efecto especial de *${command}* aplicado (cosmético por ahora).`, `✨ *${titulo.nombre}* activado: efecto especial de *${command}* aplicado (cosmético por ahora).`, `✨ *${titulo.nombre}* activado: efecto especial de *${command}* aplicado (cosmético por ahora).`) }, { quoted: m })
                }
            }

            // ====================== WOLFRIC PROTOCOL: GREMIOS ======================
            // ====================== WOLFRIC PROTOCOL: MARES E ISLAS ======================
            if (command === 'mares') {
                let texto = `🌊 *MARES DE WOLFRIC PROTOCOL* 🌊\n\nCada mar tiene 2 islas para farmear y 1 isla aparte para pelear contra su boss. Para viajar hace falta estar en un gremio de al menos 2 personas.\n\n`
                MARES.forEach(mar => {
                    texto += `*${mar.id}. ${mar.nombre}* ${mar.gratis ? '(gratis)' : `(nivel ${mar.nivelMin}+, $${mar.costo})`}\n`
                    mar.islas.forEach(isla => { texto += `   • Isla ${isla.id}: ${isla.nombre} ${isla.tema} — ${isla.monstruo}\n` })
                    texto += `   • Isla Boss: ${mar.boss.nombre} (${mar.boss.hpMax} HP)\n\n`
                })
                texto += `Usa *${prefix}viajar <número de mar>*, después *${prefix}isla <número o "boss">*.`
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'viajar') {
                const user = getUsuario(sender)
                const marId = parseInt(args[0])
                const mar = MARES.find(m => m.id === marId)
                if (!mar) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}viajar <1/2/3>. Usa *${prefix}mares* para ver las opciones.`, `❌ Uso: ${prefix}viajar <1/2/3>. Usa *${prefix}mares* para ver las opciones.`, `❌ Usage: ${prefix}viajar <1/2/3>. Usa *${prefix}mares* para ver las opciones.`) }, { quoted: m })

                const nombreGremio = gremioDe(sender)
                if (!nombreGremio) return sendReply(sock, from, { text: tr(lang, '❌ Para viajar a un mar hace falta estar en un gremio. Usa *.guild create* o *.guild join*.', '❌ Para viajar a um mar você precisa estar em uma guild. Use *.guild create* ou *.guild join*.', '❌ You need a guild to travel to a sea. Use *.guild create* o *.guild join*.') }, { quoted: m })
                const gremio = gremios.get(nombreGremio)
                if (!gremio || gremio.miembros.length < 2) return sendReply(sock, from, { text: tr(lang, '❌ Tu gremio necesita al menos 2 miembros para viajar en grupo.', '❌ Sua guild precisa de pelo menos 2 membros para viajar em grupo.', '❌ Tu guild necesita al menos 2 members para travel en group.') }, { quoted: m })

                if (!mar.gratis) {
                    if (user.level < mar.nivelMin) return sendReply(sock, from, { text: tr(lang, `❌ ${mar.nombre} requiere nivel *${mar.nivelMin}* (tenés ${user.level}).`, `❌ ${mar.nombre} requiere nivel *${mar.nivelMin}* (você tem ${user.level}).`, `❌ ${mar.nombre} requiere nivel *${mar.nivelMin}* (you have ${user.level}).`) }, { quoted: m })
                    if (user.coins < mar.costo) return sendReply(sock, from, { text: tr(lang, `❌ ${mar.nombre} cuesta *$${mar.costo}* para el viaje (tenés $${user.coins}).`, `❌ ${mar.nombre} cuesta *$${mar.costo}* para el viaje (você tem $${user.coins}).`, `❌ ${mar.nombre} cuesta *$${mar.costo}* para el viaje (you have $${user.coins}).`) }, { quoted: m })
                    user.coins -= mar.costo
                }
                user.marActual = mar.id
                user.islaActual = null
                user.haViajado = true
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `⛵ *${pushName}* llega a *${mar.nombre}*.\nUsa *${prefix}isla <número o "boss">* para desembarcar.`, `⛵ *${pushName}* llega a *${mar.nombre}*.\nUsa *${prefix}isla <número o "boss">* para desembarcar.`, `⛵ *${pushName}* llega a *${mar.nombre}*.\nUsa *${prefix}isla <número o "boss">* para desembarcar.`) }, { quoted: m })
            }

            if (command === 'isla') {
                const user = getUsuario(sender)
                const mar = MARES.find(m => m.id === user.marActual)
                if (!mar) return sendReply(sock, from, { text: tr(lang, `❌ No estás en ningún mar. Usa *${prefix}viajar <número>* primero.`, `❌ Você não está em nenhum mar. Usa *${prefix}viajar <número>* primero.`, `❌ You're not in any sea. Usa *${prefix}viajar <número>* primero.`) }, { quoted: m })

                const cual = (args[0] || '').toLowerCase()
                if (cual === 'boss') {
                    user.islaActual = 'boss'
                    guardarEconomia()
                    return sendReply(sock, from, { text: tr(lang, `🏝️ Desembarcás en la Isla Boss de *${mar.nombre}*. Usa *${prefix}attackislandboss*.`, `🏝️ Você desembarca na Ilha Boss de *${mar.nombre}*. Use *${prefix}attackislandboss*.`, `🏝️ You land on la Isla Boss de *${mar.nombre}*. Use *${prefix}attackislandndboss*.`) }, { quoted: m })
                }
                const isla = mar.islas.find(i => i.id === parseInt(cual))
                if (!isla) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}island <1/2/boss>`, `❌ Uso: ${prefix}island <1/2/boss>`, `❌ Usage: ${prefix}islandnd <1/2/boss>`) }, { quoted: m })
                user.islaActual = isla.id
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `🏝️ Desembarcás en *${isla.nombre}* ${isla.tema} (${mar.nombre}).\nUsa *${prefix}explore* para buscar recursos y monstruos.`, `🏝️ Você desembarca em *${isla.nombre}* ${isla.tema} (${mar.nombre}).\nUse *${prefix}explore* para buscar recursos e monstros.`, `🏝️ You land on *${isla.nombre}* ${isla.tema} (${mar.nombre}).\nUse *${prefix}explore* to look for resources and monsters.`) }, { quoted: m })
            }

            if (command === 'explorar') {
                const user = getUsuario(sender)
                const mar = MARES.find(m => m.id === user.marActual)
                if (!mar) return sendReply(sock, from, { text: tr(lang, `❌ No estás en ningún mar. Usa *${prefix}travel*.`, `❌ Você não está em nenhum mar. Use *${prefix}travel*.`, `❌ You're not in any sea. Use *${prefix}travel*.`) }, { quoted: m })
                const isla = mar.islas.find(i => i.id === user.islaActual)
                if (!isla) return sendReply(sock, from, { text: tr(lang, `❌ No estás en una isla de farmeo. Usa *${prefix}island <1/2>*.`, `❌ Você não está em uma ilha de farm. Use *${prefix}island <1/2>*.`, `❌ No estás en una island de farmeo. Use *${prefix}islandnd <1/2>*.`) }, { quoted: m })

                const ahora = Date.now()
                if (ahora - user.lastExplorar < EXPLORAR_COOLDOWN_MS) {
                    return sendReply(sock, from, { text: tr(lang, `⏳ Todavía estás explorando. Volvé a intentar en *${clockString(EXPLORAR_COOLDOWN_MS - (ahora - user.lastExplorar))}*.`, `⏳ Você ainda está explorando. Tente de novo em *${clockString(EXPLORAR_COOLDOWN_MS - (ahora - user.lastExplorar))}*.`, `⏳ You're still exploring. Try again en *${clockString(EXPLORAR_COOLDOWN_MS - (ahora - user.lastExplorar))}*.`) }, { quoted: m })
                }
                user.lastExplorar = ahora
                user.explorarUsos = (user.explorarUsos || 0) + 1

                let texto
                const protegidoPorBrujula = (user.buffExploracionRestante || 0) > 0
                if (Math.random() < PROB_EVENTO_EXPEDICION && !protegidoPorBrujula) {
                    // ---- Evento aleatorio: piratas, monstruos, naufragios, o algo de suerte ----
                    const evento = EVENTOS_EXPEDICION[Math.floor(Math.random() * EVENTOS_EXPEDICION.length)]
                    texto = `⚡ *EVENTO: ${evento.nombre}* ⚡\n\n${evento.ejecutar(user, isla)}\n\n❤️ HP actual: ${user.hp}/${user.maxHp}`
                    if (user.hp <= user.maxHp * 0.2) { texto += `\n⚠️ Estás malherido. Volvé con *${prefix}volverislaprincipal* antes de que te pase algo peor.`; user.sobrevivioCritico = true }
                } else {
                    if (protegidoPorBrujula) user.buffExploracionRestante--
                    let monedas = Math.floor(Math.random() * (isla.max - isla.min + 1)) + isla.min
                    let bonusFortuna = ''
                    if ((user.buffFortunaRestante || 0) > 0) {
                        const extra = Math.floor(monedas * user.buffFortunaPct)
                        monedas += extra
                        user.buffFortunaRestante--
                        bonusFortuna = ` (🍀 +${extra} de fortuna)`
                    }
                    user.coins += monedas
                    user.lifetimeCoinsEarned += monedas
                    user.exp += 8
                    user.bounty += 3

                    const narrativas = [
                        `Explorás ${isla.nombre} y te topás con un ${isla.monstruo}. Lo espantás y encontrás un botín escondido.`,
                        `Un ${isla.monstruo} te ataca por sorpresa, pero lográs derrotarlo y quedarte con sus recursos.`,
                        `Recorrés la isla en silencio y encontrás una caja de suministros olvidada.`,
                        `El ${isla.monstruo} local te deja pasar a cambio de nada... pero igual encontrás monedas tiradas por ahí.`
                    ]
                    texto = `${narrativas[Math.floor(Math.random() * narrativas.length)]}\n\n💰 +${monedas} monedas${bonusFortuna} · ✨ +8 EXP · 💀 +3 Bounty`
                    if (protegidoPorBrujula) texto += `\n🧭 Brújula Certera activa (${user.buffExploracionRestante} usos restantes).`
                }
                const nuevosTitulos = revisarTitulosAutomaticos(user, sender)
                guardarEconomia()
                if (nuevosTitulos.length) texto += `\n\n🎖️ *¡Nuevo título desbloqueado!* ${nuevosTitulos.join(', ')}`
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'atacarbossisla') {
                const user = getUsuario(sender)
                const mar = MARES.find(m => m.id === user.marActual)
                if (!mar) return sendReply(sock, from, { text: tr(lang, `❌ No estás en ningún mar.`, `❌ Você não está em nenhum mar.`, `❌ You're not in any sea.`) }, { quoted: m })
                if (user.islaActual !== 'boss') return sendReply(sock, from, { text: tr(lang, `❌ Tenés que estar en la Isla Boss. Usa *${prefix}isla boss*.`, `❌ Você precisa estar na Ilha Boss. Usa *${prefix}isla boss*.`, `❌ You need to be on the Boss Island. Usa *${prefix}isla boss*.`) }, { quoted: m })

                if (!islaBosses.has(mar.id)) islaBosses.set(mar.id, { hp: mar.boss.hpMax, hpMax: mar.boss.hpMax })
                const boss = islaBosses.get(mar.id)

                let daño = user.stats.str + user.stats.int + (10 + Math.floor(Math.random() * 21))
                daño = Math.max(1, daño)
                boss.hp = Math.max(0, boss.hp - daño)

                let texto = `⚔️ @${sender.split('@')[0]} golpea a *${mar.boss.nombre}* por *${daño}* de daño.\n`
                if (boss.hp <= 0) {
                    user.coins += mar.boss.coins
                    user.lifetimeCoinsEarned += mar.boss.coins
                    user.exp += mar.boss.exp
                    user.bounty += mar.boss.bounty
                    islaBosses.delete(mar.id)
                    texto += `\n🏆 *¡${mar.boss.nombre} DERROTADO!* @${sender.split('@')[0]} se lleva +${mar.boss.coins} monedas, +${mar.boss.exp} EXP, +${mar.boss.bounty} Bounty.\nEl boss volverá a aparecer más adelante.`
                    const nuevosTitulos = revisarTitulosAutomaticos(user, sender)
                    if (nuevosTitulos.length) texto += `\n🎖️ *¡Nuevo título desbloqueado!* ${nuevosTitulos.join(', ')}`
                } else {
                    texto += `\n❤️ HP del boss: ${boss.hp}/${boss.hpMax}`
                }
                guardarEconomia()
                await sendReply(sock, from, { text: texto, mentions: [sender] }, { quoted: m })
            }

            if (command === 'volverislaprincipal') {
                const user = getUsuario(sender)
                if (user.marActual === null) return sendReply(sock, from, { text: tr(lang, '🏝️ Ya estás en la Isla Principal.', '🏝️ Você já está na Ilha Principal.', `🏝️ You're already en la Isla Principal.`) }, { quoted: m })
                user.marActual = null
                user.islaActual = null
                user.lastVueltaTierra = Date.now()
                user.vecesVolvioTierra = (user.vecesVolvioTierra || 0) + 1
                const nuevosTitulos = revisarTitulosAutomaticos(user, sender)
                guardarEconomia()
                let texto = `🏝️ *${pushName}* vuelve a la Isla Principal.\n\n❤️ HP: ${user.hp}/${user.maxHp} — se recupera *${REGEN_HP_TIERRA_POR_MIN} HP por minuto* mientras estés acá (o curate al instante con una poción).\n\nAcá podés hacer duelos, mazmorras y 2vs2 de nuevo.`
                if (user.debuffExpedicionExpira > Date.now()) texto += `\n\n🩹 Todavía te dura la herida de la expedición (${user.debuffExpedicionStat.toUpperCase()} reducido) por un rato más.`
                if (nuevosTitulos.length) texto += `\n\n🎖️ *¡Nuevo título/logro desbloqueado!* ${nuevosTitulos.join(', ')}`
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'guild') {
                const sub = (args[0] || '').toLowerCase()
                const nombreGremio = args.slice(1).join(' ')

                if (sub === 'create') {
                    if (!nombreGremio) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}guild create <nombre>`, `❌ Uso: ${prefix}guild create <nombre>`, `❌ Usage: ${prefix}guild create <nombre>`) }, { quoted: m })
                    if (gremios.has(nombreGremio)) return sendReply(sock, from, { text: tr(lang, '❌ Ya existe un gremio con ese nombre.', '❌ Já existe uma guild com esse nome.', '❌ Ya existe un guild con ese name.') }, { quoted: m })
                    if (gremioDe(sender)) return sendReply(sock, from, { text: tr(lang, '❌ Ya perteneces a un gremio. Sal primero con .guild leave', '❌ Você já pertence a uma guild. Saia primeiro com .guild leave', '❌ Ya perteneces a un guild. Sal primero con .guild leave') }, { quoted: m })
                    gremios.set(nombreGremio, { creador: sender, miembros: [sender] })
                    guardarGremios()
                    const user = getUsuario(sender)
                    user.guild = nombreGremio
                    // Bonus SOLO la primera vez que creas un gremio (no se puede farmear)
                    const primeraVez = !user.logrosDesbloqueados.includes('Fundador')
                    let extra = ''
                    if (primeraVez) {
                        user.coins += 300
                        user.lifetimeCoinsEarned += 300
                        user.exp += 30
                        user.logrosDesbloqueados.push('Fundador')
                        extra = `\n🎁 +300 monedas, +30 EXP por fundarlo.\n🏅 Logro desbloqueado: *Fundador*`
                    }
                    guardarEconomia()
                    return sendReply(sock, from, { text: tr(lang, `🔰 Gremio *${nombreGremio}* creado. ¡Eres el líder!${extra}`, `🔰 Gremio *${nombreGremio}* creado. Eres el líder!${extra}`, `🔰 Gremio *${nombreGremio}* creado. Eres el líder!${extra}`) }, { quoted: m })
                }
                if (sub === 'join') {
                    if (!nombreGremio || !gremios.has(nombreGremio)) return sendReply(sock, from, { text: tr(lang, `❌ Ese gremio no existe. Usa ${prefix}guild list`, `❌ Ese guilda no existe. Usa ${prefix}guild list`, `❌ Ese guild no existe. Usa ${prefix}guild list`) }, { quoted: m })
                    if (gremioDe(sender)) return sendReply(sock, from, { text: tr(lang, '❌ Ya perteneces a un gremio.', '❌ Você já pertence a uma guild.', '❌ Ya perteneces a un guild.') }, { quoted: m })
                    gremios.get(nombreGremio).miembros.push(sender)
                    guardarGremios()
                    const user = getUsuario(sender)
                    user.guild = nombreGremio
                    // Bonus SOLO la primera vez que te unes a un gremio (no se puede farmear saliendo y entrando)
                    const primeraVez = !user.logrosDesbloqueados.includes('Compañerismo')
                    let extra = ''
                    if (primeraVez) {
                        user.coins += 300
                        user.lifetimeCoinsEarned += 300
                        user.exp += 30
                        user.logrosDesbloqueados.push('Compañerismo')
                        extra = `\n🎁 +300 monedas, +30 EXP de bienvenida.\n🏅 Logro desbloqueado: *Compañerismo*`
                    }
                    guardarEconomia()
                    return sendReply(sock, from, { text: tr(lang, `✅ Te uniste al gremio *${nombreGremio}*.${extra}`, `✅ Te uniste al guilda *${nombreGremio}*.${extra}`, `✅ Te uniste al guild *${nombreGremio}*.${extra}`) }, { quoted: m })
                }
                if (sub === 'leave') {
                    const actual = gremioDe(sender)
                    if (!actual) return sendReply(sock, from, { text: tr(lang, '❌ No perteneces a ningún gremio.', '❌ Você não pertence a nenhuma guild.', '❌ No perteneces a ningún guild.') }, { quoted: m })
                    const g = gremios.get(actual)
                    g.miembros = g.miembros.filter(mem => normalizarJid(mem) !== normalizarJid(sender))
                    if (!g.miembros.length) gremios.delete(actual)
                    guardarGremios()
                    const user = getUsuario(sender)
                    user.guild = null
                    guardarEconomia()
                    return sendReply(sock, from, { text: tr(lang, `👋 Saliste del gremio *${actual}*.`, `👋 Saliste del guilda *${actual}*.`, `👋 Saliste del guild *${actual}*.`) }, { quoted: m })
                }
                if (sub === 'info') {
                    const actual = gremioDe(sender)
                    if (!actual) return sendReply(sock, from, { text: tr(lang, '❌ No perteneces a ningún gremio.', '❌ Você não pertence a nenhuma guild.', '❌ No perteneces a ningún guild.') }, { quoted: m })
                    const g = gremios.get(actual)
                    return sendReply(sock, from, { text: tr(lang, `🔰 *${actual}*\n👑 Líder: @${g.creador.split('@')[0]}\n👥 Miembros: ${g.miembros.length}`, `🔰 *${actual}*\n👑 Líder: @${g.creador.split('@')[0]}\n👥 Miembros: ${g.miembros.length}`, `🔰 *${actual}*\n👑 Líder: @${g.creador.split('@')[0]}\n👥 Miembros: ${g.miembros.length}`), mentions: [g.creador] }, { quoted: m })
                }
                if (sub === 'list') {
                    if (!gremios.size) return sendReply(sock, from, { text: tr(lang, '❌ No hay gremios creados todavía.', '❌ Ainda não há guilds criadas.', `❌ There's no guilds creados still.`) }, { quoted: m })
                    const lista = [...gremios.entries()].map(([n, g]) => `• ${n} (${g.miembros.length} miembros)`).join('\n')
                    return sendReply(sock, from, { text: tr(lang, `🔰 *GREMIOS ACTIVOS*\n\n${lista}`, `🔰 *GUILDAS ATIVAS*\n\n${lista}`, `🔰 *ACTIVE GUILDS*\n\n${lista}`) }, { quoted: m })
                }
                return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}guild <create/join/leave/info/list> [nombre]`, `❌ Uso: ${prefix}guild <create/join/leave/info/list> [nombre]`, `❌ Usage: ${prefix}guild <create/join/leave/info/list> [nombre]`) }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: GUERRA DE GREMIOS ======================
            if (command === 'guerra' || command === 'guerragremios') {
                const sub = (args[0] || '').toLowerCase()
                const user = getUsuario(sender)
                const miGremio = gremioDe(sender)

                if (sub === 'declarar') {
                    if (!miGremio) return sendReply(sock, from, { text: tr(lang, `❌ No perteneces a ningún gremio. Creá o uníte a uno con ${prefix}guild.`, `❌ Você não pertence a nenhuma guilda. Crie ou entre em uma com ${prefix}guild.`, `❌ You don't belong to any guild. Create or join one with ${prefix}guild.`) }, { quoted: m })
                    const g = gremios.get(miGremio)
                    if (normalizarJid(g.creador) !== normalizarJid(sender)) return sendReply(sock, from, { text: tr(lang, '❌ Solo el líder del gremio puede declarar la guerra.', '❌ Só o líder da guilda pode declarar guerra.', '❌ Only the guild leader can declare war.') }, { quoted: m })
                    const nombreRival = args.slice(1).join(' ')
                    if (!nombreRival) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}guerra declarar <nombre del gremio rival>`, `❌ Uso: ${prefix}guerra declarar <nome da guilda rival>`, `❌ Usage: ${prefix}guerra declarar <rival guild name>`) }, { quoted: m })
                    if (!gremios.has(nombreRival)) return sendReply(sock, from, { text: tr(lang, `❌ Ese gremio no existe. Usa ${prefix}guild list`, `❌ Essa guilda não existe. Use ${prefix}guild list`, `❌ That guild doesn't exist. Use ${prefix}guild list`) }, { quoted: m })
                    if (nombreRival === miGremio) return sendReply(sock, from, { text: tr(lang, '❌ No podés declararle la guerra a tu propio gremio.', '❌ Você não pode declarar guerra à sua própria guilda.', "❌ You can't declare war on your own guild.") }, { quoted: m })
                    if (guerraActivaDeGremio(miGremio)) return sendReply(sock, from, { text: tr(lang, '❌ Tu gremio ya está en guerra. Esperá a que termine.', '❌ Sua guilda já está em guerra. Espere terminar.', '❌ Your guild is already at war. Wait for it to end.') }, { quoted: m })
                    if (guerraActivaDeGremio(nombreRival)) return sendReply(sock, from, { text: tr(lang, `❌ *${nombreRival}* ya está en otra guerra ahora mismo.`, `❌ *${nombreRival}* já está em outra guerra agora.`, `❌ *${nombreRival}* is already in another war right now.`) }, { quoted: m })

                    const id = `${miGremio}|${nombreRival}|${Date.now()}`
                    const ahora = Date.now()
                    guerrasGremios.set(id, {
                        gremioA: miGremio, gremioB: nombreRival, puntosA: 0, puntosB: 0,
                        contribuciones: {}, inicio: ahora, fin: ahora + GUERRA_DURACION_MS,
                        chatId: from, finalizada: false, ganadora: null
                    })
                    guardarGuerras()
                    const textoDeclaracion = tr(lang,
                        `⚔️ *¡GUERRA DE GREMIOS DECLARADA!* ⚔️\n\n🔰 *${miGremio}* vs 🔰 *${nombreRival}*\n\n⏳ Duración: 24 horas.\n💰 El gremio ganador se reparte +1000 monedas por miembro.\n\n📈 Sumás puntos para tu gremio ganando duelos, cazando monstruos, completando mazmorras y peleando contra bosses.\n\nUsa *${prefix}guerra estado* para ver el marcador en vivo.`,
                        `⚔️ *GUERRA DE GUILDAS DECLARADA!* ⚔️\n\n🔰 *${miGremio}* vs 🔰 *${nombreRival}*\n\n⏳ Duração: 24 horas.\n💰 A guilda vencedora divide +1000 moedas por membro.\n\n📈 Você soma pontos para sua guilda ganhando duelos, caçando monstros, completando mazmorras e lutando contra chefes.\n\nUse *${prefix}guerra estado* para ver o placar ao vivo.`,
                        `⚔️ *GUILD WAR DECLARED!* ⚔️\n\n🔰 *${miGremio}* vs 🔰 *${nombreRival}*\n\n⏳ Duration: 24 hours.\n💰 The winning guild splits +1000 coins per member.\n\n📈 You earn points for your guild by winning duels, hunting monsters, completing dungeons and fighting bosses.\n\nUse *${prefix}guerra estado* to see the live scoreboard.`)
                    await enviarConGif(sock, from, textoDeclaracion, 'war battle epic', [], { quoted: m })
                    return
                }

                if (sub === 'estado') {
                    if (!miGremio) return sendReply(sock, from, { text: tr(lang, '❌ No perteneces a ningún gremio.', '❌ Você não pertence a nenhuma guilda.', "❌ You don't belong to any guild.") }, { quoted: m })
                    const guerra = guerraActivaDeGremio(miGremio)
                    if (!guerra) return sendReply(sock, from, { text: tr(lang, `❌ Tu gremio no está en guerra ahora mismo. Declará una con ${prefix}guerra declarar <gremio>.`, `❌ Sua guilda não está em guerra agora. Declare uma com ${prefix}guerra declarar <guilda>.`, `❌ Your guild isn't at war right now. Declare one with ${prefix}guerra declarar <guild>.`) }, { quoted: m })
                    if (await finalizarGuerraSiCorresponde(sock, guerra)) return
                    const total = guerra.puntosA + guerra.puntosB
                    const pctA = total > 0 ? guerra.puntosA / total : 0.5
                    const longitud = 16
                    const llenosA = Math.round(pctA * longitud)
                    const barra = `[${'🟦'.repeat(llenosA)}${'🟥'.repeat(longitud - llenosA)}]`
                    const restante = guerra.fin - Date.now()
                    const textoEstado = tr(lang,
                        `⚔️ *GUERRA DE GREMIOS EN CURSO*\n\n🔰 *${guerra.gremioA}*: ${guerra.puntosA} pts\n${barra}\n🔰 *${guerra.gremioB}*: ${guerra.puntosB} pts\n\n⏳ Tiempo restante: ${clockString(restante)}\n\nUsa *${prefix}guerra ranking* para ver quién más aporta.`,
                        `⚔️ *GUERRA DE GUILDAS EM ANDAMENTO*\n\n🔰 *${guerra.gremioA}*: ${guerra.puntosA} pts\n${barra}\n🔰 *${guerra.gremioB}*: ${guerra.puntosB} pts\n\n⏳ Tempo restante: ${clockString(restante)}\n\nUse *${prefix}guerra ranking* para ver quem mais contribuiu.`,
                        `⚔️ *GUILD WAR IN PROGRESS*\n\n🔰 *${guerra.gremioA}*: ${guerra.puntosA} pts\n${barra}\n🔰 *${guerra.gremioB}*: ${guerra.puntosB} pts\n\n⏳ Time left: ${clockString(restante)}\n\nUse *${prefix}guerra ranking* to see who's contributing most.`)
                    await sendReply(sock, from, { text: textoEstado }, { quoted: m })
                    return
                }

                if (sub === 'ranking') {
                    if (!miGremio) return sendReply(sock, from, { text: tr(lang, '❌ No perteneces a ningún gremio.', '❌ Você não pertence a nenhuma guilda.', "❌ You don't belong to any guild.") }, { quoted: m })
                    const guerra = guerraActivaDeGremio(miGremio)
                    if (!guerra) return sendReply(sock, from, { text: tr(lang, '❌ Tu gremio no está en guerra ahora mismo.', '❌ Sua guilda não está em guerra agora.', "❌ Your guild isn't at war right now.") }, { quoted: m })
                    const top = Object.entries(guerra.contribuciones).sort((a, b) => b[1] - a[1]).slice(0, 10)
                    if (!top.length) return sendReply(sock, from, { text: tr(lang, 'Todavía nadie sumó puntos en esta guerra.', 'Ainda ninguém somou pontos nessa guerra.', "Nobody has scored any points in this war yet.") }, { quoted: m })
                    const lista = top.map(([jid, pts], i) => `${i + 1}. @${jid} — ${pts} pts`).join('\n')
                    await sendReply(sock, from, { text: tr(lang, `🏆 *TOP APORTES DE LA GUERRA*\n\n${lista}`, `🏆 *TOP CONTRIBUIÇÕES DA GUERRA*\n\n${lista}`, `🏆 *TOP WAR CONTRIBUTORS*\n\n${lista}`), mentions: top.map(([jid]) => jid + '@s.whatsapp.net') }, { quoted: m })
                    return
                }

                return sendReply(sock, from, { text: tr(lang,
                    `⚔️ *GUERRA DE GREMIOS*\n\nUso:\n${prefix}guerra declarar <gremio rival> — el líder declara la guerra\n${prefix}guerra estado — marcador en vivo\n${prefix}guerra ranking — quién más aportó`,
                    `⚔️ *GUERRA DE GUILDAS*\n\nUso:\n${prefix}guerra declarar <guilda rival> — o líder declara guerra\n${prefix}guerra estado — placar ao vivo\n${prefix}guerra ranking — quem mais contribuiu`,
                    `⚔️ *GUILD WAR*\n\nUsage:\n${prefix}guerra declarar <rival guild> — the leader declares war\n${prefix}guerra estado — live scoreboard\n${prefix}guerra ranking — who contributed most`) }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: BOSS GLOBAL ======================
            if ((command === 'spawnboss' || command === 'spawn_boss') && isOwner) {
                if (!isGroup) return sendReply(sock, from, { text: tr(lang, '❌ Los bosses solo aparecen en grupos.', '❌ Os bosses só aparecem em grupos.', '❌ Los bosses solo aparecen en groups.') }, { quoted: m })
                if (bosses.has(from)) return sendReply(sock, from, { text: tr(lang, '❌ Ya hay un boss activo en este chat.', '❌ Já existe um boss ativo neste chat.', `❌ There's already un boss activo en este chat.`) }, { quoted: m })
                let miembros = 0
                try { miembros = (await obtenerGroupMetadataCache(sock, from)).participants.length } catch (e) {}
                const boss = spawnearBoss(from, miembros)
                ultimoBossPorGrupo.set(from, Date.now())
                await sendReply(sock, from, { text: tr(lang, `🌑💀⛓️ *¡EL ${boss.nombre.toUpperCase()} HA APARECIDO!* ⛓️💀🌑 (invocado por un Arquitecto del Protocolo)\n\n❤️ HP: ${boss.hp}\n\nUsen *${prefix}attackboss* para combatirlo. ¡Tienen 45 minutos antes de que huya!`, `🌑💀⛓️ *EL ${boss.nombre.toUpperCase()} HA APARECIDO!* ⛓️💀🌑 (invocado por un Arquitecto del Protocolo)\n\n❤️ HP: ${boss.hp}\n\nUsen *${prefix}attackboss* para combatirlo. Tienen 45 minutos antes de que huya!`, `🌑💀⛓️ *EL ${boss.nombre.toUpperCase()} HAS APPEARED!* ⛓️💀🌑 (summoned by a Protocol Architect)\n\n❤️ HP: ${boss.hp}\n\nUse *${prefix}attackboss* para combatirlo. Tienen 45 minutos antes de que huya!`) }, { quoted: m })
                narrarBossIA(sock, from, boss.nombre).catch(() => {})
            }

            if (command === 'attackboss' || command === 'skillboss') {
                const boss = bosses.get(from)
                if (!boss || boss.hp <= 0) return sendReply(sock, from, { text: tr(lang, `❌ No hay ningún Boss activo aquí. Espera a que el dueño use ${prefix}spawnboss.`, `❌ Não tem nenhum Boss ativo aqui. Espera o dono usar ${prefix}spawnboss.`, `❌ There's no active Boss here. Wait for the owner to use ${prefix}spawnboss.`) }, { quoted: m, sinGif: true })
                const user = getUsuario(sender)
                const overdrive = overdriveActivo.has(normalizarJid(sender))
                let daño = command === 'skillboss'
                    ? Math.max(1, Math.floor(user.stats.int * 1.5))
                    : Math.max(1, Math.floor(user.stats.str))
                if (overdrive) daño *= 10

                boss.hp = Math.max(0, boss.hp - daño)
                const acumulado = boss.participantes.get(normalizarJid(sender)) || 0
                boss.participantes.set(normalizarJid(sender), acumulado + daño)

                let texto = `💥 @${sender.split('@')[0]} le hizo *${daño}* de daño al ${boss.nombre}.\n❤️ HP del boss: ${boss.hp}/${boss.maxHp}`

                if (boss.hp <= 0) {
                    bosses.delete(from)
                    // Distribuir recompensas: MVP (mayor daño) y participación
                    const ranking = [...boss.participantes.entries()].sort((a, b) => b[1] - a[1])
                    const mvpJid = ranking[0][0]
                    let textoLoot = `\n\n🏆 *¡BOSS DERROTADO!* 🏆\n`
                    ranking.forEach(([jid, daño], i) => {
                        const jugador = getUsuario(jid)
                        const recompensa = i === 0 ? 5000 : Math.floor(1000 * (daño / boss.maxHp) + 200)
                        jugador.coins += recompensa
                        jugador.lifetimeCoinsEarned += recompensa
                        jugador.bounty += i === 0 ? 150 : 30
                        sumarPuntosGuerra(jid, Math.max(1, Math.floor(daño / 50)))
                        textoLoot += `${i === 0 ? '👑 MVP' : `${i + 1}.`} @${jid.split('@')[0]} — daño: ${daño} — +${recompensa} monedas\n`
                    })
                    guardarEconomia()
                    texto += textoLoot
                    await sendReply(sock, from, { text: texto, mentions: ranking.map(r => r[0]) }, { quoted: m, sinGif: true })
                } else {
                    await sendReply(sock, from, { text: texto, mentions: [sender] }, { quoted: m, sinGif: true })
                }
            }

            // ====================== WOLFRIC PROTOCOL: FARMING DE MONSTRUOS ======================
            // ====================== WOLFRIC PROTOCOL: MAZMORRAS ======================
            async function finalizarMazmorra(chatId, exito) {
                const dg = mazmorrasActivas.get(chatId)
                if (!dg) return
                mazmorrasActivas.delete(chatId)
                ultimaMazmorraPorGrupo.set(chatId, Date.now())

                if (exito) {
                    let texto = `🏆 *¡MAZMORRA COMPLETADA!* Los 5 niveles cayeron.\n\n`
                    let eventoTexto = ''
                    dg.participantes.forEach(jid => {
                        const u = getUsuario(jid)
                        u.coins += 200
                        u.lifetimeCoinsEarned += 200
                        u.exp += 60
                        u.bounty += 25
                        u.mazmorrasCompletadas++
                        sumarPuntosGuerra(jid, 25)
                        const premioEvento = otorgarProgresoEventoAmigo(u)
                        if (premioEvento) eventoTexto += `\n\n@${jid.split('@')[0]}: ${premioEvento}`
                    })
                    guardarEconomia()
                    texto += dg.participantes.map(j => `@${j.split('@')[0]}`).join(', ') + `\n+200 monedas, +60 EXP, +25 Bounty cada uno.`
                    let titulosTexto = ''
                    dg.participantes.forEach(jid => {
                        const nuevos = revisarTitulosAutomaticos(getUsuario(jid), jid)
                        if (nuevos.length) titulosTexto += `\n🎖️ @${jid.split('@')[0]}: ${nuevos.join(', ')}`
                    })
                    await sendReply(sock, chatId, { text: texto + titulosTexto + eventoTexto, mentions: dg.participantes })
                } else {
                    let texto = `☠️ *LA MAZMORRA HA CAÍDO.* Todo el equipo fue derrotado.\n\n`
                    let eventoTexto = ''
                    dg.participantes.forEach(jid => {
                        const u = getUsuario(jid)
                        u.coins = Math.max(0, u.coins - 100)
                        u.bounty = Math.max(50, u.bounty - 50)
                        const premioEvento = otorgarProgresoEventoAmigo(u)
                        if (premioEvento) eventoTexto += `\n\n@${jid.split('@')[0]}: ${premioEvento}`
                    })
                    guardarEconomia()
                    texto += dg.participantes.map(j => `@${j.split('@')[0]}`).join(', ') + `\n-100 monedas, -50 Bounty cada uno. Suerte para la próxima.`
                    await sendReply(sock, chatId, { text: texto + eventoTexto, mentions: dg.participantes })
                }
            }

            function iniciarMazmorra(chatId) {
                const dg = mazmorrasActivas.get(chatId)
                if (!dg || dg.estado !== 'esperando') return
                dg.estado = 'jugando'
                dg.nivel = 1
                const monstruo = spawnMonstruoMazmorra(1, dg.participantes.length)
                dg.monstruoNombre = monstruo.nombre
                dg.monstruoHp = monstruo.hp
                dg.monstruoHpMax = monstruo.hpMax
                sendReply(sock, chatId, {
                    text: `🚪 *${tr(lang,'¡La mazmorra comienza!','A masmorra começou!','The dungeon starts!')}* ${tr(lang,'Equipo','Time','Team')}: ${dg.participantes.map(j => `@${j.split('@')[0]}`).join(', ')}\n\n👹 Nivel 1: *${monstruo.nombre}*\n❤️ HP: ${monstruo.hp}\n\nUsen *${prefix}mazmatacar* o *${prefix}mazmhabilidad* para pelear.`,
                    mentions: dg.participantes
                })
            }

            if (command === 'mazmorra') {
                if (!isGroup) return sendReply(sock, from, { text: tr(lang, '❌ Las mazmorras solo funcionan en grupos.', '❌ As dungeons só funcionam em grupos.', '❌ Las dungeons solo funcionan en groups.') }, { quoted: m, sinGif: true })
                if (mazmorrasActivas.has(from)) return sendReply(sock, from, { text: tr(lang, '❌ Ya hay una mazmorra en curso o esperando jugadores en este chat.', '❌ Já existe uma dungeon em andamento ou esperando jogadores neste chat.', `❌ There is already a dungeon running or waiting for players in this chat.`) }, { quoted: m, sinGif: true })
                const ultimaVez = ultimaMazmorraPorGrupo.get(from) || 0
                if (Date.now() - ultimaVez < MAZMORRA_COOLDOWN_MS) {
                    return sendReply(sock, from, { text: tr(lang, `⏳ Hay que esperar *${clockString(MAZMORRA_COOLDOWN_MS - (Date.now() - ultimaVez))}* antes de abrir otra mazmorra.`, `⏳ Espere *${clockString(MAZMORRA_COOLDOWN_MS - (Date.now() - ultimaVez))}* antes de abrir outra dungeon.`, `⏳ You have to wait *${clockString(MAZMORRA_COOLDOWN_MS - (Date.now() - ultimaVez))}* before opening another dungeon.`) }, { quoted: m, sinGif: true })
                }
                const user = getUsuario(sender)
                mazmorrasActivas.set(from, {
                    estado: 'esperando', participantes: [sender],
                    hpJugadores: { [sender]: user.maxHp }, caidos: new Set(),
                    nivel: 0, monstruoHp: 0, monstruoHpMax: 0, monstruoNombre: '', timestamp: Date.now(),
                    lang
                })
                setTimeout(() => iniciarMazmorra(from), MAZMORRA_JOIN_MS)
                await sendReply(sock, from, { text: tr(lang, `🌀 *¡Se abrió una mazmorra!* 🌀\n\n@${sender.split('@')[0]} inicia la expedición (máx. ${maxJugadoresMazmorra()} jugadores${eventoAmigoActivo() ? ' — ¡ampliado por el evento Día del Amigo!' : ''}).\nUsa *${prefix}join* en los próximos ${MAZMORRA_JOIN_MS / 1000} segundos para sumarte.\n\n5 niveles, monstruos que atacan de vuelta, y buen botín si sobreviven.`, `🌀 *Uma dungeon foi aberta!* 🌀\n\n@${sender.split('@')[0]} inicia a expedição (máx. ${maxJugadoresMazmorra()} jogadores${eventoAmigoActivo() ? ' — ampliado pelo evento Dia do Amigo!' : ''}).\nUse *${prefix}join* nos próximos ${MAZMORRA_JOIN_MS / 1000} segundos para entrar.\n\n5 níveis, monstros que atacam de volta e bom loot se sobreviverem.`, `🌀 *A dungeon opened!* 🌀\n\n@${sender.split('@')[0]} starts the expedition (máx. ${maxJugadoresMazmorra()} players${eventoAmigoActivo() ? ' — ¡ampliado por el evento Día del Amigo!' : ''}).\nUse *${prefix}join* en los próximos ${MAZMORRA_JOIN_MS / 1000} seconds para sumarte.\n\n5 leveles, monsters que atacan de vuelta, y buen loot si sobreviven.`), mentions: [sender] }, { quoted: m, sinGif: true })
            }

            if (command === 'unirme') {
                const dg = mazmorrasActivas.get(from)
                if (!dg || dg.estado !== 'esperando') return sendReply(sock, from, { text: tr(lang, '❌ No hay ninguna mazmorra esperando jugadores ahora mismo.', '❌ Não há dungeon esperando jogadores agora.', `❌ There's no ninguna dungeon esperando players ahour mismo.`) }, { quoted: m })
                if (dg.participantes.includes(sender)) return sendReply(sock, from, { text: tr(lang, '✅ Ya estás en el equipo.', '✅ Você já está no time.', `✅ You're already en el equipo.`) }, { quoted: m })
                if (dg.participantes.length >= maxJugadoresMazmorra()) return sendReply(sock, from, { text: tr(lang, `❌ El equipo ya está completo (máx. ${maxJugadoresMazmorra()}).`, `❌ O time já está completo (máx. ${maxJugadoresMazmorra()}).`, `❌ El equipo ya está completo (máx. ${maxJugadoresMazmorra()}).`) }, { quoted: m })
                const user = getUsuario(sender)
                dg.participantes.push(sender)
                dg.hpJugadores[sender] = user.maxHp
                await sendReply(sock, from, { text: tr(lang, `✅ @${sender.split('@')[0]} se unió a la mazmorra (${dg.participantes.length}/${maxJugadoresMazmorra()}).`, `✅ @${sender.split('@')[0]} entrou na dungeon (${dg.participantes.length}/${maxJugadoresMazmorra()}).`, `✅ @${sender.split('@')[0]} joined the dungeon (${dg.participantes.length}/${maxJugadoresMazmorra()}).`), mentions: [sender] }, { quoted: m })
            }

            if (command === 'mazmatacar' || command === 'mazmhabilidad') {
                const dg = mazmorrasActivas.get(from)
                if (!dg || dg.estado !== 'jugando') return sendReply(sock, from, { text: tr(lang, `❌ No hay ninguna mazmorra en curso. Usa *${prefix}dungeon* para abrir una.`, `❌ Não há dungeon em andamento. Use *${prefix}dungeon* para abrir.`, `❌ There's no dungeon running. Use *${prefix}dungeon* to open one.`) }, { quoted: m, sinGif: true })
                if (!dg.participantes.includes(sender)) return sendReply(sock, from, { text: tr(lang, '❌ No formás parte de esta mazmorra.', '❌ Você não faz parte desta dungeon.', `❌ You're not part de esta dungeon.`) }, { quoted: m, sinGif: true })
                if (dg.caidos.has(sender)) return sendReply(sock, from, { text: tr(lang, '☠️ Ya caíste en esta mazmorra. Esperá a que termine.', '☠️ Você já caiu nesta dungeon. Espere ela terminar.', '☠️ Ya caíste en esta dungeon. Wait until it ends.') }, { quoted: m, sinGif: true })

                const user = getUsuario(sender)
                let daño, textoAccion
                if (command === 'mazmhabilidad') {
                    const fEquipada = frutaEquipadaObj(user)
                    if (!fEquipada) return sendReply(sock, from, { text: tr(lang, `❌ No tenés ninguna fruta equipada. Usa *${prefix}dungeonattack* o *${prefix}equipfruit*.`, `❌ Você não tem fruta equipada. Use *${prefix}dungeonattack* ou *${prefix}equipfruit*.`, `❌ You don't have any fruit equipped. Use *${prefix}dungeonattack* o *${prefix}equipfruit*.`) }, { quoted: m, sinGif: true })
                    const catalogo = HABILIDADES_FRUTA[fEquipada.nombre]
                    daño = Math.floor(user.stats.int * 1.3 + (catalogo?.habilidad1?.poder || 15))
                    textoAccion = tr(lang, `usó *${catalogo?.habilidad1?.nombre || fEquipada.nombre}* 🍎`, `usou *${catalogo?.habilidad1?.nombre || fEquipada.nombre}* 🍎`, `used *${catalogo?.habilidad1?.nombre || fEquipada.nombre}* 🍎`)
                } else {
                    daño = user.stats.str + (5 + Math.floor(Math.random() * 16))
                    textoAccion = tr(lang, `atacó 👊`, `atacou 👊`, `attacked 👊`)
                }
                daño = Math.max(1, Math.floor(daño * (0.85 + Math.random() * 0.3)))
                dg.monstruoHp = Math.max(0, dg.monstruoHp - daño)
                user.contadorHabilidades['mazmorra'] = (user.contadorHabilidades['mazmorra'] || 0) + 1

                let bloque = tr(lang, `⚔️ @${sender.split('@')[0]} ${textoAccion} a *${dg.monstruoNombre}* por *${daño}* de daño.\n`, `⚔️ @${sender.split('@')[0]} ${textoAccion} *${dg.monstruoNombre}* causando *${daño}* de dano.\n`, `⚔️ @${sender.split('@')[0]} ${textoAccion} a *${dg.monstruoNombre}* por *${daño}* damage.\n`)

                // El monstruo contraataca con probabilidad, a un participante vivo al azar
                const vivos = dg.participantes.filter(j => !dg.caidos.has(j))
                if (dg.monstruoHp > 0 && Math.random() < 0.35 && vivos.length) {
                    const objetivo = vivos[Math.floor(Math.random() * vivos.length)]
                    const dañoMonstruo = Math.floor((8 + dg.nivel * 4) * (0.8 + Math.random() * 0.4))
                    dg.hpJugadores[objetivo] = Math.max(0, (dg.hpJugadores[objetivo] || 0) - dañoMonstruo)
                    bloque += tr(lang, `👹 *${dg.monstruoNombre}* contraataca a @${objetivo.split('@')[0]} por *${dañoMonstruo}*.\n`, `👹 *${dg.monstruoNombre}* contra-ataca @${objetivo.split('@')[0]} causando *${dañoMonstruo}*.\n`, `👹 *${dg.monstruoNombre}* hits back at @${objetivo.split('@')[0]} por *${dañoMonstruo}*.\n`)
                    if (dg.hpJugadores[objetivo] <= 0) {
                        dg.caidos.add(objetivo)
                        bloque += tr(lang, `☠️ @${objetivo.split('@')[0]} cayó en la mazmorra.\n`, `☠️ @${objetivo.split('@')[0]} caiu na dungeon.\n`, `☠️ @${objetivo.split('@')[0]} cayó en la dungeon.\n`)
                    }
                }

                // ¿Todo el equipo cayó?
                if (dg.participantes.every(j => dg.caidos.has(j))) {
                    bloque += tr(lang, `\n💀 Todo el equipo ha caído...`, `\n💀 O time inteiro caiu...`, `\n💀 Todo el equipo ha caído...`)
                    await sendReply(sock, from, { text: bloque, mentions: dg.participantes }, { sinGif: true })
                    return finalizarMazmorra(from, false)
                }

                if (dg.monstruoHp <= 0) {
                    const recompensa = Math.floor(Math.random() * 16) + 15 // 15-30
                    dg.participantes.forEach(jid => {
                        const u = getUsuario(jid)
                        u.coins += recompensa
                        u.lifetimeCoinsEarned += recompensa
                        u.exp += 10
                        u.bounty += 5
                    })
                    guardarEconomia()
                    bloque += `\n✅ *¡Nivel ${dg.nivel} superado!* +${recompensa} monedas, +10 EXP, +5 Bounty para cada uno.\n`

                    if (dg.nivel >= 5) {
                        await sendReply(sock, from, { text: bloque, mentions: dg.participantes }, { sinGif: true })
                        return finalizarMazmorra(from, true)
                    }
                    dg.nivel++
                    const monstruo = spawnMonstruoMazmorra(dg.nivel, dg.participantes.length)
                    dg.monstruoNombre = monstruo.nombre
                    dg.monstruoHp = monstruo.hp
                    dg.monstruoHpMax = monstruo.hpMax
                    bloque += `\n👹 Nivel ${dg.nivel}: *${monstruo.nombre}* — ❤️ HP: ${monstruo.hp}`
                } else {
                    bloque += `\n❤️ HP del monstruo: ${dg.monstruoHp}/${dg.monstruoHpMax}`
                }

                guardarEconomia()
                await sendReply(sock, from, { text: bloque, mentions: dg.participantes }, { sinGif: true })
            }

            // ====================== EASTER EGG: .cazat (typo clásico de .cazar) ======================
            if (command === 'cazat') {
                const nombre = '@' + sender.split('@')[0]
                const escenas = [
`🌫️ Un ruido extraño se escucha entre los arbustos del chat...

🔎 *${nombre}* avanza sigilosamente, arma en mano, listo para cazar...

...y tropieza con su propio dedo meñique, aterrizando de cara contra la tecla *T*.

💥 *¡SE INVOCÓ AL TYPO SALVAJE!*
❤️ HP: 1 (de vergüenza)
⚔️ Ataque: 9999 (autoestima)

*El Typo Salvaje huye entre risas del grupo.* No obtuviste recompensa, pero sí un poco de humildad.

_Comando correcto: .cazar_ 🐺`,

`🐾 Se detectó un cazador confundido...

*${nombre}* sacó el arco, apuntó al monstruo... y le disparó al diccionario.

📖 *¡GOLPE CRÍTICO A LA ORTOGRAFÍA!* -9999 HP a tu credibilidad.

El monstruo real, que estaba a dos metros, te está mirando fijo sin entender nada.

_Es .cazar, sin "t". Andá, todavía estás a tiempo._ 🎯`,

`🧙 *ALERTA DE ARTEFACTO DETECTADA*

Alguien invocó el hechizo prohibido *"cazaT"*, sellado hace generaciones porque no sirve para absolutamente nada.

El Consejo de Wolfric se reúne de emergencia, delibera durante 0.3 segundos, y dictamina: *"Es un typo, mandalo a .cazar."*

Caso cerrado. 🐺⚖️`,

`🎬 *ESCENA: "El Cazador Apurado"*

${nombre} entra corriendo, grita "¡A CAZAT!" con el pecho inflado...

Silencio.

Un grillo de fondo. 🦗

El monstruo se ríe tan fuerte que huye solo, sin necesidad de pelear.

_Fin de la escena. Créditos: .cazar_ 🎥`
                ]
                await sendReply(sock, from, { text: escenas[Math.floor(Math.random() * escenas.length)], mentions: [sender] }, { quoted: m })
                // 1 de cada ~12 veces, remate extra después de la escena
                if (Math.random() < 0.08) {
                    await sleep(delayAleatorio(1, 2))
                    await sendReply(sock, from, { text: tr(lang, '_...en fin. Andá a la Wiki de la Frontera y anotate ese comando en la frente si hace falta._ 😂', '_...enfim. Vai na Wiki da Fronteira e anota esse comando na testa se precisar._ 😂', '_...anyway. Go to the Frontier Wiki and write that command on your forehead if you have to._ 😂') })
                }
                return
            }

            if (command === 'cazar') {
                if (!isGroup) return sendReply(sock, from, { text: tr(lang, '❌ Los monstruos solo aparecen en grupos.', '❌ Os monstros só aparecem em grupos.', '❌ Monsters only show up in groups.') }, { quoted: m, sinGif: true })
                const monstruo = monstruosActivos.get(from)
                if (!monstruo) return sendReply(sock, from, { text: tr(lang, '❌ No hay ningún monstruo por aquí ahora mismo. Esperá a que aparezca uno.', '❌ Não há monstro por aqui agora. Espere um aparecer.', `❌ There's no monster around right now. Wait for one to show up.`) }, { quoted: m, sinGif: true })
                monstruosActivos.delete(from)

                const user = getUsuario(sender)
                const { premio: recompensaCaza, rareza, esRaro, emoji } = tirarRecompensaVariable(MONSTRUO_RECOMPENSA)
                user.coins += recompensaCaza
                user.lifetimeCoinsEarned += recompensaCaza
                user.monstruosCazados++
                user.bounty += 2
                sumarPuntosGuerra(sender, 5)
                guardarEconomia()

                const narrativas = lang === 'pt' ? [
                    `Com um golpe seco, @${sender.split('@')[0]} acaba com ${monstruo.nombre}!`,
                    `@${sender.split('@')[0]} rastreia o sinal e limpa ${monstruo.nombre} da rede.`,
                    `${monstruo.nombre} não viu @${sender.split('@')[0]} chegar.`,
                    `Um disparo certeiro de @${sender.split('@')[0]} e ${monstruo.nombre} vira código lixo.`
                ] : [
                    `¡De un golpe seco, @${sender.split('@')[0]} termina con ${monstruo.nombre}!`,
                    `@${sender.split('@')[0]} rastrea la señal y purga a ${monstruo.nombre} de la red.`,
                    `${monstruo.nombre} nunca vio venir a @${sender.split('@')[0]}.`,
                    `Un disparo certero de @${sender.split('@')[0]} y ${monstruo.nombre} queda reducido a código basura.`
                ]
                const lineaRareza = esRaro
                    ? tr(lang, `\n${emoji} *¡BOTÍN ${rareza.toUpperCase()}!*`, `\n${emoji} *BUTIM ${rareza.toUpperCase()}!*`, `\n${emoji} *LOOT ${rareza.toUpperCase()}!*`)
                    : ''
                const texto = tr(lang, `🗡️ ${narrativas[Math.floor(Math.random() * narrativas.length)]}${lineaRareza}\n\n💰 +$${recompensaCaza} monedas · 💀 +2 Bounty\n🎯 Monstruos cazados: ${user.monstruosCazados}`, `🗡️ ${narrativas[Math.floor(Math.random() * narrativas.length)]}${lineaRareza}\n\n💰 +$${recompensaCaza} moedas · 💀 +2 Bounty\n🎯 Monstros caçados: ${user.monstruosCazados}`, `🗡️ ${narrativas[Math.floor(Math.random() * narrativas.length)]}${lineaRareza}\n\n💰 +$${recompensaCaza} coins · 💀 +2 Bounty\n🎯 Monsters hunted: ${user.monstruosCazados}`)
                await sendReply(sock, from, { text: texto, mentions: [sender] }, { quoted: m, sinGif: true })
            }

            if (command === 'rob') {
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Etiqueta a quién quieres robar. Ej: ${prefix}rob @usuario`, `❌ Etiqueta a quién quieres robar. Ej: ${prefix}rob @usuario`, `❌ Etiqueta a quién quieres robar. Ej: ${prefix}rob @user`) }, { quoted: m })
                const objetivoJid = mentioned[0]
                if (normalizarJid(objetivoJid) === normalizarJid(sender)) return sendReply(sock, from, { text: tr(lang, '❌ No puedes robarte a ti mismo.', '❌ Você não pode roubar a si mesmo.', `❌ You can't rob yourself.`) }, { quoted: m })

                const ladron = getUsuario(sender)
                const victima = getUsuario(objetivoJid)
                const ahora = Date.now()
                const cooldown = 7 * 60 * 1000 // 7 minutos
                if (ahora - ladron.lastRob < cooldown) {
                    const restante = cooldown - (ahora - ladron.lastRob)
                    return sendReply(sock, from, { text: tr(lang, `⏳ Estás escondido de la policía. Vuelve a intentar en *${clockString(restante)}*.`, `⏳ Estás escondido de la policía. Vuelve a intentar en *${clockString(restante)}*.`, `⏳ Estás escondido de la policía. Vuelve a intentar en *${clockString(restante)}*.`) }, { quoted: m })
                }
                if (victima.coins < 20) return sendReply(sock, from, { text: tr(lang, '❌ Esa persona no tiene casi nada que robarle.', '❌ Essa pessoa quase não tem nada para roubar.', '❌ That person barely has anything to steal.') }, { quoted: m })

                ladron.lastRob = ahora

                if (victima.guardiasRobo > 0) {
                    victima.guardiasRobo--
                    guardarEconomia()
                    return sendReply(sock, from, { text: tr(lang, `🛡️ ¡La *Guardia de Seguridad* de @${objetivoJid.split('@')[0]} frustró el robo! (le quedan ${victima.guardiasRobo} usos)`, `🛡️ La *Guardia de Seguridad* de @${objetivoJid.split('@')[0]} frustró el robo! (le quedan ${victima.guardiasRobo} usos)`, `🛡️ La *Guardia de Seguridad* de @${objetivoJid.split('@')[0]} frustró el robo! (le quedan ${victima.guardiasRobo} usos)`), mentions: [objetivoJid] }, { quoted: m })
                }

                const exito = Math.random() < 0.30 // 30% de éxito
                if (exito) {
                    const porcentaje = Math.random() * 0.3 + 0.1 // 10%-40% de lo que tiene
                    const monto = Math.max(10, Math.floor(victima.coins * porcentaje))
                    victima.coins -= monto
                    ladron.coins += monto
                    guardarEconomia()
                    await sendReply(sock, from, { text: tr(lang, `🕵️ *${pushName}* le robó *${monto}* monedas a @${objetivoJid.split('@')[0]}.\n💰 Total: *${ladron.coins}*`, `🕵️ *${pushName}* le robó *${monto}* moedas a @${objetivoJid.split('@')[0]}.\n💰 Total: *${ladron.coins}*`, `🕵️ *${pushName}* stole *${monto}* coins from @${objetivoJid.split('@')[0]}.\n💰 Total: *${ladron.coins}*`), mentions: [sender, objetivoJid] }, { quoted: m })
                } else {
                    const multa = Math.min(ladron.coins, Math.floor(Math.random() * 40) + 10)
                    const bountyPerdido = Math.min(ladron.bounty - 50, Math.floor(Math.random() * 15) + 10)
                    ladron.coins -= multa
                    if (bountyPerdido > 0) ladron.bounty -= bountyPerdido
                    guardarEconomia()
                    await sendReply(sock, from, { text: tr(lang, `🚨 *${pushName}* fue atrapado intentando robar a @${objetivoJid.split('@')[0]}.\n💸 Multa: *${multa}* monedas${bountyPerdido > 0 ? `\n💀 Reputación dañada: -${bountyPerdido} Bounty` : ''}`, `🚨 *${pushName}* foi pego tentando roubar @${objetivoJid.split('@')[0]}.\n💸 Multa: *${multa}* moedas${bountyPerdido > 0 ? `\n💀 Reputação abalada: -${bountyPerdido} Bounty` : ''}`, `🚨 *${pushName}* got caught trying to rob @${objetivoJid.split('@')[0]}.\n💸 Fine: *${multa}* coins${bountyPerdido > 0 ? `\n💀 Reputation hit: -${bountyPerdido} Bounty` : ''}`), mentions: [sender, objetivoJid] }, { quoted: m })
                }
            }

            if (command === 'pay') {
                const mentioned = getMentioned()
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Etiqueta a quién le quieres pagar. Ej: ${prefix}pay @usuario 50`, `❌ Etiqueta a quién le quieres pagar. Ej: ${prefix}pay @usuario 50`, `❌ Tag who you want to pay. Ex: ${prefix}pay @user 50`) }, { quoted: m })
                const monto = parseInt(args.find(a => !a.startsWith('@')) || args[1])
                if (!monto || monto <= 0) return sendReply(sock, from, { text: tr(lang, `❌ Especifica un monto válido. Ej: ${prefix}pay @usuario 50`, `❌ Especifica un monto válido. Ej: ${prefix}pay @usuario 50`, `❌ Especifica un monto válido. Ej: ${prefix}pay @user 50`) }, { quoted: m })

                const destinoJid = mentioned[0]
                if (normalizarJid(destinoJid) === normalizarJid(sender)) return sendReply(sock, from, { text: tr(lang, '❌ No puedes pagarte a ti mismo.', '❌ Você não pode pagar a si mesmo.', `❌ You can't pay yourself.`) }, { quoted: m })

                const pagador = getUsuario(sender)
                if (pagador.coins < monto) return sendReply(sock, from, { text: tr(lang, '❌ No tienes suficientes monedas.', '❌ Você não tem moedas suficientes.', `❌ You don't have enough coins.`) }, { quoted: m })

                const receptor = getUsuario(destinoJid)
                pagador.coins -= monto
                pagador.totalGifted += monto
                receptor.coins += monto
                receptor.lifetimeCoinsEarned += monto
                const nuevosTitulos = revisarTitulosAutomaticos(pagador, sender)
                guardarEconomia()
                let texto = `💸 *${pushName}* le pagó *${monto}* monedas a @${destinoJid.split('@')[0]}.`
                if (nuevosTitulos.length) texto += `\n\n🎖️ *¡Nuevo título desbloqueado!* ${nuevosTitulos.join(', ')}`
                await sendReply(sock, from, { text: texto, mentions: [sender, destinoJid] }, { quoted: m })
            }

            // ====================== WOLFRIC PROTOCOL: SISTEMA DE BOUNTY ======================
            // Arma el ranking migrando cada entrada primero (evita el bug de bounty undefined -> NaN -> orden roto)
            function rankingBounty() {
                return Object.keys(economia)
                    .map(jid => [jid, getUsuario(jid)])
                    .sort((a, b) => (b[1].bounty || 0) - (a[1].bounty || 0))
            }

            if (command === 'evento') {
                const user = getUsuario(sender)
                if (!eventoAmigoActivo()) {
                    return sendReply(sock, from, { text: tr(lang, `📅 No hay ningún evento activo ahora mismo.`, `📅 Não tem ningún evento activo ahora mismo.`, `📅 There's no ningún evento activo ahora mismo.`) }, { quoted: m })
                }
                const restante = clockString(eventoAmigoTiempoRestante())
                let texto = `🤝 *EVENTO: DÍA DEL AMIGO* 🤝\n\n`
                if (user.eventoAmigoReclamado) {
                    texto += `✅ Ya reclamaste tu paquete de regalo. ¡Disfrutá tu fruta *Amigo*!`
                } else {
                    texto += `Jugá *${EVENTO_AMIGO_META}* partidas de *2vs2* o *mazmorra* (sumadas, no hace falta ganar) antes de que termine el evento.\n\n` +
                        `📊 Tu progreso: *${user.eventoAmigoProgreso || 0}/${EVENTO_AMIGO_META}*\n` +
                        `🎁 Premio: fruta exclusiva *Amigo* 🍎, 3x Poción Neón Pequeña, 2x Batería de Iones, +40 EXP, +$500, +60 Bounty.`
                }
                texto += `\n\n⏳ Tiempo restante del evento: *${restante}*`
                await sendReply(sock, from, { text: texto }, { quoted: m })
            }

            if (command === 'bounty') {
                const mentioned = getMentioned()
                const targetJid = mentioned.length ? mentioned[0] : sender
                const targetUser = getUsuario(targetJid)
                const ranking = rankingBounty()
                const posicion = ranking.findIndex(([jid]) => jid === claveEconomia(targetJid)) + 1
                const texto = `💀 *BOUNTY DE ${mentioned.length ? `@${targetJid.split('@')[0]}` : pushName}*\n\n` +
                    `Valor actual: *$${targetUser.bounty}*\n` +
                    `Puesto en el ranking: #${posicion || '?'} de ${ranking.length}\n\n` +
                    `El Bounty sube cada vez que ganás un duelo, cazás un monstruo, o conseguís frutas Míticas/Secretas.\n` +
                    `Cuanto más alto el Bounty de tu rival, más grande es la recompensa por vencerlo (y más te duele perder contra alguien con poco).\nUsa *${prefix}bountytop* para ver el ranking completo.`
                await sendReply(sock, from, { text: texto, mentions: mentioned.length ? [targetJid] : [] }, { quoted: m })
            }

            if (command === 'bountytop') {
                const ranking = rankingBounty().slice(0, 10)
                if (!ranking.length) return sendReply(sock, from, { text: tr(lang, '📊 Todavía no hay nadie en el ranking de Bounty.', '📊 Ainda não há ninguém no ranking de Bounty.', `📊 Nobody's on the Bounty ranking yet.`) }, { quoted: m })
                let texto = `💀 *TOP BOUNTY — WOLFRIC PROTOCOL*\n\nLos objetivos más valiosos de la red. Cazadores, tomen nota.\n\n`
                ranking.forEach(([jid, datos], i) => {
                    texto += `${i + 1}. @${jid.split('@')[0]} — 💀 $${datos.bounty}\n`
                })
                await sendReply(sock, from, { text: texto, mentions: ranking.map(r => r[0]) }, { quoted: m })
            }

            // ====================== EXTRA ======================
            if (command === '8ball') {
                if (!text) return sendReply(sock, from, { text: tr(lang, `❌ Hazme una pregunta. Ej: ${prefix}8ball ¿me va a ir bien hoy?`, `❌ Hazme una pregunta. Ej: ${prefix}8ball me va a ir bien hoy?`, `❌ Hazme una pregunta. Ej: ${prefix}8ball me va a ir bien hoy?`) }, { quoted: m })
                const respuestas = [
                    'Sí, definitivamente 🔮', 'No cuentes con ello ❌', 'Muy probable ✅', 'Pregunta más tarde ⏳',
                    'Las señales apuntan a que sí 👍', 'Difícil de decir 🤔', 'No 🙅', 'Sin duda 💯'
                ]
                const respuesta = respuestas[Math.floor(Math.random() * respuestas.length)]
                await sendReply(sock, from, { text: `🎱 *Pregunta:* ${text}\n*Respuesta:* ${respuesta}` }, { quoted: m })
            }

            if (command === 'rate') {
                const mentioned = getMentioned()
                const target = mentioned.length ? mentioned[0] : sender
                const puntaje = Math.floor(Math.random() * 101)
                await sendReply(sock, from, { text: `⭐ @${target.split('@')[0]} tiene un rating de *${puntaje}/100*`, mentions: [target] }, { quoted: m })
            }

            // Preferencias de sticker por usuario (Wolfric, no packs públicos tipo marketplace)
            const SPREFS_FILE = './sticker_prefs.json'
            const SALBUM_DIR = path.join(process.cwd(), 'sticker_albums')
            if (!globalThis.__wolfricSprefs) {
                try { globalThis.__wolfricSprefs = fs.existsSync(SPREFS_FILE) ? JSON.parse(fs.readFileSync(SPREFS_FILE,'utf8')) : {} } catch (_) { globalThis.__wolfricSprefs = {} }
            }
            const sprefs = globalThis.__wolfricSprefs
            const saveSprefs = () => { try { fs.writeFileSync(SPREFS_FILE, JSON.stringify(sprefs, null, 2)) } catch (_) {} }
            const packDe = (who) => (sprefs[normalizarJid(who)] || {}).pack || botConfig.stickerPack
            const autorDe = (who) => (sprefs[normalizarJid(who)] || {}).author || botConfig.stickerAuthor
            const albumKey = (who) => normalizarJid(who).replace(/[^a-zA-Z0-9._-]/g, '_')
            const albumSafe = (n) => String(n||'').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,20)

            if (command === 'sinfo') {
                return sendReply(sock, from, { text: `${wolfricTitulo('STICKERS','Tus datos','🧩')}\n\n${frontierPanel('AHORA', [
                    `Pack: *${packDe(sender)}*`,
                    `Autor: *${autorDe(sender)}*`,
                    `${prefix}smeta pack | autor`,
                    `${prefix}salbum lista`
                ], '✦')}` }, { quoted: m })
            }
            if (command === 'smeta') {
                const [pk, au] = (text||'').split('|').map(s=>s.trim()).filter(Boolean)
                if (!pk) return sendReply(sock, from, { text: `❌ Uso: ${prefix}smeta MiPack | Yo` }, { quoted: m })
                const id = normalizarJid(sender)
                if (!sprefs[id]) sprefs[id] = {}
                sprefs[id].pack = pk.slice(0,40)
                if (au) sprefs[id].author = au.slice(0,40)
                saveSprefs()
                return sendReply(sock, from, { text: `✅ Pack *${sprefs[id].pack}* · autor *${sprefs[id].author || autorDe(sender)}*` }, { quoted: m })
            }
            if (command === 'sreset') {
                delete sprefs[normalizarJid(sender)]
                saveSprefs()
                return sendReply(sock, from, { text: '✅ Volviste al pack Wolfric.' }, { quoted: m })
            }
            if (command === 'salbum') {
                const sub = (args[0]||'').toLowerCase()
                const nom = albumSafe(args.slice(1).join(' ') || args[1] || '')
                const id = albumKey(sender)
                const root = path.join(SALBUM_DIR, id)
                const idxFile = path.join(root, 'index.json')
                const leer = () => { try { return JSON.parse(fs.readFileSync(idxFile,'utf8')) } catch (_) { return { albums: {} } } }
                const grabar = (d) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(idxFile, JSON.stringify(d,null,2)) }
                if (!sub || sub === 'lista' || sub === 'list') {
                    const d = leer()
                    const names = Object.keys(d.albums||{})
                    if (!names.length) return sendReply(sock, from, { text: `No tenés álbumes.\n${prefix}salbum crear nombre` }, { quoted: m })
                    const lines = names.map(n => `• ${n} (${(d.albums[n]||[]).length})`)
                    return sendReply(sock, from, { text: `🧩 *Tus álbumes*\n${lines.join('\n')}\n\n${prefix}salbum ver nombre` }, { quoted: m })
                }
                if (sub === 'crear' || sub === 'nuevo') {
                    if (!nom) return sendReply(sock, from, { text: `❌ ${prefix}salbum crear memes` }, { quoted: m })
                    const d = leer()
                    if (Object.keys(d.albums).length >= 5) return sendReply(sock, from, { text: 'Máximo 5 álbumes.' }, { quoted: m })
                    if (!d.albums[nom]) d.albums[nom] = []
                    grabar(d)
                    return sendReply(sock, from, { text: `✅ Álbum *${nom}* listo. Respondé un sticker: ${prefix}salbum meter ${nom}` }, { quoted: m })
                }
                if (sub === 'meter' || sub === 'add') {
                    if (!nom) return sendReply(sock, from, { text: `❌ ${prefix}salbum meter memes` }, { quoted: m })
                    const citado = armarMensajeCitado(m)
                    const mediaMessage = m.message.stickerMessage ? m : (citado && citado.message.stickerMessage ? citado : null)
                    if (!mediaMessage) return sendReply(sock, from, { text: '❌ Respondé a un sticker.' }, { quoted: m })
                    const d = leer()
                    if (!d.albums[nom]) d.albums[nom] = []
                    if (d.albums[nom].length >= 8) return sendReply(sock, from, { text: 'Ese álbum ya tiene 8 stickers.' }, { quoted: m })
                    const buf = await downloadMediaMessage(mediaMessage, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
                    const dir = path.join(root, nom)
                    fs.mkdirSync(dir, { recursive: true })
                    const fn = `${Date.now()}.webp`
                    fs.writeFileSync(path.join(dir, fn), buf)
                    d.albums[nom].push(nom + '/' + fn)
                    grabar(d)
                    return sendReply(sock, from, { text: `✅ Guardado en *${nom}* (${d.albums[nom].length}/8)` }, { quoted: m })
                }
                if (sub === 'ver' || sub === 'sacar') {
                    if (!nom) return sendReply(sock, from, { text: `❌ ${prefix}salbum ver memes` }, { quoted: m })
                    const d = leer()
                    const files = d.albums[nom] || []
                    if (!files.length) return sendReply(sock, from, { text: 'Álbum vacío o no existe.' }, { quoted: m })
                    for (const rel of files.slice(0,8)) {
                        const fp = path.join(root, rel)
                        if (!fs.existsSync(fp)) continue
                        const raw = fs.readFileSync(fp)
                        const pack = agregarMetadataSticker(raw, packDe(sender), autorDe(sender))
                        await sock.sendMessage(from, { sticker: pack }, { quoted: m })
                    }
                    return
                }
                if (sub === 'borrar' || sub === 'del') {
                    if (!nom) return sendReply(sock, from, { text: `❌ ${prefix}salbum borrar memes` }, { quoted: m })
                    const d = leer()
                    delete d.albums[nom]
                    grabar(d)
                    try { fs.rmSync(path.join(root, nom), { recursive: true, force: true }) } catch (_) {}
                    return sendReply(sock, from, { text: `✅ Álbum *${nom}* borrado.` }, { quoted: m })
                }
                return sendReply(sock, from, { text: `🧩 ${prefix}salbum crear|meter|ver|lista|borrar` }, { quoted: m })
            }

            // ====================== STICKERS ======================
            if (command === 'sticker' || command === 's') {
                try {
                    let mediaMessage = null
                    if (m.message.imageMessage || m.message.videoMessage) {
                        mediaMessage = m
                    } else {
                        const citado = armarMensajeCitado(m)
                        if (citado && (citado.message.imageMessage || citado.message.videoMessage)) {
                            mediaMessage = citado
                        }
                    }
                    if (!mediaMessage) return sendReply(sock, from, { text: tr(lang, `❌ Envía una imagen/video con *${prefix}sticker* como descripción, o responde a una con ese comando.`, `❌ Envie uma imagem/vídeo com *${prefix}sticker* na descrição, ou responda a uma com esse comando.`, `❌ Send una image/video con *${prefix}sticker* como descripción, o responde a una con ese command.`) }, { quoted: m })

                    const buffer = await downloadMediaMessage(mediaMessage, 'buffer', {}, {
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    })
                    const webpBuffer = await convertirAWebpSticker(buffer)
                    const [pk0, au0] = (text||'').split('|').map(s=>s.trim()).filter(Boolean)
                    const conMetadata = agregarMetadataSticker(webpBuffer, pk0 || packDe(sender), au0 || autorDe(sender))
                    await sock.sendMessage(from, { sticker: conMetadata }, { quoted: m })
                } catch (e) {
                    console.log('Error creando sticker:', e)
                    await sendReply(sock, from, { text: tr(lang, '❌ No pude crear el sticker. Intenta con otra imagen.', '❌ Não consegui criar a figurinha. Tente outra imagem.', `❌ Couldn't make the sticker. Try another image.`) }, { quoted: m })
                }
            }

            // .take <pack>|<autor> — responde a un sticker para volver a empacarlo con otro pack/autor
            if (command === 'take') {
                try {
                    const citado = armarMensajeCitado(m)
                    const mediaMessage = (m.message.stickerMessage) ? m : (citado && citado.message.stickerMessage ? citado : null)
                    if (!mediaMessage) return sendReply(sock, from, { text: tr(lang, `❌ Responde a un sticker con *${prefix}take pack|autor*.`, `❌ Responda a uma figurinha com *${prefix}take pack|autor*.`, `❌ Reply to a sticker with *${prefix}take pack|autor*.`) }, { quoted: m })

                    const [packArg, autorArg] = (text || '').split('|').map(s => s.trim()).filter(Boolean)
                    const buffer = await downloadMediaMessage(mediaMessage, 'buffer', {}, {
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    })
                    const conMetadata = agregarMetadataSticker(buffer, packArg || botConfig.stickerPack, autorArg || botConfig.stickerAuthor)
                    await sock.sendMessage(from, { sticker: conMetadata }, { quoted: m })
                } catch (e) {
                    console.log('Error en take:', e)
                    await sendReply(sock, from, { text: tr(lang, '❌ No pude re-empacar ese sticker.', '❌ Não consegui reempacotar essa figurinha.', `❌ Couldn't re-pack that sticker.`) }, { quoted: m })
                }
            }

            // .setstickerpack / .setstickerauthor (owner) — cambia el pack/autor por defecto
            if (command === 'setstickerpack' && isOwner) {
                if (!text) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}setstickerpack <nombre>`, `❌ Uso: ${prefix}setstickerpack <nombre>`, `❌ Usage: ${prefix}setstickerpack <nombre>`) }, { quoted: m })
                botConfig.stickerPack = text.trim().slice(0, 60)
                guardarBotConfig()
                return sendReply(sock, from, { text: tr(lang, `✅ Pack de stickers ahora es: *${botConfig.stickerPack}*`, `✅ Pack de stickers ahora es: *${botConfig.stickerPack}*`, `✅ Pack de stickers ahora es: *${botConfig.stickerPack}*`) }, { quoted: m })
            }
            if (command === 'setstickerauthor' && isOwner) {
                if (!text) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}setstickerauthor <nombre>`, `❌ Uso: ${prefix}setstickerauthor <nombre>`, `❌ Usage: ${prefix}setstickerauthor <nombre>`) }, { quoted: m })
                botConfig.stickerAuthor = text.trim().slice(0, 60)
                guardarBotConfig()
                return sendReply(sock, from, { text: tr(lang, `✅ Autor de stickers ahora es: *${botConfig.stickerAuthor}*`, `✅ Autor de stickers ahora es: *${botConfig.stickerAuthor}*`, `✅ Autor de stickers ahora es: *${botConfig.stickerAuthor}*`) }, { quoted: m })
            }


            async function bajarImagenDelChat() {
                let mediaMessage = m.message.imageMessage ? m : null
                if (!mediaMessage) {
                    const citado = armarMensajeCitado(m)
                    if (citado && citado.message && citado.message.imageMessage) mediaMessage = citado
                }
                if (!mediaMessage) return null
                return downloadMediaMessage(mediaMessage, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
            }

            if (command === 'getpic' || command === 'pfp') {
                const mentioned = getMentioned()
                const target = mentioned[0] || sender
                try {
                    const url = await sock.profilePictureUrl(target, 'image')
                    if (!url) throw new Error('no pic')
                    const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
                    const buf = Buffer.from(await r.arrayBuffer())
                    await sock.sendMessage(from, { image: buf, caption: `📷 @${target.split('@')[0]}` , mentions: [target] }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: '❌ No pude ver esa foto (privada o sin foto).' }, { quoted: m })
                }
                return
            }
            if (command === 'hd' || command === 'upscale') {
                const buf = await bajarImagenDelChat()
                if (!buf) return sendReply(sock, from, { text: `❌ Mandá o respondé una imagen con ${prefix}hd` }, { quoted: m })
                const tmpIn = path.join(os.tmpdir(), 'hd-in-'+Date.now()+'.jpg')
                const tmpOut = path.join(os.tmpdir(), 'hd-out-'+Date.now()+'.jpg')
                try {
                    fs.writeFileSync(tmpIn, buf)
                    await execFileAsync('ffmpeg', ['-y','-i',tmpIn,'-vf','scale=iw*2:ih*2','-q:v','3',tmpOut], { timeout: 30000 })
                    const out = fs.readFileSync(tmpOut)
                    await sock.sendMessage(from, { image: out, caption: '🖼️ Más grande (no milagro HD).' }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: '❌ No pude agrandar. ¿Tenés ffmpeg?' }, { quoted: m })
                } finally {
                    try { fs.unlinkSync(tmpIn) } catch(_){}
                    try { fs.unlinkSync(tmpOut) } catch(_){}
                }
                return
            }
            if (command === 'tourl') {
                const buf = await bajarImagenDelChat()
                if (!buf) return sendReply(sock, from, { text: `❌ Mandá o respondé una imagen con ${prefix}tourl` }, { quoted: m })
                try {
                    const fd = new FormData()
                    fd.append('reqtype', 'fileupload')
                    fd.append('fileToUpload', new Blob([buf]), 'foto.jpg')
                    const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd, signal: AbortSignal.timeout(20000) })
                    const link = (await r.text()).trim()
                    if (!/^https?:\/\//.test(link)) throw new Error(link.slice(0,80))
                    await sendReply(sock, from, { text: `🔗 ${link}` }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: '❌ No pude subir la imagen ahora.' }, { quoted: m })
                }
                return
            }
            if (command === 'get') {
                const raw = (text||'').trim()
                if (!/^https?:\/\//i.test(raw)) return sendReply(sock, from, { text: `❌ Uso: ${prefix}get https://ejemplo.com` }, { quoted: m })
                try {
                    const u = new URL(raw)
                    if (!['http:','https:'].includes(u.protocol)) throw new Error('proto')
                    const host = u.hostname.toLowerCase()
                    if (host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
                        throw new Error('host')
                    }
                    const r = await fetch(u.toString(), { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'WolfricBot/3' } })
                    const ct = r.headers.get('content-type') || ''
                    let body = await r.text()
                    body = body.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()
                    const title = (body.slice(0,80) || ct)
                    await sendReply(sock, from, { text: `🌐 *${r.status}* ${ct.split(';')[0]}\n${u.hostname}\n\n${body.slice(0,700)}` }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: '❌ No pude leer esa URL.' }, { quoted: m })
                }
                return
            }
            if (command === 'removebg') {
                const buf = await bajarImagenDelChat()
                if (!buf) return sendReply(sock, from, { text: `❌ Mandá o respondé una imagen con ${prefix}removebg` }, { quoted: m })
                const key = process.env.REMOVEBG_API_KEY || ''
                if (!key) return sendReply(sock, from, { text: '❌ Falta REMOVEBG_API_KEY en el entorno. Sin esa clave no saco el fondo.' }, { quoted: m })
                try {
                    const fd = new FormData()
                    fd.append('image_file', new Blob([buf]), 'foto.jpg')
                    fd.append('size', 'auto')
                    const r = await fetch('https://api.remove.bg/v1.0/removebg', { method:'POST', headers: { 'X-Api-Key': key }, body: fd, signal: AbortSignal.timeout(25000) })
                    if (!r.ok) throw new Error(String(r.status))
                    const out = Buffer.from(await r.arrayBuffer())
                    await sock.sendMessage(from, { image: out, caption: '🪄 Fondo sacado' }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: '❌ Remove.bg no pudo ahora.' }, { quoted: m })
                }
                return
            }

            if (command === 'toimg' || command === 'toimage') {
                try {
                    let mediaMessage = null
                    if (m.message.stickerMessage) {
                        mediaMessage = m
                    } else {
                        const citado = armarMensajeCitado(m)
                        if (citado && citado.message.stickerMessage) {
                            mediaMessage = citado
                        }
                    }
                    if (!mediaMessage) return sendReply(sock, from, { text: tr(lang, `❌ Responde a un sticker con *${prefix}toimg*.`, `❌ Responda a uma figurinha com *${prefix}toimg*.`, `❌ Reply to a sticker with *${prefix}toimg*.`) }, { quoted: m })

                    const buffer = await downloadMediaMessage(mediaMessage, 'buffer', {}, {
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    })
                    const pngBuffer = await convertirWebpAImagen(buffer)
                    await sock.sendMessage(from, { image: pngBuffer, caption: tr(lang, '✅ Aquí tienes tu imagen', '✅ Aqui está sua imagem', `✅ Here's your image`) }, { quoted: m })
                } catch (e) {
                    console.log('Error convirtiendo sticker:', e)
                    await sendReply(sock, from, { text: tr(lang, '❌ No pude convertir ese sticker.', '❌ Não consegui converter essa figurinha.', `❌ Couldn't convert that sticker.`) }, { quoted: m })
                }
            }

            // ====================== DESCARGAS (play / ytmp3 / ytmp4) ======================
            if (['play', 'ytmp3', 'ytmp4'].includes(command)) {
                if (!text) {
                    return sendReply(sock, from, {
                        text: tr(lang, `❌ Escribe el nombre o el link.\nEj:\n${prefix}play nombre de la canción\n${prefix}ytmp3 https://youtu.be/xxxx\n${prefix}ytmp4 https://youtu.be/xxxx`, `❌ Escreva o nome ou o link.\nEx:\n${prefix}play nome da música\n${prefix}ytmp3 https://youtu.be/xxxx\n${prefix}ytmp4 https://youtu.be/xxxx`, `❌ Type el name o el link.\nEx:\n${prefix}play name de la canción\n${prefix}ytmp3 https://youtu.be/xxxx\n${prefix}ytmp4 https://youtu.be/xxxx`)
                    }, { quoted: m })
                }

                await sendReply(sock, from, { text: tr(lang, '⏳ Descargando, espera un momento...', '⏳ Baixando, espera um momento...', '⏳ Downloading, hang on...') }, { quoted: m })

                try {
                    const esVideo = command === 'ytmp4'
                    const result = await descargarMediaYoutube(text, esVideo ? 'video' : 'audio')

                    if (!result.buffer || result.buffer.length < 1000) {
                        throw new Error('Archivo vacío o demasiado pequeño')
                    }

                    if (esVideo) {
                        await sock.sendMessage(from, {
                            video: result.buffer,
                            mimetype: 'video/mp4',
                            fileName: 'video.mp4',
                            caption: tr(lang, '✅ Listo', '✅ Pronto', '✅ Done')
                        }, { quoted: m })
                    } else {
                        await sock.sendMessage(from, {
                            audio: result.buffer,
                            mimetype: 'audio/mpeg',
                            fileName: 'audio.mp3',
                            ptt: false
                        }, { quoted: m })
                    }
                } catch (e) {
                    console.log('Error descarga:', e)
                    const det = String(e.message || e).split('\n')[0].slice(0, 160)
                    await sendReply(sock, from, {
                        text: tr(lang, `❌ No pude descargar el video.\n${det}`, `❌ Não consegui baixar o vídeo.\n${det}`, `❌ Couldn't download the video.\n${det}`)
                    }, { quoted: m })
                }
                return
            }

            // ====================== DESCARGAS (tiktok / instagram / facebook) ======================
            if (['tiktok', 'tt', 'ig', 'instagram', 'fb', 'facebook', 'kwai', 'kawai'].includes(command)) {
                const plataforma = ['tiktok', 'tt'].includes(command) ? 'tiktok' : (['ig', 'instagram'].includes(command) ? 'instagram' : (['kwai', 'kawai'].includes(command) ? 'kwai' : 'facebook'))
                if (!text) {
                    return sendReply(sock, from, { text: tr(lang, `❌ Mandá el link.\nEj: ${prefix}${command} https://...`, `❌ Envie o link.\nEx: ${prefix}${command} https://...`, `❌ Send the link.\nEx: ${prefix}${command} https://...`) }, { quoted: m })
                }
                await sendReply(sock, from, { text: tr(lang, '⏳ Descargando, espera un momento...', '⏳ Baixando, espera um momento...', '⏳ Downloading, hang on...') }, { quoted: m })
                try {
                    let result
                    if (plataforma === 'tiktok' && !/^https?:\/\//i.test(text.trim())) {
                        result = await descargarMediaYoutube(text, 'video')
                    } else {
                        result = await descargarVideoRedSocial(text, plataforma)
                    }
                    await sock.sendMessage(from, { video: result.buffer, mimetype: result.mimetype, fileName: result.fileName, caption: tr(lang, '✅ Listo', '✅ Pronto', '✅ Done') }, { quoted: m })
                } catch (e) {
                    console.log('Error descarga red social:', e)
                    const det = String(e.message || e).split('\n')[0].slice(0, 160)
                    await sendReply(sock, from, { text: `❌ ${det}` }, { quoted: m })
                }
                return
            }


            if (command === 'spotify') {
                if (!text) return sendReply(sock, from, { text: `❌ Uso: ${prefix}spotify nombre o link` }, { quoted: m })
                await sendReply(sock, from, { text: '⏳ Buscando audio...' }, { quoted: m })
                try {
                    const result = await descargarSpotifyComoAudio(text)
                    await sock.sendMessage(from, { audio: result.buffer, mimetype: 'audio/mpeg', fileName: 'audio.mp3', ptt: false }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: '❌ No pude sacar el audio. Probá el nombre de la canción.' }, { quoted: m })
                }
                return
            }
            if (command === 'mediafire') {
                if (!text) return sendReply(sock, from, { text: `❌ Uso: ${prefix}mediafire <link>` }, { quoted: m })
                await sendReply(sock, from, { text: '⏳ Bajando (máx 20MB)...' }, { quoted: m })
                try {
                    const result = await descargarMediafire(text)
                    await sock.sendMessage(from, { document: result.buffer, mimetype: result.mimetype, fileName: result.fileName }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: `❌ ${String(e.message||e).slice(0,160)}` }, { quoted: m })
                }
                return
            }

            if (command === 'antipeleas' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                const sub = (args[0] || '').toLowerCase()
                if (sub === 'on' || sub === 'off') {
                    gcfg.antipeleas = sub === 'on'
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: gcfg.antipeleas ? tr(lang, `✅ Anti-peleas activado. Acción: *${gcfg.antipeleasAccion}*${gcfg.antipeleasAccion === 'cerrar' ? ` (${gcfg.antipeleasMinutos} min)` : ''}. No aplica strike real ni baneo a nadie.`, `✅ Anti-brigas ligado. Ação: *${gcfg.antipeleasAccion}*${gcfg.antipeleasAccion === 'cerrar' ? ` (${gcfg.antipeleasMinutos} min)` : ''}. Não aplica strike real nem ban em ninguém.`, `✅ Anti-fight on. Action: *${gcfg.antipeleasAccion}*${gcfg.antipeleasAccion === 'cerrar' ? ` (${gcfg.antipeleasMinutos} min)` : ''}. It does not apply a real strike or ban anyone.`) : tr(lang, '✅ Anti-peleas desactivado.', '✅ Anti-brigas desligado.', '✅ Anti-fight off.') }, { quoted: m })
                }
                if (sub === 'accion') {
                    const accion = (args[1] || '').toLowerCase()
                    if (!['aviso', 'cerrar'].includes(accion)) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}antipeleas accion aviso|cerrar\n\n"aviso" solo etiqueta y avisa. "cerrar" además cierra el grupo (solo admins escriben) un rato, y se reabre solo — necesita que el bot sea admin.`, `❌ Uso: ${prefix}antipeleas accion aviso|cerrar\n\n"aviso" solo etiqueta y avisa. "cerrar" además cierra el grupo (solo admins escriben) un rato, y se reabre solo — necesita que el bot sea admin.`, `❌ Usage: ${prefix}antipeleas accion aviso|cerrar\n\n"aviso" solo etiqueta y avisa. "cerrar" además cierra el grupo (solo admins escriben) un rato, y se reabre solo — necesita que el bot sea admin.`) }, { quoted: m })
                    gcfg.antipeleasAccion = accion
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: tr(lang, `✅ Acción del anti-peleas: *${accion}*.`, `✅ Ação do anti-brigas: *${accion}*.`, `✅ Anti-fight action: *${accion}*.`) }, { quoted: m })
                }
                if (sub === 'duracion') {
                    const minutos = parseInt(args[1])
                    if (!minutos || minutos < 1 || minutos > 60) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}antipeleas duracion <minutos, 1-60>`, `❌ Uso: ${prefix}antipeleas duracion <minutos, 1-60>`, `❌ Usage: ${prefix}antipeleas duracion <minutos, 1-60>`) }, { quoted: m })
                    gcfg.antipeleasMinutos = minutos
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: tr(lang, `✅ El grupo va a quedar cerrado *${minutos} min* cuando se detecte una pelea.`, `✅ O grupo vai ficar fechado *${minutos} min* quando detectar uma briga.`, `✅ The group will stay locked for *${minutos} min* when a fight is detected.`) }, { quoted: m })
                }
                return sendReply(sock, from, { text: tr(lang, `🤝 *Anti-peleas*: ${gcfg.antipeleas ? 'activado ✅' : 'desactivado ❌'}\nAcción: ${gcfg.antipeleasAccion}${gcfg.antipeleasAccion === 'cerrar' ? ` (${gcfg.antipeleasMinutos} min)` : ''}\n\nUso: ${prefix}antipeleas on|off|accion aviso/cerrar|duracion <min>\n\nNunca aplica strike real ni banea a nadie — con "cerrar" solo pausa el chat para todos un rato. Requiere GEMINI_API_KEY.`, `🤝 *Anti-brigas*: ${gcfg.antipeleas ? 'ligado ✅' : 'desligado ❌'}\nAção: ${gcfg.antipeleasAccion}${gcfg.antipeleasAccion === 'cerrar' ? ` (${gcfg.antipeleasMinutos} min)` : ''}\n\nUso: ${prefix}antipeleas on|off|accion aviso/cerrar|duracion <min>\n\nNunca aplica strike real nem bane ninguém — com "cerrar" só pausa o chat pra todo mundo um tempo. Precisa de GEMINI_API_KEY.`, `🤝 *Anti-fight*: ${gcfg.antipeleas ? 'on ✅' : 'off ❌'}\nAction: ${gcfg.antipeleasAccion}${gcfg.antipeleasAccion === 'cerrar' ? ` (${gcfg.antipeleasMinutos} min)` : ''}\n\nUsage: ${prefix}antipeleas on|off|accion aviso/cerrar|duracion <min>\n\nIt never applies a real strike or bans anyone — "cerrar" just pauses chat for everyone for a bit. Needs GEMINI_API_KEY.`) }, { quoted: m })
            }

            // ====================== ANTIDELETE (transparente: repostea en el mismo grupo) ======================
            if (command === 'antidelete' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                const sub = (args[0] || '').toLowerCase()
                if (sub === 'on' || sub === 'off') {
                    gcfg.antidelete = sub === 'on'
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: gcfg.antidelete
                        ? tr(lang, '✅ Antidelete activado. A partir de ahora, si alguien borra un mensaje en este grupo, el bot lo va a repostear acá mismo (visible para todos, no en privado).', '✅ Antidelete ligado. A partir de agora, se alguém apagar uma mensagem neste grupo, o bot vai repostar aqui mesmo (visível para todos, não em privado).', '✅ Antidelete on. From now on, if someone deletes a message in this group, the bot will repost it right here (visible to everyone, not in private).')
                        : tr(lang, '✅ Antidelete desactivado.', '✅ Antidelete desligado.', '✅ Antidelete off.') }, { quoted: m })
                }
                return sendReply(sock, from, { text: tr(lang, `🗑️ *Antidelete*: ${gcfg.antidelete ? 'activado ✅' : 'desactivado ❌'}\n\nUso: ${prefix}antidelete on|off\n\nAviso importante: esto se muestra a TODO el grupo cuando alguien borra algo, no es un espía privado. Avisale a tu grupo que está activo.`, `🗑️ *Antidelete*: ${gcfg.antidelete ? 'ligado ✅' : 'desligado ❌'}\n\nUso: ${prefix}antidelete on|off\n\nAviso importante: isso é mostrado para TODO o grupo quando alguém apaga algo, não é um espião privado. Avise seu grupo que está ativo.`, `🗑️ *Antidelete*: ${gcfg.antidelete ? 'on ✅' : 'off ❌'}\n\nUsage: ${prefix}antidelete on|off\n\nImportant note: this is shown to the WHOLE group when someone deletes something, it's not a private spy. Let your group know it's active.`) }, { quoted: m })
            }

            // ====================== VIEWONCE (transparente: revela al instante para todo el grupo) ======================
            if (command === 'viewonce' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                const sub = (args[0] || '').toLowerCase()
                if (sub === 'on' || sub === 'off') {
                    gcfg.viewonce = sub === 'on'
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: gcfg.viewonce
                        ? tr(lang, '✅ Viewonce activado. Las fotos/videos "de una vista" que se manden en este grupo se van a mostrar normal para todos, al instante. Avisale a la gente que esto está activo en el grupo.', '✅ Viewonce ligado. As fotos/vídeos "de visualização única" enviados neste grupo vão aparecer normal para todos, na hora. Avise as pessoas que isso está ativo no grupo.', '✅ Viewonce on. View-once photos/videos sent in this group will show up normally for everyone, instantly. Let people know this is active in the group.')
                        : tr(lang, '✅ Viewonce desactivado.', '✅ Viewonce desligado.', '✅ Viewonce off.') }, { quoted: m })
                }
                return sendReply(sock, from, { text: tr(lang, `👁️ *Viewonce*: ${gcfg.viewonce ? 'activado ✅' : 'desactivado ❌'}\n\nUso: ${prefix}viewonce on|off\n\nCon esto activo, ya no existe el "de una vista" en este grupo: se muestra para todos al toque. Es buena práctica avisarle al grupo antes de activarlo.`, `👁️ *Viewonce*: ${gcfg.viewonce ? 'ligado ✅' : 'desligado ❌'}\n\nUso: ${prefix}viewonce on|off\n\nCom isso ativo, o "de visualização única" deixa de existir neste grupo: aparece para todos na hora. É boa prática avisar o grupo antes de ativar.`, `👁️ *Viewonce*: ${gcfg.viewonce ? 'on ✅' : 'off ❌'}\n\nUsage: ${prefix}viewonce on|off\n\nWith this on, "view once" no longer exists in this group: it shows to everyone instantly. It's good practice to tell the group before turning it on.`) }, { quoted: m })
            }

            // ====================== ANTICALL (rechaza llamadas automático) ======================
            if (command === 'anticall') {
                if (!isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo el dueño del bot.', '❌ Apenas o dono do bot.', '❌ Bot owner only.') }, { quoted: m })
                const sub = (args[0] || '').toLowerCase()
                if (sub === 'on' || sub === 'off') {
                    botConfig.anticall = sub === 'on'
                    guardarBotConfig()
                    return sendReply(sock, from, { text: tr(lang, `✅ Anticall ${botConfig.anticall ? 'activado' : 'desactivado'}. ${botConfig.anticall ? 'El bot va a rechazar automáticamente cualquier llamada que le entre.' : ''}`, `✅ Anticall ${botConfig.anticall ? 'ligado' : 'desligado'}. ${botConfig.anticall ? 'O bot vai rejeitar automaticamente qualquer chamada recebida.' : ''}`, `✅ Anticall ${botConfig.anticall ? 'on' : 'off'}. ${botConfig.anticall ? 'The bot will automatically reject any incoming call.' : ''}`) }, { quoted: m })
                }
                return sendReply(sock, from, { text: tr(lang, `📵 *Anticall*: ${botConfig.anticall ? 'activado ✅' : 'desactivado ❌'}\n\nUso: ${prefix}anticall on|off`, `📵 *Anticall*: ${botConfig.anticall ? 'ligado ✅' : 'desligado ❌'}\n\nUso: ${prefix}anticall on|off`, `📵 *Anticall*: ${botConfig.anticall ? 'on ✅' : 'off ❌'}\n\nUsage: ${prefix}anticall on|off`) }, { quoted: m })
            }

            // ====================== ANTI-RAID (entradas masivas sospechosas) ======================
            if (command === 'antiraid' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const gcfg = getGrupoCfg(from)
                const sub = (args[0] || '').toLowerCase()
                if (sub === 'on') {
                    gcfg.antiraid = true
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: tr(lang, `✅ Anti-raid activado. Umbral: *${gcfg.antiraidUmbral} entradas en ${gcfg.antiraidVentanaSeg}s* · Acción: *${gcfg.antiraidAccion}*.`, `✅ Anti-raid activado. Umbral: *${gcfg.antiraidUmbral} entradas en ${gcfg.antiraidVentanaSeg}s* · Acción: *${gcfg.antiraidAccion}*.`, `✅ Anti-raid activado. Umbral: *${gcfg.antiraidUmbral} entradas en ${gcfg.antiraidVentanaSeg}s* · Acción: *${gcfg.antiraidAccion}*.`) }, { quoted: m })
                }
                if (sub === 'off') {
                    gcfg.antiraid = false
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: tr(lang, '✅ Anti-raid desactivado.', '✅ Anti-raid desativado.', '✅ Anti-raid off.') }, { quoted: m })
                }
                if (sub === 'config') {
                    const umbral = parseInt(args[1])
                    const segundos = parseInt(args[2])
                    if (!umbral || !segundos || umbral < 2 || segundos < 5) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}antiraid config <umbral> <segundos>\nEj: ${prefix}antiraid config 5 30 → 5 entradas en 30s dispara la alerta.`, `❌ Uso: ${prefix}antiraid config <umbral> <segundos>\nEj: ${prefix}antiraid config 5 30 → 5 entradas en 30s dispara la alerta.`, `❌ Usage: ${prefix}antiraid config <umbral> <segundos>\nEj: ${prefix}antiraid config 5 30 → 5 entradas en 30s dispara la alerta.`) }, { quoted: m })
                    gcfg.antiraidUmbral = umbral
                    gcfg.antiraidVentanaSeg = segundos
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: tr(lang, `✅ Anti-raid: *${umbral} entradas en ${segundos}s*.`, `✅ Anti-raid: *${umbral} entradas en ${segundos}s*.`, `✅ Anti-raid: *${umbral} entradas en ${segundos}s*.`) }, { quoted: m })
                }
                if (sub === 'accion') {
                    const accion = (args[1] || '').toLowerCase()
                    if (!['alerta', 'cerrar'].includes(accion)) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}antiraid accion alerta|cerrar\n\n"alerta" solo avisa. "cerrar" además revoca el link de invitación (necesito ser admin).`, `❌ Uso: ${prefix}antiraid accion alerta|cerrar\n\n"alerta" solo avisa. "cerrar" además revoca el link de invitación (necesito ser admin).`, `❌ Usage: ${prefix}antiraid accion alerta|cerrar\n\n"alerta" solo avisa. "cerrar" además revoca el link de invitación (necesito ser admin).`) }, { quoted: m })
                    gcfg.antiraidAccion = accion
                    guardarGruposConfig()
                    return sendReply(sock, from, { text: tr(lang, `✅ Acción del anti-raid: *${accion}*.`, `✅ Acción del anti-raid: *${accion}*.`, `✅ Acción del anti-raid: *${accion}*.`) }, { quoted: m })
                }
                return sendReply(sock, from, { text: tr(lang, `🚨 *Anti-raid*: ${gcfg.antiraid ? 'activado ✅' : 'desactivado ❌'}\nUmbral: ${gcfg.antiraidUmbral} entradas en ${gcfg.antiraidVentanaSeg}s\nAcción: ${gcfg.antiraidAccion}\n\nUso: ${prefix}antiraid on|off|config <n> <seg>|accion alerta|cerrar`, `🚨 *Anti-raid*: ${gcfg.antiraid ? 'activado ✅' : 'desactivado ❌'}\nUmbral: ${gcfg.antiraidUmbral} entradas en ${gcfg.antiraidVentanaSeg}s\nAcción: ${gcfg.antiraidAccion}\n\nUso: ${prefix}antiraid on|off|config <n> <seg>|accion alerta|cerrar`, `🚨 *Anti-raid*: ${gcfg.antiraid ? 'activado ✅' : 'desactivado ❌'}\nUmbral: ${gcfg.antiraidUmbral} entradas en ${gcfg.antiraidVentanaSeg}s\nAcción: ${gcfg.antiraidAccion}\n\nUsage: ${prefix}antiraid on|off|config <n> <seg>|accion alerta|cerrar`) }, { quoted: m })
            }

            // ====================== APAGAR/PRENDER COMANDOS PUNTUALES POR GRUPO ======================
            if ((command === 'desactivar' || command === 'activar') && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const objetivo = (args[0] || '').toLowerCase().replace(new RegExp(`^\\${prefix}`), '')
                if (!objetivo) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}${command} <comando o categoría>\nCategorías: ${Object.keys(CATEGORIAS_COMANDOS).join(', ')}`, `❌ Uso: ${prefix}${command} <comando o categoría>\nCategorías: ${Object.keys(CATEGORIAS_COMANDOS).join(', ')}`, `❌ Usage: ${prefix}${command} <comando o categoría>\nCategorías: ${Object.keys(CATEGORIAS_COMANDOS).join(', ')}`) }, { quoted: m })
                const lista = CATEGORIAS_COMANDOS[objetivo] || [objetivo]
                const gcfg = getGrupoCfg(from)
                if (command === 'desactivar') {
                    for (const c of lista) if (!gcfg.comandosDesactivados.includes(c)) gcfg.comandosDesactivados.push(c)
                } else {
                    gcfg.comandosDesactivados = gcfg.comandosDesactivados.filter(c => !lista.includes(c))
                }
                guardarGruposConfig()
                return sendReply(sock, from, { text: `${command === 'desactivar' ? '🚫 Desactivado' : '✅ Reactivado'} en este grupo: *${lista.join(', ')}*` }, { quoted: m })
            }
            if (command === 'desactivados' && isGroup) {
                const gcfg = getGrupoCfg(from)
                if (!gcfg.comandosDesactivados.length) return sendReply(sock, from, { text: tr(lang, '✅ No hay comandos desactivados en este grupo.', '✅ Não há comandos desativados neste grupo.', '✅ No commands are disabled in this group.') }, { quoted: m })
                return sendReply(sock, from, { text: `🚫 *Desactivados en este grupo:*\n${gcfg.comandosDesactivados.map(c => `${prefix}${c}`).join(', ')}` }, { quoted: m })
            }

            // ====================== IA (Gemini) ======================
            if (command === 'ia' || command === 'gemini') {
                if (!text) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}ia <pregunta>`, `❌ Uso: ${prefix}ia <pregunta>`, `❌ Usage: ${prefix}ia <pregunta>`) }, { quoted: m })
                const ultimaTs = ultimaConsultaIA.get(sender) || 0
                if (Date.now() - ultimaTs < 8000) return sendReply(sock, from, { text: tr(lang, '⏳ Esperá unos segundos entre consultas.', '⏳ Espere alguns segundos entre consultas.', '⏳ Wait a few seconds between queries.') }, { quoted: m })
                ultimaConsultaIA.set(sender, Date.now())
                try {
                    const respuesta = await preguntarGemini(text, { systemPrompt: iaSystemPrompt(lang) })
                    await sendReply(sock, from, { text: respuesta }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: `❌ ${String(e.message || e).slice(0, 200)}` }, { quoted: m })
                }
                return
            }

            if (command === 'gptimage') {
                const citado = armarMensajeCitado(m)
                const mensajeConImagen = m.message?.imageMessage ? m : (citado?.message?.imageMessage ? citado : null)
                if (!mensajeConImagen || !text) return sendReply(sock, from, { text: `❌ Respondé a una foto con ${prefix}gptimage qué cambiar` }, { quoted: m })
                await sendReply(sock, from, { text: '🎨 Armando variante...' }, { quoted: m })
                try {
                    const buffer = await downloadMediaMessage(mensajeConImagen, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
                    const mimeType = mensajeConImagen.message.imageMessage.mimetype || 'image/jpeg'
                    const desc = await preguntarGeminiImagen('Describí la imagen en inglés, 1 frase, apta para menores. Luego cómo se vería si: '+text.slice(0,200), buffer.toString('base64'), mimeType, 'Responde solo el prompt de imagen en inglés, sin intro.')
                    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(desc.slice(0,300))}?width=768&height=768&nologo=true`
                    const res = await fetch(url)
                    if (!res.ok) throw new Error('fail')
                    const buf = Buffer.from(await res.arrayBuffer())
                    await sock.sendMessage(from, { image: buf, caption: '🎨 Variante (no es DALL·E; es Wolfric+Pollinations)' }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: '❌ No pude editar esa imagen ahora.' }, { quoted: m })
                }
                return
            }
            if (command === 'suno' || command === 'suno2') {
                if (!text) return sendReply(sock, from, { text: `❌ Uso: ${prefix}suno tema de la canción\n(Wolfric no tiene Suno: te escribe la letra, no el audio.)` }, { quoted: m })
                try {
                    const letra = await preguntarGemini('Escribí una canción corta (3 estrofas + estribillo) apta para menores, en español, sobre: '+text.slice(0,300), { systemPrompt: 'Sos letrista. Nada explícito. Solo la letra.' })
                    await sendReply(sock, from, { text: '🎵 *Letra*\n\n'+letra.slice(0,3500)+'\n\n_No genera audio tipo Suno._' }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: '❌ No pude escribir la letra.' }, { quoted: m })
                }
                return
            }

            if (command === 'iachat' && isGroup) {
                if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                const sub = (args[0] || '').toLowerCase()
                const gcfg = getGrupoCfg(from)
                if (!['on', 'off'].includes(sub)) return sendReply(sock, from, { text: tr(lang, `Uso: ${prefix}iachat on|off\n\nCon "on" el bot responde a TODOS los mensajes del grupo, como un miembro más (no solo a comandos).`, `Uso: ${prefix}iachat on|off\n\nCon "on" el bot responde a TODOS los mensagens del grupo, como un miembro más (no solo a comandos).`, `Usage: ${prefix}iachat on|off\n\nCon "on" el bot responde a TODOS los messages del grupo, como un miembro más (no solo a comandos).`) }, { quoted: m })
                gcfg.iaChat = sub === 'on'
                guardarGruposConfig()
                return sendReply(sock, from, { text: gcfg.iaChat ? '✅ Modo chat IA activado en este grupo.' : '✅ Modo chat IA desactivado.' }, { quoted: m })
            }

            // ====================== IA: DESCRIBIR IMAGEN ======================
            if (command === 'describe' || command === 'describir') {
                const citado = armarMensajeCitado(m)
                const mensajeConImagen = m.message?.imageMessage ? m : (citado?.message?.imageMessage ? citado : null)
                if (!mensajeConImagen) return sendReply(sock, from, { text: tr(lang, `❌ Mandá una imagen (o respondé a una) con *${prefix}describe [pregunta opcional]*.`, `❌ Manda una imagen (o respondé a una) con *${prefix}describe [pregunta opcional]*.`, `❌ Send an image (or reply to one) con *${prefix}describe [pregunta opcional]*.`) }, { quoted: m })
                const ultimaTs = ultimaConsultaIA.get(sender) || 0
                if (Date.now() - ultimaTs < 8000) return sendReply(sock, from, { text: tr(lang, '⏳ Esperá unos segundos entre consultas.', '⏳ Espere alguns segundos entre consultas.', '⏳ Wait a few seconds between queries.') }, { quoted: m })
                ultimaConsultaIA.set(sender, Date.now())
                try {
                    const buffer = await downloadMediaMessage(mensajeConImagen, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
                    const mimeType = mensajeConImagen.message.imageMessage.mimetype || 'image/jpeg'
                    const pregunta = text || 'Describí qué hay en esta imagen, en español, corto (2-4 líneas).'
                    const respuesta = await preguntarGeminiImagen(pregunta, buffer.toString('base64'), mimeType, iaSystemPrompt(lang))
                    await sendReply(sock, from, { text: respuesta }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: `❌ ${String(e.message || e).slice(0, 200)}` }, { quoted: m })
                }
                return
            }

            // ====================== IA: TRADUCTOR ======================
            if (command === 'traducir') {
                const citado = armarMensajeCitado(m)
                const textoCitado = citado?.message?.conversation || citado?.message?.extendedTextMessage?.text || ''
                const partes = (text || '').trim().split(/\s+/)
                const idioma = partes[0]
                const textoAtraducir = textoCitado || partes.slice(1).join(' ')
                if (!idioma || !textoAtraducir) {
                    return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}traducir <idioma> <texto>\nO respondé a un mensaje con: ${prefix}traducir <idioma>\n\nEj: ${prefix}traducir inglés hola como estas`, `❌ Uso: ${prefix}traducir <idioma> <texto>\nO respondé a un mensaje con: ${prefix}traducir <idioma>\n\nEj: ${prefix}traducir inglés hola como estas`, `❌ Usage: ${prefix}traducir <idioma> <texto>\nO respondé a un mensaje con: ${prefix}traducir <idioma>\n\nEj: ${prefix}traducir inglés hola como estas`) }, { quoted: m })
                }
                const ultimaTs = ultimaConsultaIA.get(sender) || 0
                if (Date.now() - ultimaTs < 8000) return sendReply(sock, from, { text: tr(lang, '⏳ Esperá unos segundos entre consultas.', '⏳ Espere alguns segundos entre consultas.', '⏳ Wait a few seconds between queries.') }, { quoted: m })
                ultimaConsultaIA.set(sender, Date.now())
                try {
                    const respuesta = await preguntarGemini(
                        `Traducí el siguiente texto al idioma "${idioma}". Respondé ÚNICAMENTE con la traducción, sin explicaciones ni comillas:\n\n${textoAtraducir}`,
                        { systemPrompt: 'Sos un traductor. Respondés solo con la traducción pedida, nada más.' }
                    )
                    await sendReply(sock, from, { text: `🌐 ${respuesta}` }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: `❌ ${String(e.message || e).slice(0, 200)}` }, { quoted: m })
                }
                return
            }

            // ====================== IA: RESUMEN DEL CHAT ======================
            if (command === 'resumen' && isGroup) {
                const ultimaTs = ultimoResumen.get(from) || 0
                if (Date.now() - ultimaTs < 30000) return sendReply(sock, from, { text: tr(lang, '⏳ Ya se pidió un resumen hace poco, esperá un toque.', '⏳ Já pediram um resumo há pouco, espere um pouco.', '⏳ A summary was just asked for, wait a bit.') }, { quoted: m })
                const log = logMensajesGrupo.get(from) || []
                if (log.length < 5) return sendReply(sock, from, { text: tr(lang, '❌ Todavía no hay suficientes mensajes recientes para resumir.', '❌ Ainda não há mensagens recentes o bastante para resumir.', '❌ Not enough recent messages to summarize yet.') }, { quoted: m })
                const cantidad = Math.min(60, Math.max(5, parseInt(args[0]) || 30))
                const recorte = log.slice(-cantidad)
                ultimoResumen.set(from, Date.now())
                try {
                    const transcripcion = recorte.map(x => `${x.nombre}: ${x.texto}`).join('\n')
                    const respuesta = await preguntarGemini(
                        `Esta es una transcripción de los últimos mensajes de un grupo de WhatsApp:\n\n${transcripcion}\n\nHacé un resumen corto (5-8 líneas, con viñetas) de los temas principales que se hablaron. En español.`,
                        { systemPrompt: 'Resumís charlas de grupo de forma clara y breve, en viñetas, sin inventar nada que no esté en el texto.' }
                    )
                    await sendReply(sock, from, { text: tr(lang, `📋 *Resumen de los últimos ${recorte.length} mensajes*\n\n${respuesta}`, `📋 *Resumo das últimas ${recorte.length} mensagens*\n\n${respuesta}`, `📋 *Summary of the last ${recorte.length} messages*\n\n${respuesta}`) }, { quoted: m })
                } catch (e) {
                    await sendReply(sock, from, { text: `❌ ${String(e.message || e).slice(0, 200)}` }, { quoted: m })
                }
                return
            }

            // ====================== REFERIDOS ======================
            if (command === 'micodigo') {
                const user = getUsuario(sender)
                const codigo = generarCodigoReferido(user)
                guardarEconomia()
                return sendReply(sock, from, { text: tr(lang, `🔗 *Tu código de referido:* ${codigo}\n\nCompartilo. Cuando alguien nuevo lo use con *${prefix}usarcodigo ${codigo}*, ambos reciben una recompensa.\nReferidos exitosos: *${user.referidosExitosos || 0}*`, `🔗 *Seu código de indicação:* ${codigo}\n\nCompartilha. Cuando alguien nuevo lo use con *${prefix}usarcodigo ${codigo}*, os dois ganham uma recompensa.\nIndicações com sucesso: *${user.referidosExitosos || 0}*`, `🔗 *Your referral code:* ${codigo}\n\nShare it. Cuando alguien nuevo lo use con *${prefix}usarcodigo ${codigo}*, you both get a reward.\nSuccessful referrals: *${user.referidosExitosos || 0}*`) }, { quoted: m })
            }
            if (command === 'usarcodigo') {
                const user = getUsuario(sender)
                if (user.referidoPor) return sendReply(sock, from, { text: tr(lang, '❌ Ya usaste un código de referido antes.', '❌ Você já usou um código de indicação antes.', '❌ You already used a referral code.') }, { quoted: m })
                if ((user.comandosUsados || 0) > 15) return sendReply(sock, from, { text: tr(lang, '❌ Este código es solo para cuentas nuevas.', '❌ Este código é só para contas novas.', '❌ This code is only for new accounts.') }, { quoted: m })
                if (!text) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}usarcodigo <código>`, `❌ Uso: ${prefix}usarcodigo <código>`, `❌ Usage: ${prefix}usarcodigo <code>`) }, { quoted: m })
                const referenteJid = buscarPorCodigoReferido(text)
                if (!referenteJid) return sendReply(sock, from, { text: tr(lang, '❌ Ese código no existe.', '❌ Esse código não existe.', `❌ That code doesn't exist.`) }, { quoted: m })
                if (normalizarJid(referenteJid) === normalizarJid(sender)) return sendReply(sock, from, { text: tr(lang, '❌ No podés usar tu propio código.', '❌ Você não pode usar o próprio código.', `❌ You can't use your own code.`) }, { quoted: m })

                const RECOMPENSA_REFERIDO = 500
                user.referidoPor = referenteJid
                user.coins += RECOMPENSA_REFERIDO
                user.lifetimeCoinsEarned += RECOMPENSA_REFERIDO
                const referente = getUsuario(referenteJid)
                referente.coins += RECOMPENSA_REFERIDO
                referente.lifetimeCoinsEarned += RECOMPENSA_REFERIDO
                referente.referidosExitosos = (referente.referidosExitosos || 0) + 1
                guardarEconomia()
                await sendReply(sock, from, { text: tr(lang, `✅ ¡Código aplicado! Vos y quien te invitó ganaron *+$${RECOMPENSA_REFERIDO}*.`, `✅ Código aplicado! Você e quem te convidou ganharam *+$${RECOMPENSA_REFERIDO}*.`, `✅ Code applied! You and whoever invited you got *+$${RECOMPENSA_REFERIDO}*.`) }, { quoted: m })
                return
            }

            // ====================== REPORTES DE USUARIOS ======================
            if (command === 'reportar') {
                const mentioned = getMentioned ? getMentioned() : []
                if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}reportar @usuario motivo`, `❌ Uso: ${prefix}reportar @usuario motivo`, `❌ Usage: ${prefix}reportar @user reason`) }, { quoted: m })
                const ultimoTs = ultimoReportePorUsuario.get(sender) || 0
                if (Date.now() - ultimoTs < 10 * 60 * 1000) return sendReply(sock, from, { text: tr(lang, '⏳ Ya mandaste un reporte hace poco. Esperá unos minutos.', '⏳ Você já enviou um relatório há pouco. Espere alguns minutos.', '⏳ You already sent a report recently. Wait a few minutes.') }, { quoted: m })
                const motivo = text.replace(/@\d+/g, '').trim() || '(sin motivo especificado)'
                ultimoReportePorUsuario.set(sender, Date.now())
                const reporte = { fecha: new Date().toISOString(), reportadoPor: sender, reportado: mentioned[0], motivo, chat: from }
                reportes.push(reporte)
                guardarReportes()
                for (const ownerJid of OWNERS) {
                    try { await sock.sendMessage(ownerJid, { text: tr(lang, `🚨 *Nuevo reporte*\n\nDe: @${sender.split('@')[0]}\nSobre: @${mentioned[0].split('@')[0]}\nMotivo: ${motivo}\nChat: ${from}`, `🚨 *Nuevo reporte*\n\nDe: @${sender.split('@')[0]}\nSobre: @${mentioned[0].split('@')[0]}\nMotivo: ${motivo}\nChat: ${from}`, `🚨 *Nuevo reporte*\n\nDe: @${sender.split('@')[0]}\nSobre: @${mentioned[0].split('@')[0]}\nMotivo: ${motivo}\nChat: ${from}`), mentions: [sender, mentioned[0]] }) } catch (e) {}
                }
                return sendReply(sock, from, { text: tr(lang, '✅ Reporte enviado a los administradores. Gracias por avisar.', '✅ Relatório enviado aos administradores. Obrigado por avisar.', '✅ Report sent to the admins. Thanks for the heads-up.') }, { quoted: m })
            }

            // ====================== MODO TORNEO ======================
            if (command === 'torneo' && !isGroup) {
                return sendReply(sock, from, { text: tr(lang, '❌ El modo torneo es solo para grupos.', '❌ O modo torneio é só para grupos.', '❌ Tournament mode is groups only.') }, { quoted: m })
            }
            if (command === 'torneo' && isGroup) {
                const sub = (args[0] || '').toLowerCase()
                let t = torneosPorGrupo.get(from)

                if (sub === 'crear') {
                    if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                    if (t && t.estado !== 'finalizado') return sendReply(sock, from, { text: tr(lang, '❌ Ya hay un torneo activo en este grupo.', '❌ Já existe um torneio ativo neste grupo.', `❌ There's already an active tournament in this group.`) }, { quoted: m })
                    const premio = args.slice(1).join(' ').trim() || '0'
                    t = { premio, estado: 'inscripcion', inscritos: [], bracket: [], rondaActual: 0 }
                    torneosPorGrupo.set(from, t)
                    guardarTorneos()
                    return sendReply(sock, from, { text: tr(lang, `🏆 *Torneo creado*\nPremio: ${premio}\n\nUnite con *${prefix}torneo unirse*. Cuando esté listo, un admin cierra inscripciones con *${prefix}torneo cerrar*.`, `🏆 *Torneio criado*\nPrêmio: ${premio}\n\nEntra com *${prefix}torneo unirse*. Cuando esté listo, un admin cierra inscripciones con *${prefix}torneo cerrar*.`, `🏆 *Tournament created*\nPrize: ${premio}\n\nJoin with *${prefix}torneo unirse*. When you're ready, an admin closes signups with *${prefix}torneo cerrar*.`) }, { quoted: m })
                }
                if (sub === 'unirse') {
                    if (!t || t.estado !== 'inscripcion') return sendReply(sock, from, { text: tr(lang, '❌ No hay inscripciones abiertas.', '❌ Não há inscrições abertas.', `❌ Signups aren't open.`) }, { quoted: m })
                    if (t.inscritos.includes(sender)) return sendReply(sock, from, { text: tr(lang, '❌ Ya estás inscrito.', '❌ Você já está inscrito.', `❌ You're already signed up.`) }, { quoted: m })
                    t.inscritos.push(sender)
                    guardarTorneos()
                    return sendReply(sock, from, { text: tr(lang, `✅ @${sender.split('@')[0]} se unió al torneo. Inscritos: *${t.inscritos.length}*`, `✅ @${sender.split('@')[0]} entrou no torneio. Inscritos: *${t.inscritos.length}*`, `✅ @${sender.split('@')[0]} joined the tournament. Signed up: *${t.inscritos.length}*`), mentions: [sender] }, { quoted: m })
                }
                if (sub === 'cerrar') {
                    if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                    if (!t || t.estado !== 'inscripcion') return sendReply(sock, from, { text: tr(lang, '❌ No hay inscripciones abiertas.', '❌ Não há inscrições abertas.', `❌ Signups aren't open.`) }, { quoted: m })
                    if (t.inscritos.length < 2) return sendReply(sock, from, { text: tr(lang, '❌ Se necesitan al menos 2 inscritos.', '❌ Precisa de pelo menos 2 inscritos.', '❌ Need at least 2 signups.') }, { quoted: m })
                    t.estado = 'en_curso'
                    t.rondaActual = 1
                    t.bracket = [torneoGenerarRonda(t.inscritos)]
                    guardarTorneos()
                    return sendReply(sock, from, { text: torneoTextoRonda(t.bracket[0], 1) + `\n\nCuando termine cada duelo, un admin usa *${prefix}torneo reportar @ganador* para avanzar.`, mentions: t.inscritos }, { quoted: m })
                }
                if (sub === 'reportar') {
                    if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                    if (!t || t.estado !== 'en_curso') return sendReply(sock, from, { text: tr(lang, '❌ No hay torneo en curso.', '❌ Não há torneio em andamento.', `❌ There's no tournament running.`) }, { quoted: m })
                    const mentioned = getMentioned ? getMentioned() : []
                    if (!mentioned.length) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}torneo reportar @ganador`, `❌ Uso: ${prefix}torneo reportar @ganador`, `❌ Usage: ${prefix}torneo reportar @winner`) }, { quoted: m })
                    const ganador = mentioned[0]
                    const ronda = t.bracket[t.bracket.length - 1]
                    const match = ronda.find(x => !x.ganador && (normalizarJid(x.a) === normalizarJid(ganador) || (x.b && normalizarJid(x.b) === normalizarJid(ganador))))
                    if (!match) return sendReply(sock, from, { text: tr(lang, '❌ Ese jugador no tiene un duelo pendiente en la ronda actual.', '❌ Esse jogador não tem duelo pendente nesta rodada.', `❌ That player doesn't have a pending duel this round.`) }, { quoted: m })
                    match.ganador = ganador
                    guardarTorneos()

                    const faltan = ronda.filter(x => !x.ganador)
                    if (faltan.length > 0) {
                        return sendReply(sock, from, { text: tr(lang, `✅ Ganador registrado: @${ganador.split('@')[0]}\n\n${torneoTextoRonda(ronda, t.rondaActual)}`, `✅ Vencedor registrado: @${ganador.split('@')[0]}\n\n${torneoTextoRonda(ronda, t.rondaActual)}`, `✅ Winner recorded: @${ganador.split('@')[0]}\n\n${torneoTextoRonda(ronda, t.rondaActual)}`), mentions: [ganador] }, { quoted: m })
                    }
                    const ganadores = ronda.map(x => x.ganador)
                    if (ganadores.length === 1) {
                        const campeon = ganadores[0]
                        const premioNum = parseInt(t.premio)
                        const uCampeon = getUsuario(campeon)
                        if (premioNum > 0) {
                            uCampeon.coins += premioNum
                            uCampeon.lifetimeCoinsEarned += premioNum
                        }
                        uCampeon.torneosGanados = (uCampeon.torneosGanados || 0) + 1
                        guardarEconomia()
                        t.estado = 'finalizado'
                        guardarTorneos()
                        return sendReply(sock, from, { text: tr(lang, `🏆🏆🏆 *¡TENEMOS CAMPEÓN!* 🏆🏆🏆\n\n@${campeon.split('@')[0]} ganó el torneo.${t.premio && t.premio !== '0' ? `\n🎁 Premio: ${t.premio}` : ''}`, `🏆🏆🏆 *TEMOS CAMPEÃO!* 🏆🏆🏆\n\n@${campeon.split('@')[0]} ganhou o torneio.${t.premio && t.premio !== '0' ? `\n🎁 Prêmio: ${t.premio}` : ''}`, `🏆🏆🏆 *WE HAVE A CHAMPION!* 🏆🏆🏆\n\n@${campeon.split('@')[0]} won the tournament.${t.premio && t.premio !== '0' ? `\n🎁 Prize: ${t.premio}` : ''}`), mentions: [campeon] }, { quoted: m })
                    }
                    t.rondaActual++
                    t.bracket.push(torneoGenerarRonda(ganadores))
                    guardarTorneos()
                    return sendReply(sock, from, { text: tr(lang, `✅ Ronda completa.\n\n${torneoTextoRonda(t.bracket[t.bracket.length - 1], t.rondaActual)}`, `✅ Rodada completa.\n\n${torneoTextoRonda(t.bracket[t.bracket.length - 1], t.rondaActual)}`, `✅ Round complete.\n\n${torneoTextoRonda(t.bracket[t.bracket.length - 1], t.rondaActual)}`), mentions: ganadores }, { quoted: m })
                }
                if (sub === 'estado') {
                    if (!t) return sendReply(sock, from, { text: tr(lang, '📭 No hay torneo en este grupo.', '📭 Não há torneio neste grupo.', `📭 There's no tournament in this group.`) }, { quoted: m })
                    if (t.estado === 'inscripcion') return sendReply(sock, from, { text: tr(lang, `🏆 Inscripciones abiertas. Inscritos: ${t.inscritos.length}\nPremio: ${t.premio}`, `🏆 Inscrições abertas. Inscritos: ${t.inscritos.length}\nPrêmio: ${t.premio}`, `🏆 Signups open. Signed up: ${t.inscritos.length}\nPrize: ${t.premio}`) }, { quoted: m })
                    return sendReply(sock, from, { text: torneoTextoRonda(t.bracket[t.bracket.length - 1], t.rondaActual) }, { quoted: m })
                }
                if (sub === 'cancelar') {
                    if (!isAdmin && !isOwner) return sendReply(sock, from, { text: tr(lang, '❌ Solo admins.', '❌ Apenas admins.', '❌ Admins only.') }, { quoted: m })
                    torneosPorGrupo.delete(from)
                    guardarTorneos()
                    return sendReply(sock, from, { text: tr(lang, '✅ Torneo cancelado.', '✅ Torneio cancelado.', '✅ Tournament canceled.') }, { quoted: m })
                }
                return sendReply(sock, from, { text: tr(lang, `Uso: ${prefix}torneo crear|unirse|cerrar|reportar|estado|cancelar`, `Uso: ${prefix}torneo crear|unirse|cerrar|reportar|estado|cancelar`, `Usage: ${prefix}torneo crear|unirse|cerrar|reportar|estado|cancelar`) }, { quoted: m })
            }

            // ====================== EVENTOS PROGRAMADOS (owner) ======================
            if (command === 'programarevento' && isOwner) {
                // .programarevento <nombre> <YYYY-MM-DD> <YYYY-MM-DD> <xp|drop> <multiplicador>
                const partes = text.trim().split(/\s+/)
                if (partes.length < 5) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}programarevento nombre YYYY-MM-DD YYYY-MM-DD xp|drop multiplicador`, `❌ Uso: ${prefix}programarevento nombre YYYY-MM-DD YYYY-MM-DD xp|drop multiplicador`, `❌ Usage: ${prefix}programarevento nombre YYYY-MM-DD YYYY-MM-DD xp|drop multiplicador`) }, { quoted: m })
                const multiplicador = parseFloat(partes.pop())
                const tipo = partes.pop().toLowerCase()
                const hasta = partes.pop()
                const desde = partes.pop()
                const nombre = partes.join(' ')
                if (!['xp', 'drop'].includes(tipo)) return sendReply(sock, from, { text: tr(lang, '❌ El tipo debe ser xp o drop.', '❌ O tipo deve ser xp ou drop.', '❌ Type must be xp or drop.') }, { quoted: m })
                if (isNaN(Date.parse(desde)) || isNaN(Date.parse(hasta))) return sendReply(sock, from, { text: tr(lang, '❌ Fechas inválidas. Formato: YYYY-MM-DD', '❌ Datas inválidas. Formato: YYYY-MM-DD', '❌ Invalid dates. Format: YYYY-MM-DD') }, { quoted: m })
                if (!multiplicador || multiplicador <= 1) return sendReply(sock, from, { text: tr(lang, '❌ El multiplicador debe ser mayor a 1 (ej: 2 = doble).', '❌ O multiplicador deve ser maior que 1 (ex: 2 = dobro).', '❌ Multiplier must be greater than 1 (ex: 2 = double).') }, { quoted: m })
                eventosProgramados.push({ nombre, desde, hasta, tipo, multiplicador })
                guardarEventosProgramados()
                return sendReply(sock, from, { text: `✅ Evento *${nombre}* programado (${tipo} x${multiplicador}) del ${desde} al ${hasta}.` }, { quoted: m })
            }
            if (command === 'eventosactivos') {
                const activos = eventosActivosAhora()
                if (!activos.length) return sendReply(sock, from, { text: tr(lang, '📭 No hay eventos especiales activos ahora mismo.', '📭 Não há eventos especiais ativos agora.', '📭 No special events are active right now.') }, { quoted: m })
                const texto = activos.map(e => `✨ *${e.nombre}* — ${e.tipo} x${e.multiplicador} (hasta ${e.hasta})`).join('\n')
                return sendReply(sock, from, { text: tr(lang, `🎉 *Eventos activos*\n\n${texto}`, `🎉 *Eventos ativos*\n\n${texto}`, `🎉 *Active events*\n\n${texto}`) }, { quoted: m })
            }

            // ====================== CONFIG: PREFIJO (owner) ======================
            if (command === 'setprefix' && isOwner) {
                const nuevo = (args[0] || '').trim()
                if (!PREFIJOS_PERMITIDOS.includes(nuevo)) {
                    return sendReply(sock, from, { text: tr(lang, `❌ Prefijo inválido. Elegí uno de: ${PREFIJOS_PERMITIDOS.join('  ')}\nUso: ${prefix}setprefix !`, `❌ Prefixo inválido. Escolhe um de: ${PREFIJOS_PERMITIDOS.join('  ')}\nUso: ${prefix}setprefix !`, `❌ Invalid prefix. Pick one of: ${PREFIJOS_PERMITIDOS.join('  ')}\nUsage: ${prefix}setprefix !`) }, { quoted: m })
                }
                prefix = nuevo
                botConfig.prefix = nuevo
                guardarBotConfig()
                return sendReply(sock, from, { text: tr(lang, `✅ Prefijo cambiado a *${nuevo}*. Ejemplo: *${nuevo}menu*\n\n(Los otros 3 símbolos — ${PREFIJOS_PERMITIDOS.filter(p => p !== nuevo).join(' ')} — se siguen reconociendo igual, por las dudas.)`, `✅ Prefixo mudado para *${nuevo}*. Exemplo: *${nuevo}menu*\n\n(Los otros 3 símbolos — ${PREFIJOS_PERMITIDOS.filter(p => p !== nuevo).join(' ')} — continuam valendo igual, por precaução.)`, `✅ Prefix changed to *${nuevo}*. Example: *${nuevo}menu*\n\n(Los otros 3 símbolos — ${PREFIJOS_PERMITIDOS.filter(p => p !== nuevo).join(' ')} — still work the same, just in case.)`) }, { quoted: m })
            }

            // ====================== CONFIG: GRUPO DE AVISOS / RANKING / IMPUESTO (owner) ======================
            if (command === 'setgrupoavisos' && isOwner) {
                if ((text || '').trim().toLowerCase() === 'off') {
                    botConfig.grupoAvisos = null
                    guardarBotConfig()
                    return sendReply(sock, from, { text: tr(lang, '✅ Grupo de avisos desactivado.', '✅ Grupo de avisos desativado.', '✅ Alert group turned off.') }, { quoted: m })
                }
                if (!isGroup) return sendReply(sock, from, { text: tr(lang, `❌ Usalo dentro del grupo que querés usar para avisos, o *${prefix}setgrupoavisos off* para desactivar.`, `❌ Usa dentro do grupo que você quer pra avisos, o *${prefix}setgrupoavisos off* pra desativar.`, `❌ Use it inside the group you want for alerts, o *${prefix}setgrupoavisos off* to turn it off.`) }, { quoted: m })
                botConfig.grupoAvisos = from
                guardarBotConfig()
                return sendReply(sock, from, { text: tr(lang, '✅ Este grupo ahora recibe avisos automáticos (ranking semanal, bosses en otros grupos).', '✅ Este grupo agora recebe avisos automáticos (ranking semanal, bosses em outros grupos).', '✅ This group now gets automatic alerts (weekly ranking, bosses in other groups).') }, { quoted: m })
            }
            if (command === 'setranking' && isOwner) {
                const dia = parseInt(args[0])
                const hora = parseInt(args[1])
                if (isNaN(dia) || dia < 0 || dia > 6 || isNaN(hora) || hora < 0 || hora > 23) {
                    return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}setranking <día 0-6, 0=domingo> <hora 0-23>`, `❌ Uso: ${prefix}setranking <día 0-6, 0=domingo> <hora 0-23>`, `❌ Usage: ${prefix}setranking <day 0-6, 0=Sunday> <hora 0-23>`) }, { quoted: m })
                }
                botConfig.rankingDia = dia
                botConfig.rankingHora = hora
                botConfig.rankingUltimoPost = null
                guardarBotConfig()
                return sendReply(sock, from, { text: tr(lang, `✅ Ranking automático programado: día ${dia} a las ${hora}:00 (requiere *${prefix}setgrupoavisos*).`, `✅ Ranking automático programado: día ${dia} a las ${hora}:00 (requiere *${prefix}setgrupoavisos*).`, `✅ Auto ranking scheduled: day ${dia} at ${hora}:00 (requiere *${prefix}setgrupoavisos*).`) }, { quoted: m })
            }
            if (command === 'setimpuestomercado' && isOwner) {
                const pct = parseFloat(args[0])
                if (isNaN(pct) || pct < 0 || pct > 50) return sendReply(sock, from, { text: tr(lang, `❌ Uso: ${prefix}setimpuestomercado <0-50>`, `❌ Uso: ${prefix}setimpuestomercado <0-50>`, `❌ Usage: ${prefix}setimpuestomercado <0-50>`) }, { quoted: m })
                botConfig.impuestoMercadoPct = pct
                guardarBotConfig()
                return sendReply(sock, from, { text: `✅ Impuesto del mercado de jugadores: *${pct}%*` }, { quoted: m })
            }

            // ====================== COMANDO NO EXISTENTE ======================
            if (command && !COMANDOS_VALIDOS.has(command)) {
                await sendReply(sock, from, { text: tr(lang,
                    `❌ *Comando no reconocido*\n\n"${prefix}${command}" no existe.\n\nUsa *${prefix}menu* para ver las categorías, o *${prefix}help* para el listado completo.`,
                    `❌ *Comando não reconhecido*\n\n"${prefix}${command}" não existe.\n\nUse *${prefix}menu* para ver as categorias, ou *${prefix}help* para a lista completa.`,
                    `❌ *Command not recognized*\n\n"${prefix}${command}" doesn't exist.\n\nUse *${prefix}menu* to see the categories, or *${prefix}help* for the full list.`) }, { quoted: m })
            }

        } catch (err) {
            comandoOk = false
            console.log('Error:', err)
        } finally {
            // ====== REACCIÓN ✅/❌ EN EL MENSAJE ORIGINAL: si el comando existe y no explotó, ✅; si no existe o tiró error, ❌ ======
            if (ctxReact.command && ctxReact.from && ctxReact.m) {
                const ok = comandoOk && COMANDOS_VALIDOS.has(ctxReact.command)
                try { await sock.sendMessage(ctxReact.from, { react: { text: ok ? '✅' : '❌', key: ctxReact.m.key } }) } catch (_) {}
            }
        }
    })
}

startBot()
