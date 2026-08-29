# Tab Audio Control

Extensión local de Chrome para controlar de forma independiente el volumen de la pestaña actual.

**Estado actual:** v0.2

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

## Privacidad y permisos

Todo el procesamiento ocurre localmente. La extensión no lee páginas, historial ni cookies; no graba audio, no usa telemetría y no realiza solicitudes de red.

- `tabCapture`: obtiene el audio de una pestaña solamente después de la activación explícita del usuario.
- `offscreen`: mantiene el motor Web Audio activo fuera del popup.

No utiliza permisos de host ni dependencias externas. v0.2 mantiene exactamente
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
4. Ajusta el volumen, prueba **Mute** y después **Reset 100%**.
5. Repite en otra pestaña para comprobar que conserva un volumen independiente.
6. Desactiva el procesamiento para devolver el audio al control normal de Chrome.

## Limitaciones de v0.2

- Requiere Chrome 116 o posterior.
- Chrome no permite capturar páginas internas, la Chrome Web Store y algunas páginas protegidas.
- Los valores superiores a 100% pueden producir clipping según la fuente.
- El estado es deliberadamente temporal: no se restaura después de reiniciar Chrome.
- No incluye ecualizador, perfiles por sitio ni visualizador.
