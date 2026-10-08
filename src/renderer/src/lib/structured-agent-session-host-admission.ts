import type { TuiAgent } from '../../../shared/tui-agent'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../shared/agent-session-definitive-refusal'
import { parseStructuredLaunchSeedOptions } from '../../../shared/native-chat-session-option-defaults'
import { resolveStructuredChatLaunchOptions } from '../../../shared/structured-chat-launch-options'
import { useAppStore } from '@/store'
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

/** Keep the picker aligned with the starting choices this host version can honour. */
export type StructuredLaunchAdmission =
  | {
      kind: 'admitted'
      seedOptions?: Readonly<Record<string, string>>
      clientOptions?: Readonly<Record<string, string>>
    }
  | { kind: 'declined' }
  | { kind: 'unreachable' }
  /** The host still could not resolve the workspace after the retries: not yet, rather than no. */
  | { kind: 'workspace-unresolved' }

export type HostCreateSupport =
  | Exclude<StructuredLaunchAdmission, { kind: 'unreachable' }>
  | { kind: 'unreachable'; code: string; message: string; error: unknown }

/**
 * Whether the executing host supports creating this session, retrying only while the host cannot
 * yet resolve the worktree. "Could not answer" and "answered no" are different states and only the
 * second is a verdict. A paired server's call is bounded by the runtime RPC client's timeout; this
 * machine's call has none.
 */
export async function askHostCreateSupport(
  target: RuntimeClientTarget,
  worktree: string,
  agent: TuiAgent
): Promise<HostCreateSupport> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const support = await callStructuredAgentSession<{
        supported: boolean
        reason?: string
        seedOptions?: unknown
        acceptsClientOptions?: unknown
      }>(target, 'agentSession.createSupport', { worktree, agent })
      if (support.supported !== true) {
        return { kind: 'declined' }
      }
      if (support.acceptsClientOptions === true) {
        const clientOptions = resolveStructuredChatLaunchOptions(
          useAppStore.getState().settings,
          agent
        )
        return { kind: 'admitted', seedOptions: clientOptions, clientOptions }
      }
      const seedOptions = parseStructuredLaunchSeedOptions(support.seedOptions)
      return seedOptions ? { kind: 'admitted', seedOptions } : { kind: 'admitted' }
    } catch (error) {
      if (hasRuntimeRpcErrorCode(error, SELECTOR_NOT_RESOLVABLE_CODE)) {
        const retryDelayMs = CREATE_SUPPORT_RETRY_DELAYS_MS[attempt]
        if (retryDelayMs === undefined) {
          return { kind: 'workspace-unresolved' }
        }
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

/** How long a launch on this machine waits for its answer before anything shows. Past it the
 *  launch treats the host as unable to answer, and the chat's own create keeps asking. */
export const LOCAL_ADMISSION_WAIT_MS = 3_000

/** Asks a host to admit a chat before the client commits any of it. */
export async function admitStructuredLaunchOnHost(
  target: RuntimeClientTarget,
  worktree: string,
  agent: TuiAgent
): Promise<StructuredLaunchAdmission> {
  const asked = askHostCreateSupport(target, worktree, agent).then(
    (support): StructuredLaunchAdmission =>
      support.kind === 'unreachable' ? { kind: 'unreachable' } : support
  )
  if (target.kind !== 'local') {
    return asked
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<StructuredLaunchAdmission>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unreachable' }), LOCAL_ADMISSION_WAIT_MS)
  })
  try {
    return await Promise.race([asked, timedOut])
  } finally {
    clearTimeout(timer)
  }
}
