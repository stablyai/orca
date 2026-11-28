import { translate } from '@/i18n/i18n'
import type { GitBlameCommit } from '../../../../../shared/git/blame/git-blame-types'
import type { LineBlame } from './git-blame-line-store'

// The cell is absolutely positioned at the gutter's left edge, so min chars must reserve its width.
// Keep BLAME_CELL_CH in sync with `.orca-git-blame-cell` in main.css.
const BLAME_CELL_CH = 22
const BLAME_CELL_GAP_CH = 1
const MONACO_DEFAULT_LINE_NUMBER_CHARS = 5

export const BLAME_COLUMN_MIN_CHARS =
  BLAME_CELL_CH + BLAME_CELL_GAP_CH + MONACO_DEFAULT_LINE_NUMBER_CHARS

/** What MonacoEditor sets when the blame column is off. */
export const PLAIN_LINE_NUMBER_OPTIONS = {
  lineNumbers: 'on',
  lineNumbersMinChars: MONACO_DEFAULT_LINE_NUMBER_CHARS
} as const

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Numeric, not locale-formatted: the cell has a fixed width.
function formatBlameDate(epochMs: number): string {
  const date = new Date(epochMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// 0 is the newest commit's tint, the last level is the oldest and has no tint.
const AGE_LEVELS = 4

/** Rank the file's commits by author time and spread them over the tint levels. */
export function blameAgeLevels(commits: readonly GitBlameCommit[]): Map<string, number> {
  const newestFirst = [...commits].sort((a, b) => b.authorTime - a.authorTime)
  const last = newestFirst.length - 1
  return new Map(
    newestFirst.map((commit, rank) => [
      commit.oid,
      last === 0 ? AGE_LEVELS - 1 : Math.round((rank / last) * (AGE_LEVELS - 1))
    ])
  )
}

export type BlameLineGroup = { startLine: number; endLine: number; commit: GitBlameCommit }

/** Consecutive lines of one commit, so a hover needs one decoration per run instead of per line. */
export function groupBlameLinesByCommit(
  lineCount: number,
  blameAt: (lineNumber: number) => LineBlame | null
): BlameLineGroup[] {
  const groups: BlameLineGroup[] = []
  let open: BlameLineGroup | null = null
  for (let line = 1; line <= lineCount; line++) {
    const blame = blameAt(line)
    if (blame?.kind !== 'commit') {
      open = null
    } else if (open?.commit.oid === blame.commit.oid) {
      open.endLine = line
    } else {
      open = { startLine: line, endLine: line, commit: blame.commit }
      groups.push(open)
    }
  }
  return groups
}

/** Monaco inserts a custom line number as raw HTML, and authors come from untrusted commits. */
export function formatBlameColumnLine(
  lineNumber: number,
  blame: LineBlame | null,
  ageLevels: ReadonlyMap<string, number>
): string {
  if (!blame) {
    return String(lineNumber)
  }
  const cell =
    blame.kind === 'uncommitted'
      ? {
          className: 'orca-git-blame-cell orca-git-blame-cell-uncommitted',
          text: translate('editor.gitBlame.uncommitted', 'Uncommitted changes')
        }
      : {
          className: `orca-git-blame-cell orca-git-blame-age-${ageLevels.get(blame.commit.oid) ?? AGE_LEVELS - 1}`,
          text: `${formatBlameDate(blame.commit.authorTime)} ${blame.commit.author}`
        }
  return `<span class="${cell.className}">${escapeHtml(cell.text)}</span>${lineNumber}`
}
