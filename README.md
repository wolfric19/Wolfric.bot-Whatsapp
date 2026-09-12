```
╔═══════════════════════════════════════╗
      𝐖𝐎𝐋𝐅𝐑𝐈𝐂 · 𝐏𝐑𝐎𝐓𝐎𝐂𝐎𝐋  🐺
╚═══════════════════════════════════════╝
```

<p align="center"><i>Un bot de WhatsApp que convierte tu grupo en un mundo RPG.</i></p>

<p align="center">
📢 <b>Canal oficial:</b> https://whatsapp.com/channel/0029VbDSzOv8KMqcStjGog1T
</p>

---

## ❖ 𝑸𝑼𝑬́ 𝑬𝑺 𝑾𝑶𝑳𝑭𝑹𝑰𝑪

╭━━⪩ *𝐃𝐄𝐒𝐂𝐑𝐈𝐏𝐂𝐈𝐎́𝐍* ⪨━━
> ❏ • Bot de WhatsApp tipo **RPG/gacha**, construido sobre [Baileys](https://github.com/WhiskeySockets/Baileys).
> ❏ • Tu grupo se convierte en un mundo con personajes, economía, gremios, duelos, mazmorras cooperativas, gacha de frutas al estilo One Piece, guerra de gremios y mucho más.
> ❏ • Todo jugable escribiendo comandos en el chat, sin salir de WhatsApp.
╰━━─「◈」─━━━━━━━━

---

## ✦ 𝑳𝑶 𝑸𝑼𝑬 𝑰𝑵𝑪𝑳𝑼𝒀𝑬

╭━━⪩ *𝗠𝗨𝗡𝗗𝗢* ⪨━━
> ❏ • Personajes, stats, economía, trabajo, entrenamiento, inventario
> ❏ • Frutas y estilos de combate (gacha tipo One Piece), con ultimates
> ❏ • Duelos PvP 1v1 y 2v2 por turnos
> ❏ • Caza de monstruos, mazmorras cooperativas, bosses de mundo
> ❏ • Gremios y **guerra de gremios** (24h, marcador en vivo)
> ❏ • Racha diaria con hitos y títulos especiales
> ❏ • Mercado entre jugadores, tienda, impuestos
> ❏ • Logros, títulos y rankings
╰━━─「⚔」─━━━━━━━━

╭━━⪩ *𝗘𝗫𝗧𝗥𝗔𝗦* ⪨━━
> ❏ • IA integrada (Google Gemini): chat libre, resúmenes, traducción, descripción de imágenes
> ❏ • Gifs y comandos de interacción entre jugadores
> ❏ • Panel web de administración
> ❏ • Multilenguaje: 🇪🇸 Español · 🇧🇷 Português · 🇺🇸 English
> ❏ • Moderación: anti-raid, anti-peleas con IA, bienvenida/despedida
╰━━─「✧」─━━━━━━━━

---

## ⌁ 𝑹𝑬𝑸𝑼𝑰𝑺𝑰𝑻𝑶𝑺

- Node.js 18 o superior
- Un número de WhatsApp para vincular (recomendado: uno dedicado)
- *(Opcional)* API key gratis de **Google Gemini** — funciones de IA
- *(Opcional)* API key gratis de **GIPHY** — gifs

---

## ⚙ 𝑰𝑵𝑺𝑻𝑨𝑳𝑨𝑪𝑰𝑶́𝑵

```bash
git clone https://github.com/wolfric19/Wolfric.bot-Whatsapp.git
cd Wolfric.bot-Whatsapp
npm install
```

### ➤ Configurar tu owner (obligatorio)

Abrí `index.js`, buscá la constante `OWNERS` cerca del principio, y agregá tu LID de WhatsApp:

```js
const OWNERS = [
    'TU_LID_AQUI@lid',
]
```

> Arrancá el bot una vez, escribile cualquier mensaje, y tu LID va a aparecer en la consola.

### ➤ API keys (opcional)

```bash
export GEMINI_API_KEY=tu_key_de_gemini
export GIPHY_API_KEY=tu_key_de_giphy
```

- Gemini → [aistudio.google.com](https://aistudio.google.com/app/apikey)
- GIPHY → [developers.giphy.com](https://developers.giphy.com) → *Create an App* → *API*

### ➤ Arrancar

```bash
node index.js
```

La primera vez te pide vincular WhatsApp por **QR** o **código** (elegís vos).

---

## 🎮 𝑪𝑶́𝑴𝑶 𝑱𝑼𝑮𝑨𝑹

╭━━⪩ *𝗖𝗢𝗠𝗔𝗡𝗗𝗢𝗦 𝗕𝗔́𝗦𝗜𝗖𝗢𝗦* ⪨━━
> ❏ • `.register` — crea tu personaje (una sola vez)
> ❏ • `.menu` — todas las categorías de comandos
> ❏ • `.daily` — recompensa diaria (con racha)
> ❏ • `.balance` — ver tus monedas
> ❏ • `.cazar` — cazar un monstruo cuando aparece
> ❏ • `.duel @user` — retar a otro jugador
> ❏ • `.guild` — crear o unirte a un gremio
> ❏ • `.guerra` — guerra de gremios
> ❏ • `.idioma` — elegir español, português o english
╰━━─「▸」─━━━━━━━━

Para etiquetar a alguien, mencionalo con `@` en el mismo mensaje. El prefijo (`.`) es configurable por el owner con `.setprefix`.

---

## 🌐 𝑷𝑨𝑵𝑬𝑳 𝑾𝑬𝑩

El bot levanta un panel de administración local (por defecto en `http://127.0.0.1:3000`), con estadísticas, auditoría y control remoto. La clave de acceso se genera sola al arrancar.

Para exponerlo en otra interfaz: `PANEL_BIND=0.0.0.0 PANEL_PORT=3000 node index.js`.

---

## 🔧 𝑨𝑪𝑻𝑼𝑨𝑳𝑰𝒁𝑨𝑪𝑰𝑶́𝑵 3.1.1

Parche de limpieza y bugs sobre 3.1.0 (sin reset de progreso):

- Código muerto removido y dependencia `jimp` que no se usaba
- Comandos válidos que después decían "no existe" (`.rank`, easter eggs, etc.)
- Alias `.flee` → huir; tutorial guarda la ruta en `.guia` / `.habilidades`
- `.whoami` ahora muestra el **LID** (`@lid`) para `OWNERS`
- Guardado atómico de `economia.json`
- Panel web bound a `127.0.0.1` por defecto
- Hito de racha de 1000 días corregido a $100.000

Para actualizar una instancia que ya corre: paramí el bot, reemplazá `index.js`, `panel-web.js` y `package.json`. **No toques** `sesion/`, `economia.json` ni `gremios.json`.

### Qué va al repo (solo código)

```
index.js
panel-web.js
package.json
bot_config.json
menu.jpg
README.md
LEEME.txt
LICENSE.txt
CHANGELOG.md
.gitignore
```

Lo demás lo crea el bot al arrancar (`sesion/`, `economia.json`, `gremios.json`, `backups/`, `panel_key.txt`, configs de grupo) y **no se sube**.

---

## 📜 𝑳𝑰𝑪𝑬𝑵𝑪𝑰𝑨

Podés clonarlo y correr tu propia instancia, pero **no** redistribuirlo, revenderlo, ni publicarlo como propio. Ver [LICENSE.txt](./LICENSE.txt) para el detalle completo.

---

## 📬 𝑪𝑶𝑵𝑻𝑨𝑪𝑻𝑶

```
╭━━⪩ 𝗪𝗢𝗟𝗙𝗥𝗜𝗖 𝗣𝗥𝗢𝗧𝗢𝗖𝗢𝗟 ⪨━━
> 📢 Canal: https://whatsapp.com/channel/0029VbDSzOv8KMqcStjGog1T
> ✉️ Email: salva7dorito@gmail.com
╰━━─「🐺」─━━━━━━━━
```

<p align="center">🐺 <b>𝐖𝐎𝐋𝐅𝐑𝐈𝐂 𝐏𝐑𝐎𝐓𝐎𝐂𝐎𝐋</b> — © Todos los derechos reservados</p>
