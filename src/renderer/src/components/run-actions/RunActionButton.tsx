import React, { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import { workspacePortScanKeyForTarget } from '@/lib/workspace-ports/workspace-port-actions'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-ports/workspace-port-groups'
import {
  loadWorktreeRunActions,
  pickPrimaryRunAction,
  type WorktreeRunActions
} from '@/lib/run-actions/run-action-config'
import { startRunAction, stopRunAction } from '@/lib/run-actions/run-action-controller'
import { useWorktreeRunActionRuns, type RunActionRun } from '@/lib/run-actions/run-actions-store'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { RunActionButtonView } from './RunActionButtonView'

const EMPTY_PORTS: WorkspacePort[] = []

/** Reloads on workspace switch and window focus, so an orca.yaml edit shows up without a restart. */
function useWorktreeRunActions(worktreeId: string): WorktreeRunActions | null {
  const [config, setConfig] = useState<{ worktreeId: string; value: WorktreeRunActions } | null>(
    null
  )
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void loadWorktreeRunActions(worktreeId, { background: true }).then((value) => {
        if (!cancelled && value) {
          setConfig({ worktreeId, value })
        }
      })
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      cancelled = true
      window.removeEventListener('focus', load)
    }
  }, [worktreeId])
  return config && config.worktreeId === worktreeId ? config.value : null
}

function useWorktreePorts(worktreeId: string): WorkspacePort[] {
  const target = useWorktreeRuntimeTarget(worktreeId)
  return useAppStore((s) =>
    target
      ? (getWorkspacePortsByWorktreeId(
          s.workspacePortScansByKey[workspacePortScanKeyForTarget(target)]
        ).get(worktreeId) ?? EMPTY_PORTS)
      : EMPTY_PORTS
  )
}

function focusRunTab(run: RunActionRun): void {
  const state = useAppStore.getState()
  state.setActiveTabType('terminal', run.worktreeId)
  state.setActiveTab(run.tabId)
}

function openPortsPanel(): void {
  const state = useAppStore.getState()
  state.setRightSidebarOpen(true)
  state.setRightSidebarTab('ports')
}

/** The workspace's Run button; renders nothing when the project defines no run actions. */
export function RunActionButton({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const config = useWorktreeRunActions(worktreeId)
  const runs = useWorktreeRunActionRuns(worktreeId)
  const ports = useWorktreePorts(worktreeId)
  const shortcut = useShortcutLabel('workspace.run')
  const primary = useMemo(
    () => (config ? pickPrimaryRunAction(worktreeId, config.actions) : null),
    // Runs change which action is primary (the last one started).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, worktreeId, runs]
  )
  if (!config || !primary) {
    return null
  }
  return (
    <RunActionButtonView
      actions={config.actions}
      primary={primary}
      runs={runs}
      ports={ports}
      shortcut={shortcut || null}
      onRun={(action) => void startRunAction(worktreeId, action, config)}
      onStop={(action) => void stopRunAction(worktreeId, action.id)}
      onShowOutput={focusRunTab}
      onOpenPorts={openPortsPanel}
    />
  )
}
