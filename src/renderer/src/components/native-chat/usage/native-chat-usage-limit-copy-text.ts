// Plain-text "Copy error" for a usage-limit row, bounded so a huge provider frame can't flood the clipboard.

/** Upper bound on the copied text, in UTF-16 code units (JavaScript string length). */
export const USAGE_LIMIT_COPY_CAP = 64_000

/** Fixed fields are short by nature; their caps keep the shared budget for detail and the frame head. */
const FIXED_CAPS = {
  sentence: 2_000,
  provider: 120,
  summary: 240,
  providerNote: 400,
  copyNote: 400
} as const

const SECTION_SEPARATOR = '\n\n'

export type UsageLimitCopyInput = {
  /** The row's accessible summary: the agent's limit sentence plus its status. */
  sentence: string
  detail?: string
  frame?: {
    provider: string
    summary: string
    head: string
    /** The provider-truncation sentence; present only when the provider frame was truncated. */
    truncatedNote?: string
  }
  /** Says this copy was shortened; appended only when something was cut here. */
  copyNote: string
}

/** Cuts to at most `max` units, ending in an ellipsis and never splitting a surrogate pair. */
function clip(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) {
    return { text, cut: false }
  }
  if (max <= 0) {
    return { text: '', cut: true }
  }
  let kept = text.slice(0, max - 1)
  const last = kept.charCodeAt(kept.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) {
    kept = kept.slice(0, -1)
  }
  return { text: `${kept}…`, cut: true }
}

type Fixed = {
  sentence: string
  frame?: { id: string; truncated: boolean; note?: string }
}

function assemble(
  fixed: Fixed,
  detail: string | undefined,
  head: string,
  copyNote: string | null
): string {
  const sections = [fixed.sentence]
  if (detail !== undefined) {
    sections.push(detail)
  }
  if (fixed.frame) {
    const { id, truncated, note } = fixed.frame
    sections.push(`${id}\n${head}${truncated ? '\n…' : ''}${note ? `\n${note}` : ''}`)
  }
  if (copyNote !== null) {
    sections.push(copyNote)
  }
  return sections.join(SECTION_SEPARATOR)
}

export function usageLimitCopyText(input: UsageLimitCopyInput): string {
  const sentence = clip(input.sentence, FIXED_CAPS.sentence)
  const provider = input.frame ? clip(input.frame.provider, FIXED_CAPS.provider) : null
  const summary = input.frame ? clip(input.frame.summary, FIXED_CAPS.summary) : null
  const providerNote = input.frame?.truncatedNote
    ? clip(input.frame.truncatedNote, FIXED_CAPS.providerNote)
    : null
  const fixed: Fixed = {
    sentence: sentence.text,
    ...(input.frame
      ? {
          frame: {
            id: `${provider!.text} · ${summary!.text}`,
            truncated: input.frame.truncatedNote !== undefined,
            ...(providerNote ? { note: providerNote.text } : {})
          }
        }
      : {})
  }
  // An empty detail is absent; a present one keeps its section (and separator) even when cut to nothing.
  const detail = input.detail ? input.detail : undefined
  const head = input.frame?.head ?? ''
  const fixedCut = sentence.cut || !!provider?.cut || !!summary?.cut || !!providerNote?.cut
  const whole = assemble(fixed, detail, head, null)
  if (!fixedCut && whole.length <= USAGE_LIMIT_COPY_CAP) {
    return whole
  }
  const copyNote = clip(input.copyNote, FIXED_CAPS.copyNote).text
  const available = Math.max(
    0,
    USAGE_LIMIT_COPY_CAP -
      assemble(fixed, detail === undefined ? undefined : '', '', copyNote).length
  )
  const detailLength = detail?.length ?? 0
  let headShare = Math.min(
    head.length,
    Math.max(Math.floor(available / 2), available - detailLength)
  )
  const detailShare = Math.min(detailLength, available - headShare)
  headShare = Math.min(head.length, available - detailShare)
  return assemble(
    fixed,
    detail === undefined ? undefined : clip(detail, detailShare).text,
    clip(head, headShare).text,
    copyNote
  )
}
