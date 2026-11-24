# Escuadrón Cometa — modo en línea (prototipo 0.4)

Batalla aérea para hasta 4 pilotos. No necesita instalar paquetes, solo Node.js.

## Arrancar el servidor

1. Abre **Terminal** y entra a esta carpeta:
   ```
   cd ~/ruta/a/escuadron-cometa-online
   ```
2. Arranca el servidor:
   ```
   node server.js
   ```
3. Abre en tu navegador la dirección que aparece (`http://localhost:8080`), escribe tu nombre y elige **Jugar en línea**.

Para apagarlo: `Ctrl+C` en la Terminal.
Para usar otro puerto: `PORT=3000 node server.js`.

## Jugar con otros

- **Misma red Wi-Fi:** los demás abren la dirección "En tu red (Wi-Fi)" que imprime el servidor (algo como `http://192.168.1.20:8080`). Si macOS pregunta si Node puede aceptar conexiones entrantes, di que sí.
- **Amigos fuera de tu casa:** usa un túnel, por ejemplo Cloudflare:
  ```
  brew install cloudflared
  cloudflared tunnel --url http://localhost:8080
  ```
  Comparte la dirección `https://….trycloudflare.com` que te da.

## Cómo funciona la ronda

- Con 2 pilotos o más arranca una ronda de 3 minutos; gana quien llegue a 10 derribos o lleve más al final.
- Después de cada ronda hay 8 segundos de resultados y empieza otra.
- Si estás solo puedes volar libremente mientras llega alguien.

## Controles

W A S D o flechas: volar · Espacio: disparar · Shift: turbo · Q/E: giro evasivo · Z: loop · X: media vuelta.
En celular aparecen joystick y botones.

## Archivos

- `server.js` — servidor HTTP + WebSocket y lógica de la sala (marcador, tiempo, rondas).
- `public/index.html` — el juego. Funciona solo también (contra bots) si lo abres sin servidor.

## Notas del prototipo

- Cada jugador decide si un disparo le pegó (más simple, sin trampas resueltas todavía).
- Los demás se ven suavizados entre actualizaciones (20 por segundo).
- three.js se carga desde internet, así que cada jugador necesita conexión.

## Publicarlo en Render (gratis)

1. Sube esta carpeta a un repositorio de GitHub (incluye `render.yaml` y `package.json`).
2. En render.com: **New → Blueprint**, elige el repositorio y confirma. Render lee `render.yaml` y crea el servicio gratis.
3. Cuando termine, comparte la dirección `https://escuadron-cometa-xxxx.onrender.com`.

En el plan gratis el servidor se duerme tras 15 minutos sin jugadores; la primera visita después tarda alrededor de un minuto en despertarlo.
