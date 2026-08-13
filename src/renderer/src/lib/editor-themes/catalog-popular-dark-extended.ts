import type { EditorThemeCatalogEntry } from './types'

/** Editor counterparts of POPULAR_DARK_EXTENDED_TERMINAL_THEMES. */
export const POPULAR_DARK_EXTENDED_EDITOR_THEMES = {
  'material-dark': {
    label: 'Material Dark',
    palette: {
      background: '#263238',
      foreground: '#eeffff',
      comment: '#546e7a',
      keyword: '#c792ea',
      string: '#c3e88d',
      function: '#82aaff',
      constant: '#ffcb6b',
      type: '#89ddff',
      variable: '#f07178',
      selection: '#546e7a',
      lineHighlight: '#364248',
      cursor: '#ffcc00',
      gutterForeground: '#546e7a',
      base: 'dark'
    }
  },
  'ayu-dark': {
    label: 'Ayu Dark',
    palette: {
      background: '#0a0e14',
      foreground: '#b3b1ad',
      comment: '#686868',
      keyword: '#ffb454',
      string: '#c2d94c',
      function: '#59c2ff',
      constant: '#f9af4f',
      type: '#95e6cb',
      variable: '#ea6c73',
      selection: '#273747',
      lineHighlight: '#181b20',
      cursor: '#e6b450',
      gutterForeground: '#686868',
      base: 'dark'
    }
  },
  nightfox: {
    label: 'Nightfox',
    palette: {
      background: '#192330',
      foreground: '#cdcecf',
      comment: '#575860',
      keyword: '#9d79d6',
      string: '#81b29a',
      function: '#719cd6',
      constant: '#dbc074',
      type: '#63cdcf',
      variable: '#c94f6d',
      selection: '#2b3b51',
      lineHighlight: '#27313d',
      cursor: '#cdcecf',
      gutterForeground: '#575860',
      base: 'dark'
    }
  },
  kanagawa: {
    label: 'Kanagawa',
    palette: {
      background: '#1f1f28',
      foreground: '#dcd7ba',
      comment: '#727169',
      keyword: '#957fb8',
      string: '#98bb6c',
      function: '#7e9cd8',
      constant: '#e6c384',
      type: '#7aa89f',
      variable: '#c34043',
      selection: '#2d4f67',
      lineHighlight: '#2e2e34',
      cursor: '#c8c093',
      gutterForeground: '#727169',
      base: 'dark'
    }
  },
  'rose-pine': {
    label: 'Rose Pine',
    palette: {
      background: '#191724',
      foreground: '#e0def4',
      comment: '#6e6a86',
      keyword: '#31748f',
      string: '#f6c177',
      function: '#ebbcba',
      constant: '#c4a7e7',
      type: '#9ccfd8',
      variable: '#eb6f92',
      selection: '#403d52',
      lineHighlight: '#292735',
      cursor: '#524f67',
      gutterForeground: '#6e6a86',
      base: 'dark'
    }
  },
  'everforest-dark': {
    label: 'Everforest Dark',
    palette: {
      background: '#2d353b',
      foreground: '#d3c6aa',
      comment: '#697379',
      keyword: '#e67e80',
      string: '#a7c080',
      function: '#7fbbb3',
      constant: '#d699b6',
      type: '#dbbc7f',
      variable: '#83c092',
      selection: '#543a48',
      lineHighlight: '#3a4144',
      cursor: '#d3c6aa',
      gutterForeground: '#697379',
      base: 'dark'
    }
  },
  palenight: {
    label: 'Palenight',
    palette: {
      background: '#292d3e',
      foreground: '#a6accd',
      comment: '#676e95',
      keyword: '#c792ea',
      string: '#c3e88d',
      function: '#82aaff',
      constant: '#ffcb6b',
      type: '#89ddff',
      variable: '#f07178',
      selection: '#434758',
      lineHighlight: '#333749',
      cursor: '#ffcc00',
      gutterForeground: '#676e95',
      base: 'dark'
    }
  },
  'horizon-dark': {
    label: 'Horizon Dark',
    palette: {
      background: '#1c1e26',
      foreground: '#e0e0e0',
      comment: '#6c6f93',
      keyword: '#ee64ac',
      string: '#29d398',
      function: '#26bbd9',
      constant: '#fab795',
      type: '#59e1e3',
      variable: '#e95678',
      selection: '#2e303e',
      lineHighlight: '#2c2e35',
      cursor: '#e95678',
      gutterForeground: '#6c6f93',
      base: 'dark'
    }
  },
  'night-owl': {
    label: 'Night Owl',
    palette: {
      background: '#011627',
      foreground: '#d6deeb',
      comment: '#575656',
      keyword: '#c792ea',
      string: '#addb67',
      function: '#82aaff',
      constant: '#ffeb95',
      type: '#7fdbca',
      variable: '#ef5350',
      selection: '#1d3b53',
      lineHighlight: '#122637',
      cursor: '#80a4c2',
      gutterForeground: '#575656',
      base: 'dark'
    }
  }
} satisfies Record<string, EditorThemeCatalogEntry>
