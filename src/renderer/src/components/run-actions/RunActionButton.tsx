import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import {
  openWorkspacePortInBrowser,
  refreshWorkspacePortScanAfterStop,
  workspacePortScanKeyForTarget
} from '@/lib/workspace-ports/workspace-port-actions'
import { useTranslate } from '@/i18n/use-translate'
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
import { findLiveRunTabId } from '@/lib/run-actions/run-action-tabs'

const EMPTY_PORTS: WorkspacePort[] = []

/** Reloads on workspace switch and window focus, so an orca.yaml edit shows up without a restart. */
function useWorktreeRunActions(worktreeId: string): WorktreeRunActions | null {
  const [config, setConfig] = useState<{ worktreeId: string; value: WorktreeRunActions } | null>(
    null
  )
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void loadWorktreeRunActions(worktreeId, { background: true })
        .then((value) => {
          if (!cancelled && value) {
            setConfig({ worktreeId, value })
          }
        })
        // A workspace that can't be resolved yet simply shows no Run button.
        .catch(() => {})
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
          s.workspacePortScansByKey?.[workspacePortScanKeyForTarget(target)]
        ).get(worktreeId) ?? EMPTY_PORTS)
      : EMPTY_PORTS
  )
}

function focusRunTab(run: RunActionRun): void {
  const state = useAppStore.getState()
  state.setActiveTabType('terminal', run.worktreeId)
  state.setActiveTab(findLiveRunTabId(state, run.worktreeId, run.tabId) ?? run.tabId)
}

/** "Web stopped" / "Web failed" when a run ends; the view reads it out through a polite live region. */
function useRunEndAnnouncement(runs: Record<string, RunActionRun>): string | null {
  const t = useTranslate()
  const previous = useRef<Record<string, RunActionRun>>(runs)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    for (const run of Object.values(runs)) {
      const before = previous.current[run.actionId]?.status
      if (before !== run.status && (before === 'running' || before === 'stopping')) {
        const name = { name: run.actionName }
        if (run.status === 'stopped') {
          setMessage(t('runActions.announceStopped', '{{name}} stopped', name))
        } else if (run.status === 'failed') {
          setMessage(t('runActions.announceFailed', '{{name}} failed', name))
        } else if (run.status === 'exited') {
          setMessage(t('runActions.announceFinished', '{{name}} finished', name))
        }
      }
    }
    previous.current = runs
  }, [runs, t])
  return message
}

/** A run that just ended freed its ports: rescan now so the menu and Ports panel don't show them. */
function useRescanPortsWhenRunsEnd(worktreeId: string, runs: Record<string, RunActionRun>): void {
  const target = useWorktreeRuntimeTarget(worktreeId)
  const liveCount = Object.values(runs).filter(
    (run) => run.status === 'running' || run.status === 'stopping'
  ).length
  const previousLive = useRef(liveCount)
  useEffect(() => {
    const ended = liveCount < previousLive.current
    previousLive.current = liveCount
    if (!ended || !target) {
      return
    }
    const state = useAppStore.getState()
    void refreshWorkspacePortScanAfterStop({
      runtimeTarget: target,
      replaceWorkspacePortScans: state.replaceWorkspacePortScans,
      getWorkspacePortScansByKey: () => useAppStore.getState().workspacePortScansByKey,
      setWorkspacePortScanRefreshing: state.setWorkspacePortScanRefreshing
    }).catch(() => {})
  }, [liveCount, target])
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
  const announcement = useRunEndAnnouncement(runs)
  useRescanPortsWhenRunsEnd(worktreeId, runs)
  const target = useWorktreeRuntimeTarget(worktreeId)
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
      announcement={announcement}
      onOpenPorts={openPortsPanel}
      onOpenPortInBrowser={(port) => {
        const state = useAppStore.getState()
        void openWorkspacePortInBrowser({
          port,
          runtimeTarget: target,
          createBrowserTab: state.createBrowserTab,
          setRemoteBrowserPageHandle: state.setRemoteBrowserPageHandle
        })
      }}
    />
  )
}
