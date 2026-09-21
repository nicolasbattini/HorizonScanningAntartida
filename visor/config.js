/*
 * Configuración del visor. Es el único archivo que hace falta editar
 * para agregar, quitar o renombrar capas.
 *
 * Cada capa necesita un GeoTIFF en coordenadas geográficas (EPSG:4326).
 * "archivo" puede ser una ruta dentro de esta carpeta (datos/xxx.tif) o
 * una URL https completa, siempre que ese servidor permita CORS.
 *
 * Paletas disponibles: viridis, magma, mako, cividis
 * (o una lista propia de colores, p. ej. ['#08306b', '#f7fbff']).
 * "dominio" fija el rango de colores; si se omite, se usa el mínimo y
 * máximo de la capa.
 */
window.VISOR_CONFIG = {
  titulo: 'Capas ráster · Horizon Scanning Antártida',
  subtitulo: 'Hacé clic sobre el mapa para leer el valor de cada celda.',
  creditoDatos: 'Datos: Bio-ORACLE (temperatura del agua en superficie).',

  // Vista inicial: [oeste, sur, este, norte] en grados.
  vistaInicial: [-100, -78, -20, -25],

  // Mapa base por defecto: claro | oceano | satelite | oscuro
  mapaBase: 'claro',

  capas: [
    {
      id: 'media',
      nombre: 'Temperatura media actual',
      descripcion: 'Superficie del mar, promedio 2000–2019 (línea de base).',
      archivo: 'datos/tempMediaAct.tif',
      unidad: '°C',
      paleta: 'viridis',
      decimales: 2
    },
    {
      id: 'cambio',
      nombre: 'Cambio esperado de temperatura media',
      descripcion: 'Escenario SSP5-8.5 (2090–2100) menos la línea de base.',
      archivo: 'datos/diferenciaTemp.tif',
      unidad: '°C',
      paleta: 'magma',
      decimales: 2
    },
    {
      id: 'rango',
      nombre: 'Rango anual de temperatura actual',
      descripcion: 'Máxima menos mínima, promedio 2000–2019.',
      archivo: 'datos/rangoTempAct.tif',
      unidad: '°C',
      paleta: 'mako',
      decimales: 2
    }
  ]
};
