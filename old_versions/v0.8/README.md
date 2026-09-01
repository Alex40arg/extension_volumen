# Tab Audio Control

Extensión local de Chrome para controlar de forma independiente el volumen de la pestaña actual.

**Estado actual:** v0.8

## Popup compacto v0.8

Vista de aproximadamente **680 × 589 px**, sin scroll horizontal ni vertical en
un área de 680 × 600 px. Header, espacios y paneles compactados; se eliminó la card
inferior redundante de estado de Audio. Se conservan el badge global ON/OFF y los
tres toggles locales. Faders de **144 px** y Spectrum Analyzer siempre visible a
todo el ancho, con **90 px útiles de gráfico** (canvas de 111 px incluyendo labels).

El editor de presets aprovecha el espacio libre inferior de Audio: Save, Rename
y la confirmación de Delete no aumentan la altura del popup. Sus mensajes temporales
aparecen en el espacio central del header. Se mantienen tipografías, selección de
texto en inputs y todas las funciones de audio, EQ, presets y analizador, sin cambios
en DSP, captura, storage ni permisos.

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
- Badge global OFF/ON y mensajes de error visibles cuando corresponde.
- Ecualizador gráfico de 7 bandas (30 Hz, 90 Hz, 300 Hz, 1 kHz, 3 kHz, 8 kHz y 15 kHz), independiente por pestaña.
- Ajuste de cada banda entre -12 dB y +12 dB, en pasos de 1 dB y en tiempo real.
- Presets de fábrica inmutables **Flat**, **Soft V**, **Bass**, **Voice** y **Treble**. Flat está disponible únicamente en el selector; se eliminó el botón redundante.
- **Save preset** se habilita solo tras editar manualmente una banda (**Custom**). Seleccionar o guardar un preset lo deshabilita; borrar un preset sin editar bandas tampoco habilita Save. **Rename** y **Delete** solo se habilitan para presets personalizados; Delete pide confirmación.
- Selector agrupado en **Factory presets** y **Custom presets**, disponible también con EQ o Audio Processing OFF, sin iniciar captura.
- Indicación automática **Custom** al modificar manualmente cualquier preset o borrar el preset aplicado; borrar conserva la curva. No se guardan cambios automáticamente.
- Biblioteca de presets personalizados común a todas las pestañas, conservada al cerrar el popup y reiniciar Chrome o el equipo mientras se mantengan los datos de la extensión.
- La curva, el preset y el estado ON/OFF del EQ se conservan por pestaña al apagar **Audio processing**.
- Cada reactivación comienza de forma segura con volumen en 100% y Mute OFF.
- EQ OFF y curva plana por defecto para una activación segura.
- Popup horizontal compacto con ecualizador de siete faders verticales.
- Identidad visual sobria en azul oscuro, rojo moderado y blanco.
- **Spectrum Analyzer** real con `AnalyserNode`, canvas local y toggle independiente, OFF por defecto. Franja inferior completa, sin necesidad de scroll.
- Selección accidental de texto deshabilitada; los nombres de presets siguen siendo editables, seleccionables y permiten copiar/pegar.

## Spectrum Analyzer

Cadena: **Source → EQ → AnalyserNode → Master Gain → Destination**. El nodo
analiza sin cambiar el sonido y permanece conectado mientras exista la sesión,
incluso con Analyzer OFF. No cambia frecuencias, Q, presets ni rampas de 20 ms.
El espectro es anterior al master: bajar volumen o activar Mute no reduce sus barras.

FFT de **2048**, smoothing **0.8**, escala visual **-90 a -10 dB**, **48 barras**
logarítmicas de **30 Hz a 15 kHz**. Se agrupan picos de `getByteFrequencyData()`;
las barras graves pueden compartir bins por la resolución finita (~23 Hz a 48 kHz).
Es una referencia visual, no un medidor calibrado de nivel absoluto.

El popup solicita directamente al offscreen solo **48 magnitudes**, con un máximo
de **25 consultas/s** (aproximadamente 20–25 FPS según la pantalla y la carga),
una solicitud en vuelo y buffers reutilizados. Dibuja con `requestAnimationFrame`.
No hay temporizador de análisis en el offscreen. Popup cerrado/oculto, Analyzer OFF
o Audio Processing OFF: sin loop gráfico ni consultas nuevas; cualquier respuesta
en vuelo se descarta. Un error de comunicación detiene el loop y permite reintentar
con OFF/ON, sin afectar el audio.

La preferencia del analizador es temporal e independiente por pestaña. Al apagar
Audio Processing se destruye la sesión; al reactivarlo recupera EQ y preferencia
del analizador, siempre con **100% / Mute OFF**. El analizador nunca inicia captura.
Al cerrar la pestaña se elimina su preferencia. No se guardan FFT, magnitudes,
historial ni audio; no se graba audio ni se envía fuera de la extensión.

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

