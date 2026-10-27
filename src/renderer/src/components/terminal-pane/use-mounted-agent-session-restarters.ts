import { useEffect } from 'react'
import { subscribeMountedTerminalTabChanges } from '@/runtime/mounted-terminal-tab-registry'
import { registerMountedAgentSessionRestart } from '@/lib/agent-session-restart-mounted'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport-types'

type Restart = (
  paneId: number,
  startup: PtyConnectionDeps['startup'],
  options: { focus: boolean }
) => void

export function useMountedAgentSessionRestarters(
  controller: {
    managerRef: {
      readonly current: {
        getPanes: () => Pick<ManagedPane, 'id' | 'leafId' | 'container'>[]
      } | null
    }
    paneTransportsRef: { readonly current: ReadonlyMap<number, Pick<PtyTransport, 'getPtyId'>> }
    savedLayout: Pick<TerminalPaneCloseController['savedLayout'], 'ptyIdsByLeafId'>
  },
  restart: Restart
): void {
  const { managerRef, paneTransportsRef, savedLayout } = controller
  useEffect(() => {
    let disposed = false
    let scheduled = false
    let unregister: (() => void)[] = []
    const refresh = (): void => {
      if (scheduled || disposed) {
        return
      }
      scheduled = true
      // PaneManager is created by a later passive mount effect; layout effects see a null ref.
      queueMicrotask(() => {
        scheduled = false
        if (disposed) {
          return
        }
        for (const release of unregister) {
          release()
        }
        unregister = []
        for (const pane of managerRef.current?.getPanes() ?? []) {
          const ptyId =
            paneTransportsRef.current.get(pane.id)?.getPtyId() ??
            pane.container.dataset.ptyId ??
            savedLayout.ptyIdsByLeafId?.[pane.leafId]
          if (!ptyId) {
            continue
          }
          unregister.push(
            registerMountedAgentSessionRestart(ptyId, (startup) => {
              const current = managerRef.current
                ?.getPanes()
                .find(
                  (candidate) =>
                    candidate.id === pane.id &&
                    candidate.leafId === pane.leafId &&
                    candidate.container === pane.container
                )
              const bound =
                paneTransportsRef.current.get(pane.id)?.getPtyId() ??
                current?.container.dataset.ptyId
              if (!current || bound !== ptyId) {
                return false
              }
              restart(pane.id, startup, { focus: false })
              return true
            })
          )
        }
      })
    }
    const unsubscribe = subscribeMountedTerminalTabChanges(refresh)
    refresh()
    return () => {
      disposed = true
      unsubscribe()
      for (const release of unregister) {
        release()
      }
    }
  }, [managerRef, paneTransportsRef, savedLayout.ptyIdsByLeafId, restart])
}
