import { createBrowserUuid } from '@/lib/browser-uuid'
import { isRecord, type IpynbCellKind } from './ipynb-parse'

export type IpynbRunResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
}

function splitIpynbSource(source: string): string[] {
  if (!source) {
    return []
  }
  const lines: string[] = []
  let lineStart = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 10) {
      continue
    }
    lines.push(source.slice(lineStart, index + 1))
    lineStart = index + 1
  }
  if (lineStart < source.length) {
    lines.push(source.slice(lineStart))
  }
  return lines
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
