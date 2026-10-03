import { createLucideIcon, type IconNode } from 'lucide-react'

const documentOutline: IconNode = [
  ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', key: 'page' }],
  ['path', { d: 'M14 2v6h6', key: 'fold' }]
]

// Why: Lucide's document categories share a text glyph; format marks remain recognizable without color.
export const FilePdf = createLucideIcon('file-pdf', [
  ['path', { d: 'M4 9V4a2 2 0 0 1 2-2h8l6 6v1M14 2v6h6M4 21h16', key: 'page' }],
  ['path', { d: 'M3 18v-6h2a1.5 1.5 0 0 1 0 3H3', key: 'p' }],
  ['path', { d: 'M10 12v6h1a3 3 0 0 0 0-6Z', key: 'd' }],
  ['path', { d: 'M18 18v-6h3M18 15h2', key: 'f' }]
])

export const FileWord = createLucideIcon('file-word', [
  ...documentOutline,
  ['path', { d: 'm7 12 2 6 3-5 3 5 2-6', key: 'w' }]
])

export const FileMarkdown = createLucideIcon('file-markdown', [
  ['rect', { x: '2', y: '5', width: '20', height: '14', rx: '2', key: 'frame' }],
  ['path', { d: 'M5 15V9l3 3 3-3v6M17 9v6m-2-2 2 2 2-2', key: 'markdown' }]
])

export const FileExcel = createLucideIcon('file-excel', [
  ...documentOutline,
  ['path', { d: 'm9 12 6 6m0-6-6 6', key: 'x' }]
])

export const FileCsv = createLucideIcon('file-csv', [
  ...documentOutline,
  ['path', { d: 'M8 12h8M8 16h8M11 11v8m4-3v2l-1 1', key: 'table' }]
])

export const FileNotebook = createLucideIcon('file-notebook', [
  ['path', { d: 'M4 8a10 10 0 0 1 16 0M4 16a10 10 0 0 0 16 0', key: 'orbit' }],
  ['circle', { cx: '18', cy: '3', r: '1', key: 'top' }],
  ['circle', { cx: '5', cy: '21', r: '1', key: 'bottom' }],
  ['path', { d: 'm7 10-2 2 2 2m10-4 2 2-2 2m-4-5-2 6', key: 'code' }]
])
