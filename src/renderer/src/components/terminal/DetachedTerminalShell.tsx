import { useCallback, useEffect, useMemo, useState } from 'react'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import type { DetachedTerminalSnapshot } from '../../../../shared/detached-terminal-window'
import { hydrateDetachedTerminalSnapshot } from '@/store/slices/detached-terminal-hydration'
import { translate } from '@/i18n/i18n'

type ShellState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: DetachedTerminalSnapshot }
  | { status: 'unavailable' }

function getQueryIds(): { worktreeId: string | null; tabId: string | null } {
  const params = new URLSearchParams(window.location.search)
  const worktreeId = params.get('worktreeId')?.trim() || null
  const tabId = params.get('tabId')?.trim() || null
  return { worktreeId, tabId }
}

const EMPTY_PTY_IDS: string[] = []

export default function DetachedTerminalShell(): React.JSX.Element {
  const [{ worktreeId, tabId }] = useState(getQueryIds)
  const [state, setState] = useState<ShellState>({ status: 'loading' })
  const [, setExitedPtyIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!worktreeId || !tabId) {
      setState({ status: 'unavailable' })
      return
    }
    let cancelled = false
    void window.api.detachedTerminal
      .getSnapshot({ worktreeId, tabId })
      .then((snapshot) => {
        if (cancelled || snapshot.ptyIds.length === 0) {
          return
        }
        hydrateDetachedTerminalSnapshot(snapshot)
        setState({ status: 'ready', snapshot })
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'unavailable' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [tabId, worktreeId])

  const readyPtyIds = state.status === 'ready' ? state.snapshot.ptyIds : EMPTY_PTY_IDS
  const readyPtyIdSet = useMemo(() => new Set(readyPtyIds), [readyPtyIds])

  const handleDetachedPtyReady = useCallback(
    (ptyId: string) => {
      if (!worktreeId || !tabId || !readyPtyIdSet.has(ptyId)) {
        return
      }
      void window.api.detachedTerminal.rendererPtyReady({ worktreeId, tabId, ptyId })
    },
    [readyPtyIdSet, tabId, worktreeId]
  )

  const handleDetachedPtyExit = useCallback(
    (ptyId: string) => {
      setExitedPtyIds((current) => {
        const next = new Set(current)
        next.add(ptyId)
        if (readyPtyIds.length > 0 && readyPtyIds.every((id) => next.has(id))) {
          setState({ status: 'unavailable' })
        }
        return next
      })
    },
    [readyPtyIds]
  )

  const handleDetachedCloseTab = useCallback(() => {
    if (!worktreeId || !tabId) {
      return
    }
    void window.api.detachedTerminal.closeWindow({ worktreeId, tabId })
  }, [tabId, worktreeId])

  if (state.status === 'loading') {
    return (
      <div
        aria-label={translate(
          'auto.components.terminal.DetachedTerminalShell.loading',
          'Loading detached terminal'
        )}
      />
    )
  }
  if (state.status === 'unavailable') {
    return (
      <div
        aria-label={translate(
          'auto.components.terminal.DetachedTerminalShell.unavailable',
          'Detached terminal unavailable'
        )}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Why: detached windows hide native chrome, so they need a
          renderer-owned drag strip while xterm stays no-drag. */}
      <div
        data-detached-titlebar-drag
        className="titlebar shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="titlebar-traffic-light-pad" />
        <span className="truncate text-xs text-muted-foreground">
          {state.snapshot.terminalTab.title || 'Terminal'}
        </span>
      </div>
      <div className="min-h-0 flex-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <TerminalPane
          tabId={state.snapshot.terminalTab.id}
          worktreeId={state.snapshot.worktree.id}
          cwd={state.snapshot.worktree.path}
          isActive={true}
          isVisible={true}
          isWorktreeActive={true}
          onPtyExit={handleDetachedPtyExit}
          onCloseTab={handleDetachedCloseTab}
          onPtyDataSubscriptionReady={handleDetachedPtyReady}
        />
      </div>
    </div>
  )
}
