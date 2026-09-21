/*
 * Configuración del visor. Es el único archivo que hace falta editar
 * para agregar, quitar o renombrar variables y capas.
 *
 * Estructura: cada VARIABLE tiene uno o más ESCENARIOS. Cada escenario es una
 * capa visible en el mapa (un GeoTIFF en EPSG:4326). Opcionalmente puede
 * tener dos capas auxiliares ocultas ("minimo" y "maximo"): no se dibujan,
 * pero al hacer clic en una celda se muestran entre paréntesis:
 *   16,33 °C (12,10 – 19,20)
 *
 * Campos de un escenario:
 *   id, etiqueta (texto corto del botón), nombre (texto largo), descripcion
 *   archivo   GeoTIFF visible (ruta dentro de esta carpeta o URL https con CORS)
 *   minimo / maximo   GeoTIFF auxiliares ocultos (opcionales)
 *   paleta    viridis | magma | mako | cividis | hielo | perdida | divergente
 *             (o una lista propia de colores ['#08306b', '#f7fbff'])
 *   dominio   [mín, máx] del rango de colores. Los valores fuera del rango
 *             se pintan con el color extremo y la leyenda lo indica (≤ / ≥).
 *   signo     true para mostrar +/− en los valores (útil en cambios)
 *   unidad, unidadLeyenda, decimales, factor (multiplica los valores, p. ej.
 *   100 para pasar fracción a %), recorte [mín, máx] (limita los valores)
 * Lo que se define en la variable (unidad, decimales, factor) lo heredan sus
 * escenarios, y cada escenario puede sobrescribirlo.
 */
window.VISOR_CONFIG = {
  titulo: 'Capas ráster · Horizon Scanning Antártida',
  subtitulo: 'Elegí una variable y hacé clic sobre el mapa para leer el valor de cada celda.',
  creditoDatos: 'Datos: Bio-ORACLE.',

  // Vista inicial: [oeste, sur, este, norte] en grados.
  vistaInicial: [-100, -78, -20, -25],

  // Mapa base por defecto: oceano | hibrido
  mapaBase: 'oceano',

  variables: [
    {
      id: 'temp',
      nombre: 'Temperatura del agua',
      descripcion: 'Superficie del mar',
      unidad: '°C',
      decimales: 2,
      escenarios: [
        {
          id: 'actual',
          etiqueta: 'Actual',
          nombre: 'Actual (2000–2019)',
          descripcion: 'Promedio del período de línea de base. Entre paréntesis: mínimo – máximo.',
          archivo: 'datos/tempMediaAct.tif',
          minimo: 'datos/tempMinAct.tif',
          maximo: 'datos/tempMaxAct.tif',
          paleta: 'viridis',
          dominio: [-2, 26]
        },
        {
          id: 'cambio',
          etiqueta: 'Cambio a 2100',
          nombre: 'Cambio esperado a 2100 (RCP 8.5)',
          descripcion: 'Escenario RCP 8.5 (2090–2100) menos la línea de base.',
          archivo: 'datos/diferenciaTemp.tif',
          paleta: 'magma',
          dominio: [0, 4],
          signo: true
        }
      ]
    },
    {
      id: 'sal',
      nombre: 'Salinidad',
      descripcion: 'Superficie del mar',
      unidad: 'PSU',
      decimales: 2,
      escenarios: [
        {
          id: 'actual',
          etiqueta: 'Actual',
          nombre: 'Actual (2000–2019)',
          descripcion: 'Promedio del período de línea de base. Entre paréntesis: mínimo – máximo.',
          archivo: 'datos/salMediaAct.tif',
          minimo: 'datos/salMinAct.tif',
          maximo: 'datos/salMaxAct.tif',
          paleta: 'cividis',
          dominio: [32, 36]
        },
        {
          id: 'cambio',
          etiqueta: 'Cambio a 2100',
          nombre: 'Cambio esperado a 2100 (RCP 8.5)',
          descripcion: 'Escenario RCP 8.5 (2090–2100) menos la línea de base.',
          archivo: 'datos/diferenciaSal.tif',
          paleta: 'divergente',
          dominio: [-1, 1],
          signo: true
        }
      ]
    },
    {
      id: 'hielo',
      nombre: 'Cobertura de hielo marino',
      descripcion: 'Fracción de la superficie cubierta por hielo',
      unidad: '%',
      decimales: 1,
      factor: 100, // los GeoTIFF están en fracción (0–1); se muestran en %
      escenarios: [
        {
          id: 'actual',
          etiqueta: 'Actual',
          nombre: 'Actual (2000–2019)',
          descripcion: 'Promedio del período de línea de base. Entre paréntesis: mínimo – máximo.',
          archivo: 'datos/siconcMediaAct.tif',
          minimo: 'datos/siconcMinAct.tif',
          maximo: 'datos/siconcMaxAct.tif',
          paleta: 'hielo',
          dominio: [0, 100],
          recorte: [0, 100]
        },
        {
          id: 'cambio',
          etiqueta: 'Cambio a 2100',
          nombre: 'Cambio esperado a 2100 (RCP 8.5)',
          descripcion: 'Escenario RCP 8.5 (2090–2100) menos la línea de base, en puntos porcentuales.',
          archivo: 'datos/diferenciaSiconc.tif',
          unidad: 'p. p.',
          unidadLeyenda: 'puntos porcentuales (p. p.)',
          paleta: 'perdida',
          dominio: [-40, 0],
          signo: true
        }
      ]
    }
  ]
};
