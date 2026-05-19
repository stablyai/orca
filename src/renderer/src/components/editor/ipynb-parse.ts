/* eslint-disable max-lines -- Why: keeping notebook parse and mutation helpers
in one module makes nbformat preservation easier to audit while the notebook
editor model is still small. */
import { createBrowserUuid } from '@/lib/browser-uuid'

export type IpynbCellKind = 'code' | 'markdown' | 'raw'

export type IpynbOutput =
  | { kind: 'stream'; name: string; text: string }
  | { kind: 'error'; name: string; message: string; traceback: string }
  | { kind: 'display'; outputType: string; executionCount: number | null; items: IpynbOutputItem[] }

export type IpynbOutputItem = {
  mime: string
  value: unknown
}

export type IpynbCell = {
  id: string | null
  kind: IpynbCellKind
  language: string
  source: string
  executionCount: number | null
  outputs: IpynbOutput[]
}

export type ParsedIpynb = {
  language: string
  kernelName: string | null
  nbformat: string
  cells: IpynbCell[]
}

export type IpynbRunResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
}

const DISPLAY_MIME_ORDER = [
  'text/html',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/svg+xml',
  'application/json',
  'text/markdown',
  'text/plain'
] as const

const JUPYTER_LANGUAGE_TO_MONACO_LANGUAGE: Record<string, string> = {
  'c#': 'csharp',
  'f#': 'fsharp',
  'q#': 'qsharp',
  'c++11': 'cpp',
  'c++12': 'cpp',
  'c++14': 'cpp',
  'c++': 'cpp'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function concatIpynbMultilineString(value: unknown): string {
  if (Array.isArray(value)) {
    let result = ''
    for (let i = 0; i < value.length; i += 1) {
      const item = String(value[i] ?? '')
      result += i < value.length - 1 && !item.endsWith('\n') ? `${item}\n` : item
    }
    return result.replace(/\r\n/g, '\n')
  }
  return String(value ?? '').replace(/\r\n/g, '\n')
}

export function translateKernelLanguageToMonaco(language: string | null | undefined): string {
  const normalized = (language ?? 'python').toLowerCase()
  if (normalized.length === 2 && normalized.endsWith('#')) {
    return `${normalized.slice(0, 1)}sharp`
  }
  return JUPYTER_LANGUAGE_TO_MONACO_LANGUAGE[normalized] ?? normalized
}

function getPreferredLanguage(content: Record<string, unknown>): string {
  const metadata = isRecord(content.metadata) ? content.metadata : {}
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {}
  const kernelSpec = isRecord(metadata.kernelspec) ? metadata.kernelspec : {}
  const language =
    typeof languageInfo.name === 'string'
      ? languageInfo.name
      : typeof kernelSpec.language === 'string'
        ? kernelSpec.language
        : 'python'
  return translateKernelLanguageToMonaco(language)
}

function getKernelName(content: Record<string, unknown>): string | null {
  const metadata = isRecord(content.metadata) ? content.metadata : {}
  const kernelSpec = isRecord(metadata.kernelspec) ? metadata.kernelspec : {}
  return typeof kernelSpec.display_name === 'string'
    ? kernelSpec.display_name
    : typeof kernelSpec.name === 'string'
      ? kernelSpec.name
      : null
}

function getCellLanguage(cell: Record<string, unknown>, fallback: string): string {
  const metadata = isRecord(cell.metadata) ? cell.metadata : {}
  const vscode = isRecord(metadata.vscode) ? metadata.vscode : {}
  return typeof vscode.languageId === 'string' ? vscode.languageId : fallback
}

function parseDisplayItems(data: unknown): IpynbOutputItem[] {
  if (!isRecord(data)) {
    return []
  }
  return Object.entries(data)
    .map(([mime, value]) => ({ mime, value }))
    .sort((a, b) => {
      const aIndex = DISPLAY_MIME_ORDER.indexOf(a.mime as (typeof DISPLAY_MIME_ORDER)[number])
      const bIndex = DISPLAY_MIME_ORDER.indexOf(b.mime as (typeof DISPLAY_MIME_ORDER)[number])
      return (aIndex === -1 ? 100 : aIndex) - (bIndex === -1 ? 100 : bIndex)
    })
}

function parseOutput(rawOutput: unknown): IpynbOutput | null {
  if (!isRecord(rawOutput) || typeof rawOutput.output_type !== 'string') {
    return null
  }

  if (rawOutput.output_type === 'stream') {
    return {
      kind: 'stream',
      name: typeof rawOutput.name === 'string' ? rawOutput.name : 'stdout',
      text: concatIpynbMultilineString(rawOutput.text)
    }
  }

  if (rawOutput.output_type === 'error') {
    return {
      kind: 'error',
      name: typeof rawOutput.ename === 'string' ? rawOutput.ename : '',
      message: typeof rawOutput.evalue === 'string' ? rawOutput.evalue : '',
      traceback: concatIpynbMultilineString(rawOutput.traceback)
    }
  }

  return {
    kind: 'display',
    outputType: rawOutput.output_type,
    executionCount:
      typeof rawOutput.execution_count === 'number' ? rawOutput.execution_count : null,
    items: parseDisplayItems(rawOutput.data)
  }
}

function parseCell(rawCell: unknown, fallbackLanguage: string): IpynbCell | null {
  if (!isRecord(rawCell)) {
    return null
  }
  const kind =
    rawCell.cell_type === 'markdown' || rawCell.cell_type === 'raw' || rawCell.cell_type === 'code'
      ? rawCell.cell_type
      : null
  if (kind === null) {
    return null
  }

  const outputs = Array.isArray(rawCell.outputs)
    ? rawCell.outputs.map(parseOutput).filter((output): output is IpynbOutput => output !== null)
    : []

  return {
    id: typeof rawCell.id === 'string' ? rawCell.id : null,
    kind,
    language: kind === 'code' ? getCellLanguage(rawCell, fallbackLanguage) : kind,
    source: concatIpynbMultilineString(rawCell.source),
    executionCount: typeof rawCell.execution_count === 'number' ? rawCell.execution_count : null,
    outputs
  }
}

export function parseIpynb(content: string): ParsedIpynb {
  const parsed = JSON.parse(content) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Notebook root must be a JSON object')
  }
  if (!Array.isArray(parsed.cells)) {
    throw new Error('Notebook is missing a cells array')
  }

  const language = getPreferredLanguage(parsed)
  const cells = parsed.cells
    .map((cell) => parseCell(cell, language))
    .filter((cell): cell is IpynbCell => cell !== null)

  return {
    language,
    kernelName: getKernelName(parsed),
    nbformat:
      typeof parsed.nbformat === 'number'
        ? `${parsed.nbformat}.${typeof parsed.nbformat_minor === 'number' ? parsed.nbformat_minor : 0}`
        : 'unknown',
    cells
  }
}

