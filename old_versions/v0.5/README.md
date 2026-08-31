# Tab Audio Control

Extensión local de Chrome para controlar de forma independiente el volumen de la pestaña actual.

**Estado actual:** v0.5

## Funciones

- Activación manual por pestaña; permanece OFF por defecto.
- Volumen independiente de 0% a 200%, en pasos de 5%.
- Reset inmediato a 100% y mute reversible.
- Varias pestañas procesadas al mismo tiempo.
- El audio continúa procesándose al cerrar el popup.
- Limpieza automática al desactivar el control o cerrar la pestaña.
- Manejo claro y seguro de pestañas protegidas o no capturables.
- Recuperación ante fallos de captura y finalización inesperada del stream.
- Cleanup idempotente y protección ante interacciones rápidas.
- Estados OFF, ON, transición y error más claros en el popup.
- Ecualizador gráfico de 7 bandas (30 Hz, 90 Hz, 300 Hz, 1 kHz, 3 kHz, 8 kHz y 15 kHz), independiente por pestaña.
- Ajuste de cada banda entre -12 dB y +12 dB, con actualización en tiempo real y botón **Flat**.
- Presets de fábrica **Flat**, **Soft V**, **Bass**, **Voice** y **Treble**.
- Indicación automática **Custom** al modificar manualmente una curva de fábrica.
- La curva, el preset y el estado ON/OFF del EQ se conservan por pestaña al apagar **Audio processing**.
- Cada reactivación comienza de forma segura con volumen en 100% y Mute OFF.
- EQ OFF y curva plana por defecto para una activación segura.
- Nuevo popup horizontal con ecualizador de siete faders verticales.
- Identidad visual sobria en azul oscuro, rojo moderado y blanco.

## Privacidad y permisos

Todo el procesamiento ocurre localmente. La extensión no lee páginas, historial ni cookies; no graba audio, no usa telemetría y no realiza solicitudes de red.

- `tabCapture`: obtiene el audio de una pestaña solamente después de la activación explícita del usuario.
- `offscreen`: mantiene el motor Web Audio activo fuera del popup.

No utiliza permisos de host ni dependencias externas. v0.5 mantiene exactamente
los permisos mínimos de la versión anterior y no agrega conexiones externas.

## Instalación local

1. Abre `chrome://extensions` en Chrome 116 o posterior.
2. Activa **Developer mode**.
3. Pulsa **Load unpacked**.
4. Selecciona esta carpeta del proyecto.
5. Fija la extensión a la barra de herramientas si deseas acceder a ella rápidamente.

## Uso y prueba rápida

1. Reproduce audio en una pestaña web normal.
2. Abre el popup; debe indicar **OFF** y no cambiar el audio.
3. Activa **Audio processing**; debe comenzar exactamente en 100%.
4. Activa **Equalizer**, elige un preset, mueve una banda para ver **Custom** y usa **Flat** para volver la curva a 0 dB.
5. Ajusta el volumen, prueba **Mute** y después **Reset 100%**; ninguno debe borrar el EQ.
6. Repite en otra pestaña para comprobar que conserva volumen y EQ independientes.
7. Desactiva el procesamiento para devolver el audio al control normal de Chrome.

## Limitaciones de v0.5

- Requiere Chrome 116 o posterior.
- Chrome no permite capturar páginas internas, la Chrome Web Store y algunas páginas protegidas.
- Los valores superiores a 100% pueden producir clipping según la fuente.
- Los boosts elevados del EQ también pueden producir clipping; reduce las bandas o el volumen master si ocurre.
- La configuración EQ es deliberadamente temporal: vive por pestaña durante la sesión actual y no se restaura después de reiniciar Chrome.
- El volumen master y Mute no se conservan al apagar el procesamiento; cada reactivación vuelve a 100% y Mute OFF por seguridad auditiva.
- No incluye presets personalizados guardables, perfiles por sitio ni spectrum analyzer.
