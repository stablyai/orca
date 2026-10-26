import { useAppStore } from '@/store'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionOwnerForTab
} from '@/runtime/structured-agent-session-owner'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useVoiceSidebarSessions, type VoiceSessionEntry } from './voice-sidebar-state'

export function useVoiceSidebarWorkspace() {
  const worktreeId = useAppStore((s) => s.activeWorktreeId)
  const tab = useAppStore((s) => {
    const active = worktreeId ? s.getActiveTab(worktreeId) : null
    return active?.contentType === 'agent-session' && active.agentSessionAgent === 'codex'
      ? active
      : null
  })
  const executionHostId = useAppStore((s) =>
    tab
      ? structuredAgentSessionOwnerForTab(s, tab)
      : worktreeId
        ? resolveStructuredAgentSessionOwner(s, worktreeId)
        : null
  )
  const key = worktreeId && executionHostId ? JSON.stringify([executionHostId, worktreeId]) : null
  const entry = useVoiceSidebarSessions((s) => (key ? s.entries[key] : undefined))
  return { worktreeId, executionHostId, key, entry, tab }
}

export async function createVoiceSidebarSession(
  key: string,
  worktreeId: string,
  executionHostId: ExecutionHostId
): Promise<void> {
  const existing = useVoiceSidebarSessions.getState().entries[key]
  if (existing?.status === 'opening') {
    return
  }
  const update = (entry: VoiceSessionEntry) =>
    useVoiceSidebarSessions.setState((s) => ({
      entries: { ...s.entries, [key]: entry }
    }))
  update({ status: 'opening' })
  try {
    const plan = planAgentSessionLaunch(useAppStore.getState(), {
      requestId: newAgentLaunchRequestId(),
      agent: 'codex',
      requestedSurface: 'chat',
      selectedExecutionHostId: executionHostId,
      workspace: worktreeLaunchWorkspace(worktreeId)
    })
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      activate: true,
      hooks: { activate: true }
    })
    const result = await launch?.settlement
    if (result?.kind === 'structured' || result?.kind === 'visibility-unknown') {
      update({
        status: 'ready',
        session: {
          sessionId: result.sessionId,
          tabId: structuredAgentSessionTabId(result.sessionId),
          executionHostId
        }
      })
    } else {
      update({ status: 'failed' })
    }
  } catch {
    update({ status: 'failed' })
  }
}
