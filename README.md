# Tab Audio Control

Extensión local de Chrome para controlar de forma independiente el volumen de la pestaña actual.

**Estado actual:** v0.6

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
- Ajuste de cada banda entre -12 dB y +12 dB, en pasos de 1 dB y en tiempo real.
- Presets de fábrica inmutables **Flat**, **Soft V**, **Bass**, **Voice** y **Treble**. Flat está disponible únicamente en el selector; se eliminó el botón redundante.
- **Save preset** guarda una copia de la curva actual; **Rename** cambia su nombre y **Delete** pide confirmación antes de borrarla. Los dos últimos controles solo se habilitan para presets personalizados.
- Selector agrupado en **Factory presets** y **Custom presets**, disponible también con EQ o Audio Processing OFF, sin iniciar captura.
- Indicación automática **Custom** al modificar manualmente cualquier preset o borrar el preset aplicado; borrar conserva la curva. No se guardan cambios automáticamente.
- Biblioteca de presets personalizados común a todas las pestañas, conservada al cerrar el popup y reiniciar Chrome o el equipo mientras se mantengan los datos de la extensión.
- La curva, el preset y el estado ON/OFF del EQ se conservan por pestaña al apagar **Audio processing**.
- Cada reactivación comienza de forma segura con volumen en 100% y Mute OFF.
- EQ OFF y curva plana por defecto para una activación segura.
- Nuevo popup horizontal con ecualizador de siete faders verticales.
- Identidad visual sobria en azul oscuro, rojo moderado y blanco.

## Privacidad y permisos

Todo el procesamiento ocurre localmente. La extensión no lee páginas, historial ni cookies; no graba audio, no usa telemetría y no realiza solicitudes de red.

- `tabCapture`: obtiene el audio de una pestaña solamente después de la activación explícita del usuario.
- `offscreen`: mantiene el motor Web Audio activo fuera del popup.
- `storage`: se utiliza exclusivamente para guardar localmente los presets creados por el usuario mediante `chrome.storage.local`.

Estos son los únicos tres permisos. No utiliza permisos de host ni dependencias externas.
No hay sincronización cloud ni uso de `chrome.storage.sync`.

La única clave persistente es `customPresets`: una lista de `{ id, name, gains }`,
con ID aleatorio local, nombre y siete ganancias en el orden de las bandas.
No se almacenan URLs, títulos, historial, navegación, identificadores de pestañas,
audio, volumen, mute ni estados operativos. Los nombres son texto libre: evita
incluir información personal. Los presets de fábrica permanecen en el código.

Los nombres se recortan, admiten hasta 30 caracteres y no pueden repetir nombres
de fábrica, `Custom` ni otros personalizados (sin distinguir mayúsculas y con
normalización de espacios/Unicode). Se validan estructura, ID y exactamente siete
enteros entre -12 y +12 dB; los registros inválidos se ignoran. Los nombres se
renderizan como texto, incluso `Rock <test>`. El worker serializa escrituras entre
popups, vuelve a leer storage antes de cada operación y muestra errores sin bloquear
volumen ni EQ. Renombrar conserva ID y ganancias; borrar conserva las curvas temporales.

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
4. Activa **Equalizer**, elige un preset, mueve una banda para ver **Custom** y elige **Preset → Flat** para volver la curva a 0 dB.
5. Ajusta el volumen, prueba **Mute** y después **Reset 100%**; ninguno debe borrar el EQ.
6. Repite en otra pestaña para comprobar que conserva volumen y EQ independientes.
7. Desactiva el procesamiento para devolver el audio al control normal de Chrome.

## Prueba de presets v0.6 en Chrome

1. Si ya está instalada, pulsa **Reload** en su tarjeta de `chrome://extensions` y confirma versión **0.6.0**. Abre una pestaña web normal: Audio Processing OFF, 100%, Mute OFF, EQ OFF, Flat.
2. Activa audio y EQ, crea una curva y pulsa **Save preset**. Escribe `Alex V` y confirma **Save**; debe aparecer seleccionado. Elige Flat y vuelve a Alex V: las siete bandas deben recuperarse.
3. Cierra y abre el popup. Luego cierra completamente Chrome y vuelve a abrirlo: Alex V debe seguir en la lista, sin activación automática ni restauración del estado de una pestaña cerrada.
4. Carga Alex V y pulsa **Rename** para llamarlo `Mi V`: conserva valores y selección. Pulsa **Delete**, prueba **Cancel**, y repite confirmando: desaparece de la lista, la curva permanece y el selector indica Custom.
5. Selecciona Soft V: Rename/Delete deshabilitados. Guarda una copia sin cambiar bandas. Prueba nombre vacío, `soft v`, `Custom` y un nombre personalizado repetido con distintas mayúsculas: deben rechazarse sin sobrescribir nada. `Rock <test>` debe mostrarse literalmente.
6. Con un preset personalizado cargado, cambia una banda: indica Custom y el preset guardado sigue intacto. Con EQ OFF, carga otro preset: cambian los faders pero EQ sigue OFF. Reactívalo para escucharlo.
7. Ajusta volumen, Mute y EQ; apaga y reactiva Audio Processing: conserva curva, preset y EQ, pero vuelve a 100% y Mute OFF. Prueba Reset 100% y controles durante operaciones de presets.
8. Usa curvas distintas en dos pestañas: estados independientes y biblioteca compartida. Renombrar actualiza el nombre; borrar un preset aplicado conserva la curva de ambas pestañas. Prueba clics rápidos: no deben duplicarse operaciones.

Pruebas lógicas sin dependencias: `node tests/v0.6.cjs`. Simulan Chrome y Web Audio;
no sustituyen la escucha ni la prueba de persistencia real tras reiniciar Chrome.

## Limitaciones de v0.6

- Requiere Chrome 116 o posterior.
- Chrome no permite capturar páginas internas, la Chrome Web Store y algunas páginas protegidas.
- Los valores superiores a 100% pueden producir clipping según la fuente.
- Los boosts elevados del EQ también pueden producir clipping; reduce las bandas o el volumen master si ocurre.
- La configuración EQ es deliberadamente temporal: vive por pestaña durante la sesión actual y no se restaura después de reiniciar Chrome.
- El volumen master y Mute no se conservan al apagar el procesamiento; cada reactivación vuelve a 100% y Mute OFF por seguridad auditiva.
- No incluye perfiles por sitio ni spectrum analyzer.
