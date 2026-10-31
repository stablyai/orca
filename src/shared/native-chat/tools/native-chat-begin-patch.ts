import { finalizeEditFile, type NativeChatEditFile } from './native-chat-edit-model'
import { editLinesFromUnifiedPatch, editLinesFromWholeFile } from './native-chat-unified-patch'

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/
/** Envelope structure that carries no file content of its own. */
const CONTROL_LINE = /^\*\*\* (?:End of File|Environment ID:)/

/** Recover envelopes from patch/command arguments, including argv words. Caller must restrict eligible tools: file contents can quote patches.
 * General command tools requireApplyCommand because a quoted envelope alone proves no edit occurred. */
export function unwrapBeginPatch(
  input: unknown,
  options?: { requireApplyCommand?: boolean }
): string | null {
  const source = envelopeSource(input, options?.requireApplyCommand === true)
  if (!source) {
    return null
  }
  const start = source.indexOf(BEGIN)
  if (start === -1) {
    return null
  }
  const end = source.indexOf(END, start)
  if (end === -1) {
    // Require the end marker so trailing shell syntax cannot become fictitious file content.
    return null
  }
  return source.slice(start, end + END.length)
}

/** Search only patch/command arguments; other values may be file data quoting an unrelated patch. */
const ENVELOPE_ARGUMENTS = ['input', 'command', 'patch', 'arguments', 'script'] as const
/** Accepted apply-command spellings distinguish applying from quoting an envelope. */
const APPLY_COMMAND = /apply_?patch/

/** Decode JSON-string payloads only in this structural consumer; other readers retain provider input unchanged. */
function envelopeSource(input: unknown, requireApplyCommand: boolean): string | null {
  if (typeof input === 'string') {
    const record = jsonRecord(input)
    return record
      ? envelopeArgument(record, requireApplyCommand)
      : applied(input, requireApplyCommand)
  }
  return typeof input === 'object' && input !== null
    ? envelopeArgument(input as Record<string, unknown>, requireApplyCommand)
    : null
}

function applied(value: string, requireApplyCommand: boolean): string | null {
  return !requireApplyCommand || APPLY_COMMAND.test(value) ? value : null
}

function jsonRecord(value: string): Record<string, unknown> | null {
  if (!value.trimStart().startsWith('{')) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** An argv element may carry the envelope while another names the apply command. */
function envelopeArgument(
  record: Record<string, unknown>,
  requireApplyCommand: boolean
): string | null {
  for (const key of ENVELOPE_ARGUMENTS) {
    const value = record[key]
    const words =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === 'string')
          : []
    if (requireApplyCommand && !words.some((word) => APPLY_COMMAND.test(word))) {
      continue
    }
    const word = words.find((entry) => entry.includes(BEGIN))
    if (word) {
      return word
    }
  }
  return null
}

/** Splits a `*** Begin Patch` envelope into one entry per file it touches. */
export function editFilesFromBeginPatch(envelope: string): NativeChatEditFile[] {
  const sections: { kind: 'Add' | 'Update' | 'Delete'; path: string; body: string[] }[] = []
  const moves = new Map<number, string>()

  // Split CRLF once so marker matching needs no trailing-CR allowances.
  for (const raw of envelope.split(/\r?\n/)) {
    const header = FILE_HEADER.exec(raw)
    if (header) {
      sections.push({
        kind: header[1] as 'Add' | 'Update' | 'Delete',
        path: header[2]!.trim(),
        body: []
      })
      continue
    }
    const move = MOVE_HEADER.exec(raw)
    if (move && sections.length > 0) {
      moves.set(sections.length - 1, move[1]!.trim())
      continue
    }
    if (raw === BEGIN || raw === END || CONTROL_LINE.test(raw) || sections.length === 0) {
      continue
    }
    sections.at(-1)!.body.push(raw)
  }

  return sections.flatMap((section, index) => {
    const body = section.body.join('\n')
    const moved = moves.get(index) ?? null
    if (section.kind === 'Add' || section.kind === 'Delete') {
      const sign = section.kind === 'Add' ? '+' : '-'
      // Add/Delete bodies carry a sign per line but no hunk header.
      const stripped = section.body
        .map((line) => (line.startsWith(sign) ? line.slice(1) : line))
        .join('\n')
      const whole = editLinesFromWholeFile(stripped, section.kind === 'Add' ? 'add' : 'del')
      return [
        finalizeEditFile({
          path: section.path,
          oldPath: null,
          changeKind: section.kind === 'Add' ? 'added' : 'deleted',
          lines: whole.lines,
          lineNumbersKnown: true,
          truncated: whole.truncated
        })
      ]
    }
    // Keep files named by empty or headerless sections; silently dropping them would misreport a multi-file edit.
    const parsed = editLinesFromUnifiedPatch(body, { implicitFirstHunk: true })
    return [
      finalizeEditFile({
        path: moved ?? section.path,
        oldPath: moved ? section.path : null,
        changeKind: moved ? 'renamed' : 'edited',
        lines: parsed?.lines ?? [],
        lineNumbersKnown: parsed?.lineNumbersKnown ?? false,
        truncated: parsed?.truncated ?? false
      })
    ]
  })
}
