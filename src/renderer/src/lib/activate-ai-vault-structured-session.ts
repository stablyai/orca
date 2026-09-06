import { toast } from 'sonner'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from './worktree-activation'
import { activateStructuredAgentSessionById } from './structured-agent-session-tab-activation'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const STRUCTURED_SESSION_RESTORE_TIMEOUT_MS = 5_000

/** Why four: the three terminal answers a user can act on differ, and folding them together sends
 *  someone to the wrong remedy — wait, give up, or update the host. `unreachable` is the only one
 *  that improves by retrying, and `gone` means the host said it holds no such chat, never that the
 *  host could not answer for a reason of its own. */
export type StructuredSessionRevealOutcome =
  | 'revealed'
  | 'gone'
  | 'host-cannot-open'
  | 'unreachable'

type StructuredSessionActivationDeps = {
  activate: typeof activateStructuredAgentSessionById
  refresh: (worktreeId: string) => Promise<void>
  reveal: (target: {
    worktreeId: string
    sessionId: string
  }) => Promise<StructuredSessionRevealOutcome>
  unavailable: () => void
  gone: () => void
  hostCannotOpen: () => void
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
  },
  // Separate from `gone` because the chat is not gone — this host cannot open it, whether it is
  // too old to know the method or its adapters do not cover that provider. Telling someone their
  // work is lost when an update would bring it back is the worse of the two wrong answers.
  hostCannotOpen: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.hostCannotOpen',
        "This host can't reopen that chat. It may need an Orca update."
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
      const revealed = await deps.reveal(target)
      if (revealed !== 'revealed') {
        if (revealed === 'gone') {
          deps.gone()
        } else if (revealed === 'host-cannot-open') {
          deps.hostCannotOpen()
        } else {
          // Unreachable: we never got an answer, so this is the one case waiting can still fix.
          deps.unavailable()
        }
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
 * Only `revealed` means the tab is on its way. The other three are all terminal for this click, and
 * they are kept apart because the remedy differs: retry, give up, or update the host.
 */
export async function revealStructuredSession(target: {
  worktreeId: string
  sessionId: string
}): Promise<StructuredSessionRevealOutcome> {
  const environmentId = getRuntimeEnvironmentIdForWorktree(
    useAppStore.getState(),
    target.worktreeId
  )
  const host = getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId })
  // Negotiated against the host that will answer this call, not the local one: a paired host runs
  // its own build, and its method-not-found is indistinguishable from a refusal we should surface.
  // A local host is this build, so it always has the method and needs no round trip to prove it.
  if (host.kind === 'environment') {
    let supported: boolean
    try {
      supported = await runtimeEnvironmentSupportsCapability(
        host.environmentId,
        STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
        STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
      )
    } catch {
      // We could not reach the host to ask. That is not evidence about the chat or the host's age.
      return 'unreachable'
    }
    if (!supported) {
      return 'host-cannot-open'
    }
  }
  let result: AgentSessionRevealReply | undefined
  try {
    result = await withStructuredSessionRestoreTimeout(
      callRuntimeRpc<AgentSessionRevealReply>(
        host,
        'agentSession.reveal',
        { sessionId: target.sessionId },
        {
          timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        }
      )
    )
  } catch {
    return 'unreachable'
  }
  if (result?.ok === true) {
    return 'revealed'
  }
  // The host raises two different refusals here and they mean opposite things to a user: it holds
  // no such record, or it holds one it cannot open. Only the first is the chat being gone.
  return result?.refusal?.code === 'agent_session_identity_required' ? 'gone' : 'host-cannot-open'
}

type AgentSessionRevealReply = { ok?: boolean; refusal?: { code?: string } }

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
