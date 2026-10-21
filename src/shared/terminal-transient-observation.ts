import { parseTerminalGitHubPRUrl } from './terminal-github-pr-link-detector'

export const TERMINAL_TRANSIENTS_CAPABILITY = 'terminal-transients-v1'
export const isTerminalSubscriptionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)

export type TerminalTransientFact =
  | { kind: 'command-started' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'bell' }
  | { kind: 'pr-link'; url: string }
  | { kind: '2031-subscribe' }
  | { kind: '2031-unsubscribe' }

export type TerminalTransientCurrent = {
  command: 'unseen' | 'running' | 'prompt' | 'uncertain'
  commandRevision: number
  mode2031: 'unknown' | 'subscribed' | 'unsubscribed'
  modeRevision: number
}

export type TerminalTransientObservation = {
  revision: number
  rawEndSeq: number
} & (
  | { kind: 'install'; current: TerminalTransientCurrent }
  | {
      kind: 'observation'
      fact: TerminalTransientFact
    }
)

export type TerminalTransientSink = {
  install: (
    current: TerminalTransientObservation,
    incarnationId: string,
    readCurrent: () => TerminalTransientObservation
  ) => void
  stage: (observation: TerminalTransientObservation) => void
  commit: () => void
  dispose?: () => void
}

export function isTerminalTransientObservation(
  value: unknown
): value is TerminalTransientObservation {
  if (
    !value ||
    typeof value !== 'object' ||
    !('revision' in value) ||
    !('rawEndSeq' in value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !Number.isSafeInteger(value.rawEndSeq) ||
    Number(value.rawEndSeq) < 0
  ) {
    return false
  }
  if ('kind' in value && value.kind === 'install' && 'current' in value) {
    const state = value.current
    return Boolean(
      state &&
      typeof state === 'object' &&
      'command' in state &&
      typeof state.command === 'string' &&
      ['unseen', 'running', 'prompt', 'uncertain'].includes(state.command) &&
      'mode2031' in state &&
      typeof state.mode2031 === 'string' &&
      ['unknown', 'subscribed', 'unsubscribed'].includes(state.mode2031) &&
      'commandRevision' in state &&
      Number.isSafeInteger(state.commandRevision) &&
      Number(state.commandRevision) >= 0 &&
      Number(state.commandRevision) <= Number(value.revision) &&
      'modeRevision' in state &&
      Number.isSafeInteger(state.modeRevision) &&
      Number(state.modeRevision) >= 0 &&
      Number(state.modeRevision) <= Number(value.revision)
    )
  }
  if (!('kind' in value) || value.kind !== 'observation' || !('fact' in value)) {
    return false
  }
  const fact = value.fact
  if (!fact || typeof fact !== 'object' || !('kind' in fact)) {
    return false
  }
  switch (fact.kind) {
    case 'command-started':
    case 'bell':
    case '2031-subscribe':
    case '2031-unsubscribe':
      return true
    case 'command-finished':
      return 'exitCode' in fact && (fact.exitCode === null || Number.isSafeInteger(fact.exitCode))
    case 'pr-link':
      return (
        'url' in fact &&
        typeof fact.url === 'string' &&
        fact.url.length <= 2048 &&
        parseTerminalGitHubPRUrl(fact.url) !== null
      )
    default:
      return false
  }
}
