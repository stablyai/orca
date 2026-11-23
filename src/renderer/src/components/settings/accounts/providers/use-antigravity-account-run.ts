import { useRef, useState, type RefObject } from 'react'
import type { AntigravityAccountAction } from './AntigravityTerminalAccountRows'

type PerformAccountAction = (
  action: AntigravityAccountAction,
  accountId: string | undefined,
  keepShown: boolean
) => Promise<void>

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

  async function run(action: AntigravityAccountAction, accountId?: string, keepShown = false) {
    if (pending.current) {
      // A click is only possible during a background re-read, which leaves the rows enabled.
      if (!keepShown) {
        queuedClick.current = { action, accountId }
        setBusy(true)
      }
      rereadQueued.current ||= keepShown && action === 'List'
      return
    }
    pending.current = true
    if (!keepShown) {
      setBusy(true)
    }
    try {
      await perform(action, accountId, keepShown)
    } finally {
      pending.current = false
      if (mounted.current) {
        setBusy(false)
      }
      const click = queuedClick.current
      queuedClick.current = null
      if (click && mounted.current) {
        void run(click.action, click.accountId)
      } else if (rereadQueued.current && mounted.current) {
        rereadQueued.current = false
        void run('List', undefined, true)
      }
    }
  }

  return { busy, pending, run }
}
