import type { AgentStatus } from './agent-title-core'

const OMP_NATIVE_STATE_RE = /(?:^| \| )\s*π\s+([:>!])(?=\s|$)/u

type OmpNativeStateMatch = {
  delimiter: string
  delimiterIndex: number
}

function getOmpNativeStateMatch(title: string): OmpNativeStateMatch | null {
  const match = OMP_NATIVE_STATE_RE.exec(title)
  const delimiter = match?.[1]
  if (delimiter === undefined || match?.index === undefined) {
    return null
  }
  return {
    delimiter,
    delimiterIndex: match.index + match[0].lastIndexOf(delimiter)
  }
}

/** Resolves the native OMP marker while treating its remaining label as opaque. */
export function getOmpNativeTitleStatus(title: string): AgentStatus | null {
  const delimiter = getOmpNativeStateMatch(title)?.delimiter
  if (delimiter === ':') {
    return 'working'
  }
  if (delimiter === '!') {
    return 'permission'
  }
  if (delimiter === '>') {
    return 'idle'
  }
  return null
}

/** Converts an authoritative native OMP working marker into an idle marker. */
export function clearOmpNativeWorkingStatus(title: string): string | null {
  const match = getOmpNativeStateMatch(title)
  if (match?.delimiter !== ':') {
    return null
  }
  return `${title.slice(0, match.delimiterIndex)}>${title.slice(match.delimiterIndex + 1)}`
}
