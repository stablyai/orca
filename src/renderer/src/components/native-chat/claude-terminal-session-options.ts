import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

const EFFORT_ID_BY_LABEL: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra high': 'xhigh',
  xhigh: 'xhigh',
  max: 'max'
}

// Narrow panes elide effort; retain the reported level as the reliable suffix.
const CLAUDE_MODEL_EFFORT =
  /\bwith\s+(extra high|xhigh|medium|high|low|max)(?:\s+effort\b|\s*…|\s*$)/i

// Use startup box corners to distinguish frame chrome from chat prose.
const FRAME_TOP = '╭'
const FRAME_BOTTOM = '╰'
const FRAME_COLUMN = '│'

function normalizedScreenLines(screen: string): string[] {
  return stripScrollbackAnsi(screen)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
}

function isClaudeHeaderRow(line: string): boolean {
  // xterm serialization can remove the gap before the version, as in Claude Codev2.1.220.
  if (!/\bClaude Code/i.test(line)) {
    return false
  }
  // Narrow frames omit version, so accept their frame corner as alternate header evidence.
  return /\bClaude Code\s*v?\d+(?:\.\d+){1,2}\b/i.test(line) || line.startsWith(FRAME_TOP)
}

/** Read only the left frame cell; colliding empty-cell borders must not expose release-panel prose. */
function frameCell(line: string): string {
  if (line.startsWith(FRAME_COLUMN)) {
    const afterBorder = line.slice(FRAME_COLUMN.length)
    const columnEnd = afterBorder.indexOf(FRAME_COLUMN)
    return (columnEnd === -1 ? afterBorder : afterBorder.slice(0, columnEnd)).trim()
  }
  // Unframed buffers put the descriptor on the row directly, behind box art.
  return line.replace(/^[^A-Za-z0-9]+/, '').trim()
}

function isModelDescriptorCell(cell: string): boolean {
  return cell.includes('·') || CLAUDE_MODEL_EFFORT.test(cell)
}

function isWorkingDirectoryCell(cell: string): boolean {
  return (
    cell.startsWith('/') ||
    cell.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(cell) ||
    /^\\\\[^\\]/.test(cell)
  )
}

/** Search the bounded startup frame from bottom up so model metadata wins over release-panel text. */
function claudeModelDescriptorCell(lines: string[], headerIndex: number): string | null {
  const frameBottom = lines.findIndex(
    (line, index) => index > headerIndex && line.startsWith(FRAME_BOTTOM)
  )
  // Why: an unframed buffer gives no bottom to bound the search, so keep the
  // original tight window rather than reaching into conversation text.
  const lastRow = frameBottom > 0 ? frameBottom - 1 : Math.min(headerIndex + 2, lines.length - 1)
  for (let index = lastRow; index > headerIndex; index -= 1) {
    const cell = frameCell(lines[index] ?? '')
    if (isModelDescriptorCell(cell)) {
      return cell
    }
  }
  // xterm serialization can join the descriptor onto the version row itself.
  const joined = frameCell((lines[headerIndex] ?? '').replace(/^.*?\bClaude Code\s*v?[\d.]*/i, ''))
  if (isModelDescriptorCell(joined)) {
    return joined
  }
  return frameBottom > 0 ? modelRowAboveWorkingDirectory(lines, headerIndex, frameBottom) : null
}

/** Bare models with wrapped billing lack metadata; find them within two rows above the frame’s working directory. */
function modelRowAboveWorkingDirectory(
  lines: string[],
  headerIndex: number,
  frameBottom: number
): string | null {
  let workingDirectory = -1
  for (let index = frameBottom - 1; index > headerIndex; index -= 1) {
    const cell = frameCell(lines[index] ?? '')
    if (isWorkingDirectoryCell(cell)) {
      workingDirectory = index
      break
    }
  }
  if (workingDirectory < 0) {
    return null
  }
  let top = workingDirectory
  while (top - 1 > headerIndex && frameCell(lines[top - 1] ?? '')) {
    top -= 1
  }
  // Anything taller than descriptor + billing is the welcome art, not a model.
  if (top >= workingDirectory || workingDirectory - top > 2) {
    return null
  }
  const cell = frameCell(lines[top] ?? '')
  return /^API Usage Billing$/i.test(cell) ? null : cell
}

function parseClaudeModelName(cell: string): string | null {
  // split always yields a non-empty first segment for a non-empty cell.
  const beforeBilling = cell.split('·')[0]!
  const effort = beforeBilling.match(CLAUDE_MODEL_EFFORT)
  const name = (
    effort?.index === undefined ? beforeBilling : beforeBilling.slice(0, effort.index)
  ).trim()
  return name || null
}

function modelNameTokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z]+|\d+[a-z]*/g) ?? []
}

/** Match a whole leading family and ordered variant tokens, allowing inserted versions without claiming vendor slugs or other context sizes. */
function labelNamesReportedModel(reportedModel: string, label: string): boolean {
  const labelTokens = modelNameTokens(label)
  const family = labelTokens[0]
  if (!family) {
    return false
  }
  const name = reportedModel.toLowerCase()
  if (name !== family && !name.startsWith(`${family} `)) {
    return false
  }
  const nameTokens = modelNameTokens(name)
  let cursor = 1
  for (const token of labelTokens.slice(1)) {
    const found = nameTokens.indexOf(token, cursor)
    if (found === -1) {
      return false
    }
    cursor = found + 1
  }
  return true
}

/** Prefer the host’s specific discovered entry over seed families, including context variants. */
function findClaudeCatalogModel(
  reportedModel: string,
  models: readonly CatalogModel[] | undefined
): CatalogModel | undefined {
  const seeded = getAgentSessionOptionCatalog('claude')?.models ?? []
  for (const candidates of [models ?? [], seeded]) {
    const matches = candidates.filter(({ label }) => labelNamesReportedModel(reportedModel, label))
    const best = matches.sort(
      (left, right) => modelNameTokens(right.label).length - modelNameTokens(left.label).length
    )[0]
    if (best) {
      return best
    }
  }
  return undefined
}

/** Pass the host catalog to return listed picker ids; omission uses version-neutral seed families. */
export function readClaudeSessionOptionsFromTerminalScreen(
  screen: string | null | undefined,
  models?: readonly CatalogModel[]
): Record<string, SessionOptionValue> | null {
  if (!screen) {
    return null
  }
  const lines = normalizedScreenLines(screen)
  const headerIndex = lines.findIndex(isClaudeHeaderRow)
  if (headerIndex === -1) {
    return null
  }
  const descriptorCell = claudeModelDescriptorCell(lines, headerIndex)
  const reportedModel = descriptorCell ? parseClaudeModelName(descriptorCell) : null
  if (!reportedModel) {
    return null
  }
  const model = findClaudeCatalogModel(reportedModel, models)
  if (!model) {
    // A custom model carries no catalog options, so no effort is reported.
    return { model: reportedModel }
  }
  const result: Record<string, SessionOptionValue> = { model: model.id }
  const effortLabel = descriptorCell?.match(CLAUDE_MODEL_EFFORT)?.[1]
  const effort = effortLabel ? EFFORT_ID_BY_LABEL[effortLabel.toLowerCase()] : undefined
  if (effort && model.options.some((option) => option.id === 'effort')) {
    result.effort = effort
  }
  return result
}