## Prueba de presets en Chrome

1. Si ya está instalada, pulsa **Reload** en su tarjeta de `chrome://extensions` y confirma versión **0.8.0**. Abre una pestaña web normal: Audio Processing OFF, 100%, Mute OFF, EQ OFF, Flat, Analyzer OFF. Confirma que header, ambos paneles y el analizador completo se vean sin scroll, también al abrir Save/Rename/Delete.
2. Activa audio y EQ, crea una curva y pulsa **Save preset**. Escribe `Alex V` y confirma **Save**; debe aparecer seleccionado. Elige Flat y vuelve a Alex V: las siete bandas deben recuperarse.
3. Cierra y abre el popup. Luego cierra completamente Chrome y vuelve a abrirlo: Alex V debe seguir en la lista, sin activación automática ni restauración del estado de una pestaña cerrada.
4. Carga Alex V y pulsa **Rename** para llamarlo `Mi V`: conserva valores y selección. Pulsa **Delete**, prueba **Cancel**, y repite confirmando: desaparece de la lista, la curva permanece y el selector indica Custom.
5. Selecciona Soft V: Save/Rename/Delete deshabilitados. Mueve una banda: Custom y Save habilitado. Guarda: Save vuelve a deshabilitarse, Rename/Delete se habilitan. Tras otra edición prueba nombre vacío, `soft v`, `Custom` y un nombre personalizado repetido con distintas mayúsculas: deben rechazarse sin sobrescribir nada. `Rock <test>` debe mostrarse literalmente.
6. Con un preset personalizado cargado, cambia una banda: indica Custom y el preset guardado sigue intacto. Con EQ OFF, carga otro preset: cambian los faders pero EQ sigue OFF. Reactívalo para escucharlo.
7. Ajusta volumen, Mute y EQ; apaga y reactiva Audio Processing: conserva curva, preset y EQ, pero vuelve a 100% y Mute OFF. Prueba Reset 100% y controles durante operaciones de presets.
8. Usa curvas distintas en dos pestañas: estados independientes y biblioteca compartida. Renombrar actualiza el nombre; borrar un preset aplicado conserva la curva de ambas pestañas. Prueba clics rápidos: no deben duplicarse operaciones.

## Prueba del analizador y selección de texto en Chrome

1. Reproduce música, activa Audio Processing y deja Analyzer OFF: audio normal, gráfico inactivo. Activa Analyzer: barras reales; con silencio deben caer, sin animación inventada.
2. Activa EQ y sube 30 Hz a +8 dB con contenido grave. Observa el aumento relativo y vuelve a Flat. Compara EQ OFF con Analyzer ON/OFF: el sonido debe mantenerse igual.
3. Baja master de 100% a 30% y prueba Mute: cambia la salida, no el espectro pre-master.
4. Alterna Analyzer OFF/ON repetidamente. Cierra/reabre el popup: conserva la preferencia y no acelera la animación. Con el popup cerrado debe continuar el audio sin consultas de espectro.
5. Con Analyzer ON, apaga Audio Processing: gráfico inactivo. Reactiva: 100%, Mute OFF, EQ conservado y analizador ON. Repite en otra pestaña dejando allí Analyzer OFF; cierra una pestaña y comprueba que la otra siga funcionando.
6. Arrastra sobre títulos: no se seleccionan. Edita el nombre de un preset: selecciona una parte, copia, pega y usa Tab/teclado. Todos los controles deben seguir funcionando.

Pruebas lógicas sin dependencias: `node tests/v0.6.cjs` (regresión de presets)
y `node tests/v0.7.cjs` (analizador, estados y ciclo de render). Simulan Chrome y
Web Audio; no sustituyen la escucha, captura real, cierre del popup nativo ni
persistencia real tras reiniciar Chrome. La compactación v0.8 se verificó en un
viewport de 680 × 600 px con OFF, ON, formularios de presets y errores de nombre;
sin ocultar contenido para simular la ausencia de scroll.

## Limitaciones de v0.8

- Requiere Chrome 116 o posterior.
- Chrome no permite capturar páginas internas, la Chrome Web Store y algunas páginas protegidas.
- Los valores superiores a 100% pueden producir clipping según la fuente.
- Los boosts elevados del EQ también pueden producir clipping; reduce las bandas o el volumen master si ocurre.
- La configuración EQ es deliberadamente temporal: vive por pestaña durante la sesión actual y no se restaura después de reiniciar Chrome.
- El volumen master y Mute no se conservan al apagar el procesamiento; cada reactivación vuelve a 100% y Mute OFF por seguridad auditiva.
- No incluye perfiles por sitio, waveform, osciloscopio ni historial de espectro.
