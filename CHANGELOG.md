# Changelog

## 3.1.1 — 2026-09-08

Limpieza y corrección de bugs. No resetea personajes ni economía.

### Código muerto
- Eliminados `menuSimple`, `frontierAyuda` (queda `frontierAyudaMovil`), `frontierTituloAviso` y `frontierNormalizarSalida`
- Sacada la dependencia `jimp` (no se importaba; stickers van por ffmpeg)

### Bugs
- Comandos fuera de `COMANDOS_VALIDOS` ya no mandan "comando no reconocido" ni reaccionan ❌
- Alias `flee` → `huir`
- `.guia` / `.habilidades` llaman `frontierTutorialElegirRuta` y persisten la ruta
- `.whoami` muestra LID `@lid` (es lo que hay que poner en `OWNERS`)
- Typo inglés `islandndhome` → `islandhome`
- Hito de racha 1000 días: $100.000
- `guardarEconomia()` escribe `.tmp` y hace `rename` atómico
- Panel web escucha en `127.0.0.1` (`PANEL_BIND` para cambiarlo)

## 3.1.0

Versión publicada en https://github.com/wolfric19/Wolfric.bot-Whatsapp
3.2.0 público: grupo, sockets, reacciones, stickers/álbum, descargas, IA Gemini, utils (pfp/hd/tourl).
