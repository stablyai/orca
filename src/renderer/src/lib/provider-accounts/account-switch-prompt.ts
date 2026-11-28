// The question an account switch asks about terminals still running an agent on the account it
// left, shared by every agent whose terminals restart onto the selected account.

import { useAppStore } from '@/store/index'

export type AccountSwitchSessionCandidate = {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
}

export type AccountSwitchPromptSessions = {
  /** On the account being left; `reason` says what its restart does differently. */
  onAccount: (AccountSwitchSessionCandidate & { reason?: string })[]
  /** On another account, which a restart could also move. */
  elsewhere: (AccountSwitchSessionCandidate & { accountLabel: string })[]
  cantMove: (AccountSwitchSessionCandidate & { reason: string })[]
}

export type AccountSwitchPrompt = {
  id: number
  sessions: AccountSwitchPromptSessions
  /** Opened from the restart toast: the outgoing account's sessions are already restarting. */
  review?: true
  previousAccountLabel: string
  nextAccountLabel: string
}

export type AccountSwitchPromptAnswer = (
  answer: 'restart' | 'keep',
  options?: {
    /** The sessions the user ticked; every listed session when absent. */
    ptyIds?: readonly string[]
    dontAskAgain?: boolean
  }
) => void

/** One open question at a time, which a dialog subscribes to. */
export function createAccountSwitchPromptStore<P extends AccountSwitchPrompt>() {
  let prompt: P | null = null
  const listeners = new Set<() => void>()
  return {
    get: (): P | null => prompt,
    set: (next: P | null): void => {
      prompt = next
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/** Why now: a reattach can rebind a pane while the dialog is open, and a closed pane has none. */
export function currentPtyIds(sessions: readonly AccountSwitchSessionCandidate[]): string[] {
  const layouts = useAppStore.getState().terminalLayoutsByTabId
  return sessions.flatMap((session) => {
    const ptyId = layouts[session.tabId]?.ptyIdsByLeafId?.[session.leafId]
    return ptyId ? [ptyId] : []
  })
}

/** The listed sessions an answer restarts: the ticked ones, or all of them when none were named. */
export function pickedSwitchSessions(
  sessions: AccountSwitchPromptSessions,
  chosen: readonly string[] | undefined
): AccountSwitchSessionCandidate[] {
  // Why filtered: only sessions this question listed may restart.
  const listed = [...sessions.onAccount, ...sessions.elsewhere]
  return chosen ? listed.filter((session) => chosen.includes(session.ptyId)) : listed
}
