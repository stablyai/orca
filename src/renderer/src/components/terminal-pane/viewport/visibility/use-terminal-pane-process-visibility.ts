import { useEffect } from 'react'
import type { IDisposable } from '@xterm/xterm'
import {
  getPreviousVisibleForTerminalPane,
  isTerminalPaneVisibilityResume
} from '../pane-visibility-identity'
import {
  reconcileMissingSessions,
  type ReconcilableBinding
} from '../../terminal-dead-session-reconcile'
import type { UseTerminalPaneLifecycleDeps } from '../../mounting/terminal-pane-lifecycle-types'
import type { TerminalPaneLifecycleRefs } from '../../mounting/use-terminal-pane-lifecycle-refs'

type IDisposableWithVisibility = IDisposable & {
  syncProcessTracking?: () => void
  noteVisibilityResume?: () => void
}

export function useTerminalPaneProcessVisibility(
  deps: Pick<
    UseTerminalPaneLifecycleDeps,
    'tabId' | 'cwd' | 'isVisible' | 'isVisibleRef' | 'panePtyBindingsRef'
  >,
  refs: Pick<TerminalPaneLifecycleRefs, 'previousVisibleForReconcileRef'>
): void {
  useEffect(() => {
    const previousIsVisible = getPreviousVisibleForTerminalPane({
      previous: refs.previousVisibleForReconcileRef.current,
      tabId: deps.tabId,
      cwd: deps.cwd
    })
    refs.previousVisibleForReconcileRef.current = {
      tabId: deps.tabId,
      cwd: deps.cwd,
      isVisible: deps.isVisible
    }
    deps.isVisibleRef.current = deps.isVisible
    const resumedFromHidden = isTerminalPaneVisibilityResume({
      previousIsVisible,
      isVisible: deps.isVisible
    })
    for (const panePtyBinding of deps.panePtyBindingsRef.current.values()) {
      // SAFETY: Bindings expose optional visibility methods alongside their disposable contract.
      const binding = panePtyBinding as IDisposableWithVisibility
      binding.syncProcessTracking?.()
      if (resumedFromHidden) {
        binding.noteVisibilityResume?.()
      }
    }
    if (resumedFromHidden && typeof window.api.pty.hasPty === 'function') {
      reconcileMissingSessions({
        // SAFETY: Reconciliation checks optional session methods on these same live bindings.
        bindings: deps.panePtyBindingsRef.current.values() as Iterable<ReconcilableBinding>,
        hasPty: window.api.pty.hasPty
      })
    }
  }, [
    deps.cwd,
    deps.isVisible,
    deps.isVisibleRef,
    deps.panePtyBindingsRef,
    deps.tabId,
    refs.previousVisibleForReconcileRef
  ])
}
