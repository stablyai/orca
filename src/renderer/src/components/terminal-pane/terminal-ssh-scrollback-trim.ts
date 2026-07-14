import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { TERMINAL_TAB_COLD_PARK_DELAY_MS } from './terminal-hidden-view-parking'

// Scrollback rows retained for a hidden SSH terminal after the cold-park
// threshold. Large enough to cover a typical viewport (~50 rows) plus a
// short scroll; small enough to free the bulk of history filled by agent
// output (which commonly reaches the user's configured 1k–5k row limit).
export const SSH_HIDDEN_SCROLLBACK_TRIM_ROWS = 200

type TrimPaneManager = {
  getPanes(): readonly { id: number; terminal: { options: { scrollback?: number } } }[]
}

type PtyIdProvider = { getPtyId(): string | null }

// Why: these are pure helper functions (not hooks) so they can be tested
// without a React render environment and called from non-hook contexts.

export function trimHiddenSshScrollback(
  manager: TrimPaneManager,
  paneTransports: Map<number, PtyIdProvider>,
  trimRows: number
): void {
  for (const pane of manager.getPanes()) {
    const ptyId = paneTransports.get(pane.id)?.getPtyId() ?? null
    if (ptyId !== null && parseAppSshPtyId(ptyId) !== null) {
      pane.terminal.options.scrollback = trimRows
    }
  }
}

export function restoreHiddenSshScrollback(
  manager: TrimPaneManager,
  paneTransports: Map<number, PtyIdProvider>,
  configuredRows: number
): void {
  for (const pane of manager.getPanes()) {
    const ptyId = paneTransports.get(pane.id)?.getPtyId() ?? null
    if (ptyId !== null && parseAppSshPtyId(ptyId) !== null) {
      // Only bump up — never reduce a scrollback that is already at or above
      // the configured value (e.g. the pane was never trimmed).
      if ((pane.terminal.options.scrollback ?? configuredRows) < configuredRows) {
        pane.terminal.options.scrollback = configuredRows
      }
    }
  }
}

/**
 * Bounds renderer heap for hidden SSH terminal panes by trimming their
 * xterm.js scrollback buffer after the cold-park threshold.
 *
 * SSH PTYs are ineligible for full hidden-view parking (no daemon snapshot
 * to re-hydrate from), so their xterm instances — and the complete scrollback
 * buffers they hold — stay in the renderer heap indefinitely while hidden.
 * At 1k–5k rows per terminal (the user's configured limit), a workflow with
 * several SSH tabs can push the renderer heap to 100–250 MB.
 *
 * When the tab has been hidden for longer than coldParkDelayMs (default 30s,
 * matching the parking hysteresis), all SSH panes have their scrollback
 * trimmed to SSH_HIDDEN_SCROLLBACK_TRIM_ROWS. On reveal the buffer is
 * restored to configuredScrollbackRows so new output can fill it again.
 * History beyond SSH_HIDDEN_SCROLLBACK_TRIM_ROWS is lost on trim — the same
 * trade-off full parking already accepts for local panes.
 */
export function useHiddenSshScrollbackTrim(args: {
  managerRef: RefObject<TrimPaneManager | null>
  paneTransportsRef: RefObject<Map<number, PtyIdProvider>>
  isVisible: boolean
  configuredScrollbackRows: number
  coldParkDelayMs?: number
}): void {
  const { isVisible, configuredScrollbackRows, coldParkDelayMs, managerRef, paneTransportsRef } =
    args
  const trimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isVisible) {
      // Tab revealed: cancel any pending trim and restore SSH panes to the
      // configured depth so the buffer can grow normally from this point.
      if (trimTimerRef.current !== null) {
        clearTimeout(trimTimerRef.current)
        trimTimerRef.current = null
      }
      const manager = managerRef.current
      if (manager) {
        restoreHiddenSshScrollback(manager, paneTransportsRef.current, configuredScrollbackRows)
      }
      return
    }

    // Tab hidden: schedule a scrollback trim after the cold-park delay.
    // Mirrors the cold-park hysteresis so a quick tab flip never trims.
    const delay = coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS
    trimTimerRef.current = setTimeout(() => {
      trimTimerRef.current = null
      const manager = managerRef.current
      if (manager) {
        trimHiddenSshScrollback(manager, paneTransportsRef.current, SSH_HIDDEN_SCROLLBACK_TRIM_ROWS)
      }
    }, delay)

    return (): void => {
      if (trimTimerRef.current !== null) {
        clearTimeout(trimTimerRef.current)
        trimTimerRef.current = null
      }
    }
    // Why: managerRef and paneTransportsRef are stable React refs whose
    // identity never changes — including them would make deps harder to read
    // without affecting correctness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, configuredScrollbackRows, coldParkDelayMs])
}
