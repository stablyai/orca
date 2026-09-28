import { finalizeEditFile, type NativeChatEditFile } from './native-chat-edit-model'
import { editLinesFromUnifiedPatch, editLinesFromWholeFile } from './native-chat-unified-patch'

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/
/** Envelope structure that carries no file content of its own. */
const CONTROL_LINE = /^\*\*\* (?:End of File|Environment ID:)/

/** The envelope reaches a command tool as one of its patch or command
 *  arguments, either whole or as one word of the argument vector it runs.
 *  Recover its text. Callers must gate this on the tool being one that runs a
 *  patch: a file's own contents may quote an envelope.
 *
 *  `requireApplyCommand` is for a general command tool, where the envelope
 *  proves nothing on its own — a command writing documentation quotes one
 *  without applying it, and the command must say it is applying it. */
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
    // Without the closing marker there is nothing separating the patch body from
    // whatever the command line continues with, and trailing shell syntax would
    // render as file content the agent never wrote.
    return null
  }
  return source.slice(start, end + END.length)
}

/** The arguments that carry a patch or the command line that applies one. Only
 *  these are searched: any other value is data the tool operates on, and a file
 *  whose own contents quote an envelope would otherwise be read as a patch
 *  against some other file entirely. */
const ENVELOPE_ARGUMENTS = ['input', 'command', 'patch', 'arguments', 'script'] as const
/** What a command tool runs to apply an envelope, as opposed to quoting one.
 *  Both spellings the runner accepts, since either one really applies it. */
const APPLY_COMMAND = /apply_?patch/

/** The call payload may itself be a string holding JSON. Decoding it here, in
 *  the one consumer that needs its structure, keeps every other reader of the
 *  call input seeing exactly what the provider sent. */
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

/** A command tool's argument is a vector, so the envelope sits one level in and
 *  the words that apply it may be a different element than the envelope. */
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

  // Split on both newline forms once, so every marker below can be matched
  // exactly rather than each pattern having to tolerate a trailing `\r`.
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
    // The first chunk of an update may carry no hunk header at all, and a
    // section may carry no body either. The envelope named the file, so it is
    // reported with whatever rows it has rather than dropped from a multi-file
    // envelope with nothing to say it went missing.
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