function splitIpynbSource(source: string): string[] {
  if (!source) {
    return []
  }
  return source.endsWith('\n') ? (source.match(/[^\n]*\n/g) ?? []) : source.split(/(?<=\n)/)
}

function parseNotebookRoot(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Notebook root must be a JSON object')
  }
  if (!Array.isArray(parsed.cells)) {
    throw new Error('Notebook is missing a cells array')
  }
  return parsed
}

function ensureCell(root: Record<string, unknown>, index: number): Record<string, unknown> {
  const cells = root.cells
  if (!Array.isArray(cells) || !isRecord(cells[index])) {
    throw new Error('Notebook cell no longer exists')
  }
  return cells[index]
}

function serializeNotebook(root: Record<string, unknown>): string {
  return `${JSON.stringify(root, null, 1)}\n`
}

export function updateIpynbCellSource(content: string, index: number, source: string): string {
  const root = parseNotebookRoot(content)
  ensureCell(root, index).source = splitIpynbSource(source)
  return serializeNotebook(root)
}

export function updateIpynbCellSources(
  content: string,
  updates: { index: number; source: string }[]
): string {
  if (updates.length === 0) {
    return content
  }
  const root = parseNotebookRoot(content)
  for (const update of updates) {
    ensureCell(root, update.index).source = splitIpynbSource(update.source)
  }
  return serializeNotebook(root)
}

