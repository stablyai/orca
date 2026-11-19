/** Injected session identity resolves the orchestration caller without guessing a terminal. Valid only on the same host/user: refuse claims across SSH, pairing or WSL, and omit it from SSH passthrough. */
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../identity/orca-session-address-prefix'
import { isStructuredWorkerHandle } from '../../../orchestration/workers/structured-worker-handle'

export const ORCA_AGENT_SESSION_ID_ENV = 'ORCA_AGENT_SESSION_ID'

/** The reservation token distinguishes its live child from a process that reused the PID. */
export const ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV = 'ORCA_AGENT_SESSION_SPAWN_TOKEN'

/** A bot run's key to Orca's bot tool relay; the host names the calling bot by it, never by the session id. */
export const BOT_TOOLS_TOKEN_ENV = 'ORCA_BOT_TOOLS_TOKEN'

export function readInjectedBotToken(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const value = env[BOT_TOOLS_TOKEN_ENV]?.trim()
  return value ? value : undefined
}

export function readInjectedAgentSessionId(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const value = env[ORCA_AGENT_SESSION_ID_ENV]?.trim()
  return value ? value : undefined
}

/** Match the resolved host mailbox address: workers retain their minted handle; other sessions use orca_session_id:<id>. The CLI cannot call the host resolver. */
export function injectedSessionAddress(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const sessionId = readInjectedAgentSessionId(env)
  if (!sessionId) {
    return undefined
  }
  const ownHandle = env.ORCA_TERMINAL_HANDLE
  return isStructuredWorkerHandle(ownHandle)
    ? ownHandle
    : `${ORCA_SESSION_ADDRESS_PREFIX}${sessionId}`
}
