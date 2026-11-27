import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { isRecord, isSupportedIpynbCell, type IpynbCellKind } from './ipynb-parse'

type NotebookRoot = {
  document: Record<string, unknown> & { cells: unknown[] }
  cellIndices: number[]
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

function parseNotebookRoot(content: string): NotebookRoot {
  const parsed = JSON.parse(content) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Notebook root must be a JSON object')
  }
  if (!Array.isArray(parsed.cells)) {
    throw new Error('Notebook is missing a cells array')
  }
  const cellIndices: number[] = []
  for (let index = 0; index < parsed.cells.length; index += 1) {
    if (isSupportedIpynbCell(parsed.cells[index])) {
      cellIndices.push(index)
    }
  }
  return { document: { ...parsed, cells: parsed.cells }, cellIndices }
}

function ensureCell(root: NotebookRoot, index: number): Record<string, unknown> {
  const rawIndex = root.cellIndices[index]
  const cell = rawIndex === undefined ? undefined : root.document.cells[rawIndex]
  if (!isRecord(cell)) {
    throw new Error('Notebook cell no longer exists')
  }
  return cell
}

function serializeNotebook(root: NotebookRoot): string {
  return `${JSON.stringify(root.document, null, 1)}\n`
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
  const cells = root.document.cells
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
  const visibleIndex = Math.min(Math.max(index, 0), root.cellIndices.length)
  cells.splice(root.cellIndices[visibleIndex] ?? cells.length, 0, nextCell)
  return serializeNotebook(root)
}

export function deleteIpynbCell(content: string, index: number): string {
  const root = parseNotebookRoot(content)
  const cells = root.document.cells
  const rawIndex = root.cellIndices[index]
  if (rawIndex === undefined) {
    return content
  }
  if (root.cellIndices.length <= 1) {
    cells.splice(rawIndex, 1, {
      cell_type: 'code',
      id: createBrowserUuid(),
      metadata: {},
      execution_count: null,
      outputs: [],
      source: []
    })
  } else {
    cells.splice(rawIndex, 1)
  }
  return serializeNotebook(root)
}

export function moveIpynbCell(content: string, index: number, direction: -1 | 1): string {
  const root = parseNotebookRoot(content)
  const cells = root.document.cells
  const rawIndex = root.cellIndices[index]
  const nextRawIndex = root.cellIndices[index + direction]
  if (rawIndex === undefined || nextRawIndex === undefined) {
    return content
  }
  const cell = cells[rawIndex]
  cells[rawIndex] = cells[nextRawIndex]
  cells[nextRawIndex] = cell
  return serializeNotebook(root)
}

export function updateIpynbCellRun(
  content: string,
  index: number,
  outputs: Record<string, unknown>[],
  executionCount: number | null
): string {
  const root = parseNotebookRoot(content)
  applyIpynbCellRun(root, index, outputs, executionCount)
  return serializeNotebook(root)
}

function applyIpynbCellRun(
  root: NotebookRoot,
  index: number,
  outputs: Record<string, unknown>[],
  executionCount: number | null
): void {
  const cell = ensureCell(root, index)
  // Like Jupyter, store stream text as lines so notebook diffs stay line-oriented.
  cell.outputs = outputs.map((output) =>
    output.output_type === 'stream' && typeof output.text === 'string'
      ? { ...output, text: splitIpynbSource(output.text) }
      : output
  )
  cell.execution_count = executionCount
}

export function updateIpynbCellRuns(
  content: string,
  updates: { index: number; outputs: Record<string, unknown>[]; executionCount: number | null }[]
): string {
  if (updates.length === 0) {
    return content
  }
  const root = parseNotebookRoot(content)
  let changed = false
  for (const update of updates) {
    try {
      applyIpynbCellRun(root, update.index, update.outputs, update.executionCount)
      changed = true
    } catch {
      // Preserve the successful prefix when a later cell no longer exists.
      break
    }
  }
  return changed ? serializeNotebook(root) : content
}

export function clearIpynbOutputs(content: string): string {
  const root = parseNotebookRoot(content)
  for (const cell of root.document.cells) {
    if (isRecord(cell) && cell.cell_type === 'code') {
      cell.outputs = []
      cell.execution_count = null
    }
  }
  return serializeNotebook(root)
}

/** Gives supported cells nbformat 4.5 ids, as Jupyter does when it upgrades a 4.4 notebook. */
export function withIpynbCellIds(content: string): string {
  const root = parseNotebookRoot(content)
  const cells = root.document.cells.filter(isSupportedIpynbCell)
  if (cells.every((cell) => typeof cell.id === 'string')) {
    return content
  }
  for (const cell of cells) {
    cell.id = typeof cell.id === 'string' ? cell.id : createBrowserUuid()
  }
  root.document.nbformat_minor = Math.max(
    typeof root.document.nbformat_minor === 'number' ? root.document.nbformat_minor : 0,
    5
  )
  return serializeNotebook(root)
}
