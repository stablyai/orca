import { FILE_SECTION_START, isFileHeaderPair } from './native-chat-diff'
import { pushEditGap, splitEditContent, type NativeChatEditLine } from './native-chat-edit-model'

const HUNK_RANGES = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export type UnifiedPatchLines = {
  lines: NativeChatEditLine[]
  /** True only when every hunk carried real `@@` ranges. */
  lineNumbersKnown: boolean
  /** The patch text was clipped before it became rows. */
  truncated: boolean
}

/** Parses unified patch text, keeping the `@@` ranges as per-row line numbers.
 *  A hunk header whose `@@` is a bare context anchor with no ranges leaves its
 *  rows unnumbered rather than numbered from 1, because a wrong number reads as
 *  authoritative.
 *
 *  `implicitFirstHunk` opens the body as a hunk of unknown position, for the
 *  patch dialect whose first chunk may carry no header at all. */
export function editLinesFromUnifiedPatch(
  text: string,
  options?: { implicitFirstHunk?: boolean }
): UnifiedPatchLines | null {
  const source = splitEditContent(text)
  const rows = source.lines
  const lines: NativeChatEditLine[] = []
  let oldNo: number | null = null
  let newNo: number | null = null
  let sawHunk = options?.implicitFirstHunk === true
  let ranged = true
  let inHunk = sawHunk

  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index] ?? ''
    if (raw.startsWith('@@')) {
      const match = HUNK_RANGES.exec(raw)
      oldNo = match ? Number(match[1]) : null
      newNo = match ? Number(match[3]) : null
      // Successive hunks are separate regions of the file; concatenated with no
      // break the gutter jumps and the reader sees one continuous block.
      pushEditGap(lines)
      sawHunk = true
      inHunk = true
      continue
    }
    // `\ No newline at end of file` sits mid-hunk, between the removed old last
    // line and the added new one, so it ends nothing.
    if (raw.startsWith('\\')) {
      continue
    }
    if (!inHunk && isFileHeaderPair(rows, index)) {
      index += 1
      continue
    }
    if (FILE_SECTION_START.test(raw)) {
      inHunk = false
      continue
    }
    if (!inHunk) {
      continue
    }
    // Read off the rows rather than the header, so a body that opened with no
    // header is reported as unlocatable just like a rangeless `@@`.
    ranged &&= oldNo !== null || newNo !== null
    if (raw.startsWith('+')) {
      lines.push({
        kind: 'add',
        text: raw.slice(1),
        oldLineNumber: null,
        newLineNumber: newNo
      })
      newNo = newNo === null ? null : newNo + 1
      continue
    }
    if (raw.startsWith('-')) {
      lines.push({
        kind: 'del',
        text: raw.slice(1),
        oldLineNumber: oldNo,
        newLineNumber: null
      })
      oldNo = oldNo === null ? null : oldNo + 1
      continue
    }
    lines.push({
      kind: 'context',
      text: raw.startsWith(' ') ? raw.slice(1) : raw,
      oldLineNumber: oldNo,
      newLineNumber: newNo
    })
    oldNo = oldNo === null ? null : oldNo + 1
    newNo = newNo === null ? null : newNo + 1
  }

  if (!sawHunk || lines.length === 0) {
    return null
  }
  return { lines, lineNumbersKnown: ranged, truncated: source.truncated }
}

const GIT_DIFF_HEADER = 'diff --git '

export type UnifiedPatchSection = {
  /** Null when the patch text named no file, leaving it to the caller. */
  path: string | null
  oldPath: string | null
  changeKind: 'added' | 'deleted' | 'edited' | 'renamed'
  body: string
}

type Section = {
  rows: string[]
  oldPath: string | null
  newPath: string | null
  named: boolean
  /** A `--- `/`+++ ` pair already named this section, so the next one is a new file. */
  hasHeaderPair: boolean
  /** Only a `diff --git` header states both sides of a move as such. A bare
   *  pair with differing paths is just as likely two directories compared. */
  fromGitHeader: boolean
}

/** Splits patch text into one section per file it touches. Without this a
 *  multi-file patch renders as a single card under the first file's name, with
 *  the later files' rows and gutter numbers beneath it. */
