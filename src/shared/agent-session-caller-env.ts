/**
 * The Orca-minted agent session id, injected into a structured session's own child processes. When
 * it is present it IS the orchestration caller: the CLI sends it in the orchestration envelope and
 * the host resolves the session it names, so no terminal is resolved or guessed on its behalf.
 *
 * Identity by session id assumes one machine and one user. A host boundary (SSH, a paired peer,
 * WSL) re-opens that decision: the host refuses a claim that arrives across one, and the SSH
 * passthrough never carries the id.
 */
import { ORCA_SESSION_ADDRESS_PREFIX } from './orca-session-address-prefix'
import { isStructuredWorkerHandle } from './structured-worker-handle'

export const ORCA_AGENT_SESSION_ID_ENV = 'ORCA_AGENT_SESSION_ID'

export function readInjectedAgentSessionId(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const value = env[ORCA_AGENT_SESSION_ID_ENV]?.trim()
  return value ? value : undefined
}

/**
 * The address the host gives this session (`mailboxAddressOf` on its resolved party): a structured
 * worker keeps the handle it was minted, any other session is `session:<id>`. Only for text that
 * must match what the host writes; the CLI spells it without the host resolver.
 */
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
