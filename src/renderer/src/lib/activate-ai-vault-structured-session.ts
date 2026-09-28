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
import {
  applyStructuredSessionTabSnapshots,
  isCurrentLocalStructuredSessionGeneration,
  localStructuredSessionGeneration
} from '@/runtime/local-structured-session-tabs-sync'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'

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
  // Separate from `gone` because the chat is not gone: something about this pairing cannot open
  // it — a host too old to know the method, adapters that do not cover the provider, or a version
  // block that can name EITHER side. Naming a machine here would point half of those at the wrong
  // one, so the message names the remedy instead. Telling someone their work is lost when an
  // update would bring it back is the worse of the two wrong answers.
  hostCannotOpen: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.hostCannotOpen',
        "This chat can't be reopened until Orca is updated."
      )
    )
  }
}

/**
 * @param session anything carrying the row's structured pointer — an Agent Session History row or
 * the drag payload built from one. Only `structuredSession` is read, and both surfaces must reach
 * the same reveal, or the same row answers a click and a drop differently.
 */
export async function activateAiVaultStructuredSession(
  session: Pick<AiVaultSession, 'structuredSession'>,
  deps: StructuredSessionActivationDeps = defaultDeps
): Promise<boolean> {
  const structured = session.structuredSession
  if (!structured) {
    return false
  }
  // Why: the click can chain a refresh, a capability probe, a reveal and a second refresh, each
  // with its own timeout, and nothing on the row says it is working. Without this, an impatient
  // second click runs the whole sequence again and lands its own toast.
  const inFlight = activationsInFlight.get(structured.sessionId)
  if (inFlight) {
    return inFlight
  }
  const activation = activateStructuredSession(structured, deps)
  activationsInFlight.set(structured.sessionId, activation)
  try {
    return await activation
  } finally {
    activationsInFlight.delete(structured.sessionId)
  }
}

const activationsInFlight = new Map<string, Promise<boolean>>()

async function activateStructuredSession(
  structured: NonNullable<AiVaultSession['structuredSession']>,
  deps: StructuredSessionActivationDeps
): Promise<boolean> {
  const target = { worktreeId: structured.workspaceId, sessionId: structured.sessionId }
  if (!deps.activate(target)) {
    // A refresh alone can answer, and costs one call instead of two. It is only ever an
    // optimization, so a refresh that fails must fall through to the reveal rather than end the
    // click: the host republishing the tab is the repair, and it does not need this to have worked.
    const refreshed = await refreshedWithoutThrowing(deps, structured.workspaceId)
    if (!refreshed || !deps.activate(target)) {
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
      await refreshedWithoutThrowing(deps, structured.workspaceId)
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

/** The inventory refresh is advisory at every call site here, so its failure is a `false`, never a
 *  thrown end to the click. */
async function refreshedWithoutThrowing(
  deps: StructuredSessionActivationDeps,
  worktreeId: string
): Promise<boolean> {
  try {
    await deps.refresh(worktreeId)
    return true
  } catch {
    return false
  }
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
      // Raced, not merely given a timeout argument: on a cache hit this awaits a promise created
      // by an earlier probe that may carry no deadline of its own, and one that never settles
      // would hold this session's in-flight entry for the life of the process.
      supported = await withStructuredSessionRestoreTimeout(
        runtimeEnvironmentSupportsCapability(
          host.environmentId,
          STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        )
      )
    } catch (error) {
      // A version block is the host's age, stated outright; anything else means we never got to
      // ask, which is not evidence about the chat or the host. `remote-agent-session-launch`
      // splits the same probe's failures the same way.
      return isRuntimeCompatBlockError(error) ? 'host-cannot-open' : 'unreachable'
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
  // Every other caller that applies an inventory fences it on the sync generation. Structured chat
  // can be switched off while this call is in flight, which wipes the mirror; without this the
  // answer would land afterwards and re-seed a chat row into a renderer that just discarded them.
  const generation = localStructuredSessionGeneration()
  const snapshot = await withStructuredSessionRestoreTimeout(
    callRuntimeRpc<RuntimeMobileSessionTabsResult>(
      getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
      'session.tabs.list',
      { worktree: toRuntimeWorktreeSelector(worktreeId) },
      { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
    )
  )
  if (!isCurrentLocalStructuredSessionGeneration(generation)) {
    return
  }
  // No owner scope: the apply discards any worktree whose execution host is not local before it
  // reads one, so a paired workspace is carried by the subscription, not by this call.
  applyStructuredSessionTabSnapshots([snapshot])
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