export function unifiedPatchSections(text: string): {
  sections: UnifiedPatchSection[]
  truncated: boolean
} {
  const source = splitEditContent(text)
  const rows = source.lines
  const sections: Section[] = []
  let current: Section | null = null
  let inHunk = false

  const open = (): Section => {
    const section: Section = {
      rows: [],
      oldPath: null,
      newPath: null,
      named: false,
      hasHeaderPair: false,
      fromGitHeader: false
    }
    sections.push(section)
    return section
  }

  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index] ?? ''
    if (raw.startsWith(GIT_DIFF_HEADER)) {
      const paths = gitHeaderPaths(raw)
      current = open()
      current.oldPath = paths.oldPath
      current.newPath = paths.newPath
      current.named = true
      current.fromGitHeader = true
      inHunk = false
      continue
    }
    // A header pair is structure outside a hunk. Inside one it is also a file
    // boundary, but only when a hunk header follows it immediately: a removed
    // `-- x` over an added `++ y` is never followed by a column-0 `@@`, and
    // that is what separates the files of a patch written without `diff --git`
    // headers, where nothing else would end the previous file's hunk.
    if (isFileHeaderPair(rows, index) && (!inHunk || (rows[index + 2] ?? '').startsWith('@@'))) {
      // The pair names the section a `diff --git` just opened; a second pair in
      // the same section is the next file of a patch written without them.
      if (!current || current.hasHeaderPair) {
        current = open()
      }
      current.oldPath = sourceHeaderPath(rows[index] ?? '')
      current.newPath = sourceHeaderPath(rows[index + 1] ?? '')
      current.named = true
      current.hasHeaderPair = true
      inHunk = false
      index += 1
      continue
    }
    if (raw.startsWith('@@')) {
      inHunk = true
    } else if (FILE_SECTION_START.test(raw)) {
      inHunk = false
    }
    current ??= open()
    current.rows.push(raw)
  }

  return {
    sections: sections.map((section) => ({
      path: section.newPath ?? section.oldPath,
      oldPath: sectionChangeKind(section) === 'renamed' ? section.oldPath : null,
      changeKind: sectionChangeKind(section),
      body: section.rows.join('\n')
    })),
    truncated: source.truncated
  }
}

function sectionChangeKind(section: Section): UnifiedPatchSection['changeKind'] {
  if (!section.named) {
    return 'edited'
  }
  if (section.newPath === null) {
    return 'deleted'
  }
  if (section.oldPath === null) {
    return 'added'
  }
  if (section.oldPath === section.newPath) {
    return 'edited'
  }
  // Differing sides are a move only where the header says so. Bare pairs carry
  // whatever paths the producer compared, which may be two directories.
  return section.fromGitHeader ? 'renamed' : 'edited'
}

/** `--- a/<path>` / `+++ b/<path>`, where the absent side is `/dev/null` and a
 *  trailing tab introduces the timestamp some producers append. */
function sourceHeaderPath(line: string): string | null {
  const value = (line.slice(4).split('\t')[0] ?? '').trim()
  return value === '' || value === '/dev/null' ? null : value.replace(/^[ab]\//, '')
}

function gitHeaderPaths(line: string): { oldPath: string | null; newPath: string | null } {
  const rest = line.slice(GIT_DIFF_HEADER.length)
  // Both halves carry the same path unless the file moved, so the second one
  // starts at the last ` b/` rather than at the first space.
  const split = rest.lastIndexOf(' b/')
  if (split === -1) {
    return { oldPath: null, newPath: null }
  }
  return {
    oldPath: rest.slice(0, split).replace(/^a\//, ''),
    newPath: rest.slice(split + 1).replace(/^b\//, '')
  }
}

/** Rows for a whole-file add or delete, which legitimately number from 1. */
export function editLinesFromWholeFile(
  content: string,
  kind: 'add' | 'del'
): { lines: NativeChatEditLine[]; truncated: boolean } {
  const body = splitEditContent(content)
  return {
    lines: body.lines.map((text, index) => ({
      kind,
      text,
      oldLineNumber: kind === 'del' ? index + 1 : null,
      newLineNumber: kind === 'add' ? index + 1 : null
    })),
    truncated: body.truncated
  }
}
