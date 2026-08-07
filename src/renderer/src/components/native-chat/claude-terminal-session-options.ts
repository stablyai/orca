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

// Why: narrow panes elide the trailing `effort` word to an ellipsis, so the
// level itself is the only part of the suffix we can rely on.
const CLAUDE_MODEL_EFFORT =
  /\bwith\s+(extra high|xhigh|medium|high|low|max)(?:\s+effort\b|\s*…|\s*$)/i

// Claude's startup frame. Chat text uses an em dash rather than these box
// characters, so a leading corner is safe proof that a row is chrome.
const FRAME_TOP = '╭'
const FRAME_BOTTOM = '╰'
const FRAME_COLUMN = '│'

/** Rows of the visible screen, ANSI-stripped and whitespace-collapsed. */
function normalizedScreenLines(screen: string): string[] {
  return stripScrollbackAnsi(screen)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
}

function isClaudeHeaderRow(line: string): boolean {
  // No trailing word boundary: serialization drops the gap before the version,
  // leaving `Claude Codev2.1.220`.
  if (!/\bClaude Code/i.test(line)) {
    return false
  }
  // Why: panes under ~70 columns drop the version from the frame entirely, so
  // accept the frame corner as the alternative proof this is Claude's chrome.
  // xterm serialization also drops cursor-positioning cells between the product
  // name and version, producing `Claude Codev2.1.211`.
  return /\bClaude Code\s*v?\d+(?:\.\d+){1,2}\b/i.test(line) || line.startsWith(FRAME_TOP)
}

/** The frame's leftmost cell on a row. Reading up to the next column border
 *  keeps the release-notes panel out: on rows whose left cell is empty the
 *  borders collide (`││`) and this yields nothing rather than the panel text. */
function frameCell(line: string): string {
  if (line.startsWith(FRAME_COLUMN)) {
    const afterBorder = line.slice(FRAME_COLUMN.length)
    const columnEnd = afterBorder.indexOf(FRAME_COLUMN)
    return (columnEnd < 0 ? afterBorder : afterBorder.slice(0, columnEnd)).trim()
  }
  // Unframed buffers put the descriptor on the row directly, behind box art.
  return line.replace(/^[^A-Za-z0-9]+/, '').trim()
}

/** Whether a cell carries the metadata Claude only prints on the model row, so
 *  ordinary frame text is never mistaken for a model. */
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

/**
 * Claude prints the model descriptor near the bottom of its startup frame, with
 * the welcome art and the release-notes panel in between — it is not adjacent to
 * the version row. Search the frame from the bottom up so the panel's own text
 * can never win over the descriptor.
 */
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

/**
 * A model with no effort control whose billing wrapped away — `Haiku 4.5` on a
 * narrow pane — leaves a bare name that no metadata identifies. Claude always
 * closes the frame with the working directory, and prints at most the
 * descriptor plus a wrapped billing line above it, so walk up from there.
 */
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

/** The displayed model name, without the effort suffix or billing tail. */
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

/**
 * Whether a catalog label names the model the frame reported. The frame prints
 * the resolved model ("Opus 5 (1M context)") while labels name the alias
 * ("Opus (1M context)"), so the family has to lead as a whole word and the
 * label's remaining tokens have to appear in order. Requiring a whole word is
 * what keeps `company/my-haiku-v2` and `opus-internal-v3` out of the catalog;
 * requiring the rest is what stops `Sonnet` from claiming the 1M-context row.
 */
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
    if (found < 0) {
      return false
    }
    cursor = found + 1
  }
  return true
}

/** The most specific catalog entry naming this model, preferring the host's
 *  discovered list so variants like `opus[1m]` win over the seed family. */
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

/**
 * @param models the host's live model list. Pass the discovered catalog so the
 *   reported id is one the picker actually lists; omitting it falls back to the
 *   version-neutral seed families.
 */
export function readClaudeSessionOptionsFromTerminalScreen(
  screen: string | null | undefined,
  models?: readonly CatalogModel[]
): Record<string, SessionOptionValue> | null {
  if (!screen) {
    return null
  }
  const lines = normalizedScreenLines(screen)
  const headerIndex = lines.findIndex(isClaudeHeaderRow)
  if (headerIndex < 0) {
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