export function updateIpynbCellKind(
  content: string,
  index: number,
  kind: IpynbCellKind,
  fallbackLanguage: string
): string {
  const root = parseNotebookRoot(content)
  const cell = ensureCell(root, index)
  cell.cell_type = kind
  if (kind === 'code') {
    cell.outputs = Array.isArray(cell.outputs) ? cell.outputs : []
    cell.execution_count = typeof cell.execution_count === 'number' ? cell.execution_count : null
    cell.metadata = isRecord(cell.metadata) ? cell.metadata : {}
    const metadata = cell.metadata as Record<string, unknown>
    const vscode = isRecord(metadata.vscode) ? metadata.vscode : {}
    metadata.vscode = { ...vscode, languageId: fallbackLanguage }
  } else {
    delete cell.outputs
    delete cell.execution_count
  }
  return serializeNotebook(root)
}

export function insertIpynbCell(
  content: string,
  index: number,
  kind: IpynbCellKind,
  language: string
): string {
  const root = parseNotebookRoot(content)
  const cells = root.cells as unknown[]
  const nextCell: Record<string, unknown> = {
    cell_type: kind,
    id: createBrowserUuid(),
    metadata: {},
    source: []
  }
  if (kind === 'code') {
    nextCell.execution_count = null
    nextCell.outputs = []
    nextCell.metadata = { vscode: { languageId: language } }
  }
  cells.splice(Math.min(Math.max(index, 0), cells.length), 0, nextCell)
  return serializeNotebook(root)
}

export function deleteIpynbCell(content: string, index: number): string {
  const root = parseNotebookRoot(content)
  const cells = root.cells as unknown[]
  if (cells.length <= 1) {
    cells.splice(0, cells.length, {
      cell_type: 'code',
      id: createBrowserUuid(),
      metadata: {},
      execution_count: null,
      outputs: [],
      source: []
    })
  } else {
    cells.splice(index, 1)
  }
  return serializeNotebook(root)
}

export function moveIpynbCell(content: string, index: number, direction: -1 | 1): string {
  const root = parseNotebookRoot(content)
  const cells = root.cells as unknown[]
  const nextIndex = index + direction
  if (index < 0 || index >= cells.length || nextIndex < 0 || nextIndex >= cells.length) {
    return content
  }
  const [cell] = cells.splice(index, 1)
  cells.splice(nextIndex, 0, cell)
  return serializeNotebook(root)
}

export function updateIpynbCellOutputs(
  content: string,
  index: number,
  result: IpynbRunResult
): string {
  const root = parseNotebookRoot(content)
  const cell = ensureCell(root, index)
  const outputs: Record<string, unknown>[] = []
  if (result.stdout) {
    outputs.push({ output_type: 'stream', name: 'stdout', text: splitIpynbSource(result.stdout) })
  }
  if (result.stderr && result.exitCode === 0 && !result.error) {
    outputs.push({ output_type: 'stream', name: 'stderr', text: splitIpynbSource(result.stderr) })
  }
  if (result.error || (result.exitCode ?? 0) !== 0) {
    const message = result.error || result.stderr || `Process exited with code ${result.exitCode}`
    outputs.push({
      output_type: 'error',
      ename: 'PythonError',
      evalue: message,
      traceback: splitIpynbSource(result.stderr || message)
    })
  }
  cell.outputs = outputs
  cell.execution_count = typeof cell.execution_count === 'number' ? cell.execution_count + 1 : 1
  return serializeNotebook(root)
}
