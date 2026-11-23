import { useRef, useState, type RefObject } from 'react'
import type { AntigravityAccountAction } from './AntigravityTerminalAccountRows'

type PerformAccountAction = (
  action: AntigravityAccountAction,
  accountId: string | undefined,
  keepShown: boolean
) => Promise<void>

type AccountRunState = {
  perform: PerformAccountAction
  mounted: RefObject<boolean>
  pending: RefObject<boolean>
  rereadQueued: RefObject<boolean>
  queuedClick: RefObject<{ action: AntigravityAccountAction; accountId?: string } | null>
  setBusy: (busy: boolean) => void
}

// Why module scope: React Compiler cannot compile a component-scoped function that calls itself.
function runAccountAction(
  state: AccountRunState,
  action: AntigravityAccountAction,
  accountId?: string,
  keepShown = false
): Promise<void> {
  if (state.pending.current) {
    // A click is only possible during a background re-read, which leaves the rows enabled.
    if (!keepShown) {
      state.queuedClick.current = { action, accountId }
      state.setBusy(true)
    }
    if (keepShown && action === 'List') {
      state.rereadQueued.current = true
    }
    return Promise.resolve()
  }
  state.pending.current = true
  if (!keepShown) {
    state.setBusy(true)
  }
  return state.perform(action, accountId, keepShown).finally(() => {
    state.pending.current = false
    if (state.mounted.current) {
      state.setBusy(false)
    }
    const click = state.queuedClick.current
    state.queuedClick.current = null
    if (click && state.mounted.current) {
      void runAccountAction(state, click.action, click.accountId)
    } else if (state.rereadQueued.current && state.mounted.current) {
      state.rereadQueued.current = false
      void runAccountAction(state, 'List', undefined, true)
    }
  })
}

/** Runs one account action at a time. A click made while another action is in flight shows the
 *  rows busy and runs once it ends; a background re-read asked for meanwhile runs after that.
 *  `keepShown`: a background re-read, which leaves the rows enabled. */
export function useAntigravityAccountRun(
  perform: PerformAccountAction,
  mounted: RefObject<boolean>
): {
  busy: boolean
  pending: RefObject<boolean>
  run: (action: AntigravityAccountAction, accountId?: string, keepShown?: boolean) => Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const rereadQueued = useRef(false)
  const queuedClick = useRef<{ action: AntigravityAccountAction; accountId?: string } | null>(null)

  function run(action: AntigravityAccountAction, accountId?: string, keepShown = false) {
    return runAccountAction(
      { perform, mounted, pending, rereadQueued, queuedClick, setBusy },
      action,
      accountId,
      keepShown
    )
  }

  return { busy, pending, run }
}
