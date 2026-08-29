import { toast } from 'sonner'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from './worktree-activation'
import { activateStructuredAgentSessionById } from './structured-agent-session-tab-activation'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync'

const STRUCTURED_SESSION_RESTORE_TIMEOUT_MS = 5_000

type StructuredSessionActivationDeps = {
  activate: typeof activateStructuredAgentSessionById
  refresh: (worktreeId: string) => Promise<void>
  unavailable: () => void
}

const defaultDeps: StructuredSessionActivationDeps = {
  activate: activateStructuredAgentSessionById,
  refresh: refreshStructuredSessionTabs,
  unavailable: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.unavailable',
        'The structured agent session is not available yet. Retry in a moment.'
      )
    )
  }
}

export async function activateAiVaultStructuredSession(
  session: AiVaultSession,
  deps: StructuredSessionActivationDeps = defaultDeps
): Promise<boolean> {
  const structured = session.structuredSession
  if (!structured) {
    return false
  }
  const target = { worktreeId: structured.workspaceId, sessionId: structured.sessionId }
  if (!deps.activate(target)) {
    try {
      await deps.refresh(structured.workspaceId)
    } catch {
      deps.unavailable()
      return true
    }
    if (!deps.activate(target)) {
      deps.unavailable()
      return true
    }
  }
  if (useAppStore.getState().activeWorktreeId !== structured.workspaceId) {
    activateAndRevealWorktree(structured.workspaceId)
  }
  return true
}

async function refreshStructuredSessionTabs(worktreeId: string): Promise<void> {
  const state = useAppStore.getState()
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  const snapshot = await withStructuredSessionRestoreTimeout(
    callRuntimeRpc<RuntimeMobileSessionTabsResult>(
      getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
      'session.tabs.list',
      { worktree: toRuntimeWorktreeSelector(worktreeId) },
      { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
    )
  )
  applyStructuredSessionTabSnapshots(
    [snapshot],
    environmentId ? `structured-session:${environmentId}` : undefined
  )
}

async function withStructuredSessionRestoreTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('structured_session_restore_timeout')),
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
