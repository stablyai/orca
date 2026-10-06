import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../shared/agent-session-definitive-refusal'
import { parseStructuredLaunchSeedOptions } from '../../../shared/native-chat-session-option-defaults'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

/** The host answers a worktree selector it cannot resolve yet with this rather than a verdict. */
const SELECTOR_NOT_RESOLVABLE_CODE = 'selector_not_found'

/**
 * A worktree is not resolvable for a beat after `createWorktree` resolves, so a probe fired
 * immediately after creation fails instead of answering. Measured window: under ~250ms. These
 * delays cover it with margin and bound the wait when the selector is genuinely absent.
 */
const CREATE_SUPPORT_RETRY_DELAYS_MS: readonly number[] = [50, 150, 300]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runtimeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'runtime_unavailable'
}

/** The owning host's answer to "can you run this chat here?", asked before anything is created.
 *  An admitting host also names the saved selection create will seed, when it is new enough to. */
export type StructuredLaunchAdmission =
  | { kind: 'admitted'; seedOptions?: Readonly<Record<string, string>> }
  | { kind: 'declined' }
  | { kind: 'unreachable' }

export type HostCreateSupport =
  | { kind: 'admitted'; seedOptions?: Readonly<Record<string, string>> }
  | { kind: 'declined' }
  | { kind: 'unreachable'; code: string; message: string; error: unknown }

/**
 * Whether the executing host supports creating this session, retrying only while the host cannot
 * yet resolve the worktree. "Could not answer" and "answered no" are different states and only the
 * second is a verdict. Each call is bounded by the runtime RPC client's own timeout.
 */
export async function askHostCreateSupport(
  target: RuntimeClientTarget,
  worktree: string,
  agent: AgentSessionHandleProvider,
  agentProfileId?: string
): Promise<HostCreateSupport> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const support = await callStructuredAgentSession<{
        supported: boolean
        reason?: string
        seedOptions?: unknown
      }>(target, 'agentSession.createSupport', {
        worktree,
        agent,
        ...(agentProfileId !== undefined ? { agentProfileId } : {})
      })
      if (support.supported !== true) {
        return { kind: 'declined' }
      }
      const seedOptions = parseStructuredLaunchSeedOptions(support.seedOptions)
      return seedOptions ? { kind: 'admitted', seedOptions } : { kind: 'admitted' }
    } catch (error) {
      const retryDelayMs = CREATE_SUPPORT_RETRY_DELAYS_MS[attempt]
      if (retryDelayMs === undefined) {
        // A selector that never appears is a definitive refusal.
        return { kind: 'declined' }
      }
      if (hasRuntimeRpcErrorCode(error, SELECTOR_NOT_RESOLVABLE_CODE)) {
        await delay(retryDelayMs)
        continue
      }
      const code = runtimeErrorCode(error)
      if (isDefinitiveAgentSessionCreateRefusal(code)) {
        return { kind: 'declined' }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'unreachable', code, message, error }
    }
  }
}

/** Asks a host to admit a chat before the client commits any of it. */
export async function admitStructuredLaunchOnHost(
  target: RuntimeClientTarget,
  worktree: string,
  agent: AgentSessionHandleProvider
): Promise<StructuredLaunchAdmission> {
  const support = await askHostCreateSupport(target, worktree, agent)
  return support.kind === 'unreachable' ? { kind: 'unreachable' } : support
}
