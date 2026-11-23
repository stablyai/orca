import { structuredAgentSessionStatusPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import { subscribeAgentSubjectReads } from '@/attention/agent-subject-read-actions'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/workspace/ownership/resolve-owner'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { toHostSessionPaneKey } from '../../../../shared/workspace-layout/terminal-surface-id'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { revealTerminalPane } from '@/lib/workspace/activation/reveal-terminal-pane'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { activateStructuredAgentSessionById } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { openExistingStructuredSession } from '@/lib/agent-session/open/open-existing-structured-session'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { NotchFocusPaneRequest } from '../../../../shared/notch/notch-snapshot'

function showUnavailable(): void {
  toast.error(translate('notch.sessionUnavailable', 'Could not open this agent session.'))
}

async function revealSession(args: NotchFocusPaneRequest): Promise<void> {
  if (!args.sessionId) {
    if (!revealTerminalPane(args)) {
      showUnavailable()
    }
    return
  }
  const target = ipcOrRuntimeTargetForHostId(args.executionHostId)
  if (!target) {
    showUnavailable()
    return
  }
  const revealWorkspace = (): boolean =>
    Boolean(activateAndRevealWorkspace(args.worktreeId, { executionHostId: args.executionHostId }))
  if (
    revealWorkspace() &&
    activateStructuredAgentSessionById({
      worktreeId: args.worktreeId,
      sessionId: args.sessionId,
      target
    })
  ) {
    return
  }
  await openExistingStructuredSession(
    { workspaceId: args.worktreeId, sessionId: args.sessionId },
    {
      target,
      initialize: revealWorkspace,
      present: (_outcome, result) => {
        if (result.kind === 'failed') {
          showUnavailable()
        }
      }
    }
  )
}

export function useNotchRevealBridge(): void {
  const hydrated = useAppStore((state) => state.hydrationSucceeded)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)

  useEffect(() => {
    window.api.notch?.setExpanded(false)
  }, [activeTabId, activeWorktreeId])

  useEffect(
    () =>
      subscribeAgentSubjectReads((reads) => {
        const state = useAppStore.getState()
        const keys = reads.map((read) => {
          const pane = parsePaneKey(read.subjectKey)
          const source = pane
            ? state.agentStatusByPaneKey.projection.mobileSource(read.subjectKey, pane.tabId)
            : null
          const target = read.structured?.target
          const environmentId =
            target?.kind === 'environment'
              ? target.environmentId
              : target?.kind === 'local'
                ? null
                : runtimeEnvironmentIdUnlessTwin(state, source?.worktreeId)
          const canonicalKey = read.structured
            ? structuredAgentSessionStatusPaneKey(read.structured.sessionId)
            : toHostSessionPaneKey(read.subjectKey)
          return environmentId
            ? `${toRuntimeExecutionHostId(environmentId)}|${canonicalKey}`
            : canonicalKey
        })
        window.api.notch?.acknowledgePanes(keys)
      }),
    []
  )

  useEffect(() => {
    if (!hydrated) {
      return
    }
    const unsubscribe = window.api.notch?.onRevealPane((args) => {
      void revealSession(args).catch(showUnavailable)
    })
    window.api.notch?.notifyRevealReady()
    return unsubscribe
  }, [hydrated])
}
