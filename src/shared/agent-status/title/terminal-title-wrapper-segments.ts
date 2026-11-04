import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'

export const WRAPPER_SEPARATOR = ' | '

/** Check whole-to-innermost titles so wrapper prefixes such as zsh | do not hide an anchored pane identity. */
export function getWrapperTitleSegments(title: string): string[] {
  const segments = [title]
  let separatorIndex = title.indexOf(WRAPPER_SEPARATOR)
  while (separatorIndex >= 0) {
    const wrapped = title.slice(separatorIndex + WRAPPER_SEPARATOR.length).trim()
    if (wrapped && !segments.includes(wrapped)) {
      segments.push(wrapped)
    }
    separatorIndex = title.indexOf(WRAPPER_SEPARATOR, separatorIndex + WRAPPER_SEPARATOR.length)
  }
  return segments
}

/** Inspect one disjoint header, preserving shell host/cwd syntax without admitting colon task prose. */
export function isNeutralAgentTitleWrapper(header: string): boolean {
  // ASCII activity tokens include trailing whitespace, so classify before right trimming.
  const lexical = header.trimStart()
  if (stripLeadingAgentTitleDecorationOrEmpty(lexical) !== lexical) {
    return false
  }
  const trimmed = lexical.trim()
  return (
    !trimmed.includes(':') ||
    /^(?:[^\s@:[\]]+@(?:\[[^\]]+\]|[^\s:]+)|\[[^\]\s]+@[^\]\s]+\]):\s*(?:[~/]|[A-Za-z]:[\\/])/.test(
      trimmed
    ) ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  )
}
