// Main owns agent resume; show its published restored/unavailable outcome once per terminal start.

import { useAppStore } from '@/store'
import type { TerminalPaneResumeOutcome } from '@/store/terminals/terminal-state'
import { mainStartsPane } from './main-starts-pane'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { PtyConnectResult } from '../pty-transport-types'

type Outcomes = Record<string, TerminalPaneResumeOutcome>

// Why session storage: a reload reattaches the same start, which showed its banner already.
const SHOWN_STARTS_KEY = 'orca.mainPaneResumeBannersShown'
/** This document's shown starts, for when session storage is unavailable. */
const shownHere = new Set<string>()

const startOf = ({ ptyId, ptyGeneration }: TerminalPaneResumeOutcome): string =>
  `${ptyId}#${ptyGeneration ?? ''}`

function readShownStarts(): string[] {
  try {
    const stored: unknown = JSON.parse(globalThis.sessionStorage.getItem(SHOWN_STARTS_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((key) => typeof key === 'string') : []
  } catch {
    return []
  }
}

/** Notes `start` as shown, keeping only starts main still publishes; false if it was already. */
function noteShown(start: string, outcomes: Outcomes): boolean {
  const shown = readShownStarts()
  if (shownHere.has(start) || shown.includes(start)) {
    return false
  }
  shownHere.add(start)
  const live = new Set(Object.values(outcomes).map(startOf))
  try {
    globalThis.sessionStorage.setItem(
      SHOWN_STARTS_KEY,
      JSON.stringify([...shown.filter((key) => live.has(key)), start])
    )
  } catch {
    // Best effort: without storage a reload may show the banner once more.
  }
  return true
}

/** Capture attach-time resume evidence: the window’s own result, or main’s restored outcome for the bound terminal published since attach began. */
export function attachResumeCheck(
  session: ConnectPanePtySession,
  windowResume: ColdRestoreAgentResumeStartup | null
): (ptyId: string, connected?: PtyConnectResult | string | void) => boolean {
  const outcomeNow = (): TerminalPaneResumeOutcome | undefined =>
    useAppStore.getState().terminalPaneResumeOutcomesByPaneKey[session.cacheKey]
  const mainStarts = !windowResume && mainStartsPane(session)
  const before = mainStarts ? outcomeNow() : undefined
  return (ptyId, connected) => {
    const result = typeof connected === 'object' && connected !== null ? connected : null
    if (!mainStarts) {
      return Boolean(windowResume) && !result?.agentResumeUnavailable
    }
    const attached = result?.id ?? ptyId
    const found = outcomeNow()
    return (
      found?.ptyId === attached &&
      found.outcome === 'restored' &&
      (before === undefined || startOf(before) !== startOf(found))
    )
  }
}

/** Show main’s start outcome once after attach; its binding frame precedes the reply on ordered IPC and applies before the reply settles. */
export function showMainPaneResumeOutcome(session: ConnectPanePtySession, ptyId: string): void {
  if (!mainStartsPane(session)) {
    return
  }
  const outcomes = useAppStore.getState().terminalPaneResumeOutcomesByPaneKey
  const found = outcomes[session.cacheKey]
  if (found?.ptyId === ptyId && noteShown(startOf(found), outcomes)) {
    session.showSessionRestoredBanner(found.outcome)
  }
}
