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
import { readLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const STRUCTURED_SESSION_RESTORE_TIMEOUT_MS = 5_000

type StructuredSessionActivationDeps = {
  activate: typeof activateStructuredAgentSessionById
  refresh: (worktreeId: string) => Promise<void>
  reveal: (target: { worktreeId: string; sessionId: string }) => Promise<boolean>
  unavailable: () => void
  gone: () => void
}

const defaultDeps: StructuredSessionActivationDeps = {
  activate: activateStructuredAgentSessionById,
  refresh: refreshStructuredSessionTabs,
  reveal: revealStructuredSession,
  unavailable: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.unavailable',
        'The structured agent session is not available yet. Retry in a moment.'
      )
    )
  },
  // Why a second message: once reveal exists, a miss is no longer a timing problem the user can
  // wait out, so telling them to retry sends them in a circle.
  gone: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.gone',
        'This chat is no longer on this host, so it cannot be reopened here.'
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
      // The inventory genuinely does not carry this chat: it was closed, or this process never
      // published it. Ask the host to republish the tab from the record it still holds on disk.
      if (!(await deps.reveal(target))) {
        deps.gone()
        return true
      }
      await deps.refresh(structured.workspaceId).catch(() => undefined)
      if (!deps.activate(target)) {
        deps.unavailable()
        return true
      }
    }
  }
  if (useAppStore.getState().activeWorktreeId !== structured.workspaceId) {
    activateAndRevealWorktree(structured.workspaceId)
  }
  return true
}

/**
 * Ask the host to republish a persisted chat's tab.
 *
 * False means "do not keep waiting": either this host cannot answer the call at all, or it answered
 * that the chat is gone. Both are terminal for this click, and neither is worth a retry.
 */
async function revealStructuredSession(target: {
  worktreeId: string
  sessionId: string
}): Promise<boolean> {
  // Negotiated rather than discovered by calling: an older host has no `agentSession.reveal`, and
  // its method-not-found is indistinguishable from a refusal this client should surface.
  if (!readLocalRuntimeCapabilities().includes(STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY)) {
    return false
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(
    useAppStore.getState(),
    target.worktreeId
  )
  try {
    const result = await withStructuredSessionRestoreTimeout(
      callRuntimeRpc<{ ok?: boolean }>(
        getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
        'agentSession.reveal',
        { sessionId: target.sessionId },
        { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
      )
    )
    return result?.ok === true
  } catch {
    return false
  }
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
