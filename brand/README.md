# Logo de Gitflow

Mismo sistema que los logos de división de Flowless (`insumos/divisions/logos/` en ese repo):
disco con degradado, anillo abierto, el nombre en el arco y el símbolo en blanco.

| Archivo | Para qué |
|---|---|
| `logo/normal.{svg,png}` | El logo: disco con el degradado, anillo, `GITFLOW` en el arco y el símbolo en blanco. Fondos claros. |
| `logo/oscuro.{svg,png}` | Fondos oscuros: disco blanco con la marca en su degradado. |
| `logo/favicon.{svg,png}` | Solo el símbolo sobre el disco, más grande y grueso para leerse a 16 px. Íconos y todo tamaño menor a 80 px. |

- **Símbolo**: un grafo de git (tronco, una rama y sus tres nodos) con el destello de la IA.
- **Degradado** (arriba-izq. → abajo-der.): violeta `#7c3aed → #2e1065`.
- **Arco**: Montserrat SemiBold en trazos, con las medidas de `generar.py` de Flowless (anillo a 0,836·R,
  banda del texto 0,772–0,925·R, tracking 0,32 em, arco máximo ±51°, el anillo se abre 8,8° más allá del texto).
- **Favicon**: el símbolo a 1,30·R con trazo más grueso y sin el destello chico, que a 16 px no se distinguía.

## Regenerar

Con Node, en una carpeta de trabajo: `npm install opentype.js@1.3.4 @resvg/resvg-js@2.6.2`, y luego

```
node generar-logo.js logo
```

Variables opcionales: `WORD` (texto del arco), `C0`/`C1` (colores del degradado) y `MONTSERRAT` (ruta a
`Montserrat-SemiBold.ttf`; por defecto la del repo de Flowless).

## Íconos de la app

`generar-iconos.js` genera desde `logo/` todos los íconos de la app: los PNG de Linux
(`app/static/linux/logos/`), el `.ico` de Windows y el `.icns` de macOS (`app/static/logos/icon-logo.*`) y el
logo de "Acerca de" (`app/static/common/*logo-64x64@2x.png`). Debajo de 80 px usa el favicon (el nombre del
arco no se lee); desde 128 px, el logo normal. Regenerar después de cambiar el logo:

```
node brand/generar-iconos.js
```
