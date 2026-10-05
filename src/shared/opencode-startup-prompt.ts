import { isOpenCodeRunCommand } from './opencode-headless-command'
import { sha256 } from './sha256'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

export const OPENCODE_STARTUP_PROMPT_SHA256_ENV = 'ORCA_OPENCODE_STARTUP_PROMPT_SHA256'
export const OPENCODE_STARTUP_PROMPT_NONCE_ENV = 'ORCA_OPENCODE_STARTUP_PROMPT_NONCE'
export const OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV = 'ORCA_OPENCODE_STARTUP_PROMPT_ENDPOINT'
export const OPENCODE_STARTUP_PROMPT_CLAIM_PATH = '/opencode/startup-prompt/claim'
export const OPENCODE_STARTUP_PROMPT_BODY_ENV = 'ORCA_OPENCODE_STARTUP_PROMPT_BODY'
export const OPENCODE_STARTUP_PROMPT_SHELL_ENV = 'ORCA_OPENCODE_STARTUP_PROMPT_SHELL'

export function openCodeStartupPromptEnv(
  agent: TuiAgent,
  command: string,
  shell: AgentStartupShell,
  prompt: string,
  env: Record<string, string> | null | undefined
): { env?: Record<string, string> } {
  const parsed = tokenizeStartupCommand(command, shell)
  if (
    (agent !== 'opencode' && agent !== 'opencode2') ||
    !parsed.ok ||
    isOpenCodeRunCommand(parsed.tokens, shell)
  ) {
    return env ? { env: { ...env } } : {}
  }
  const digest = Array.from(sha256(new TextEncoder().encode(prompt)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  return {
    env: {
      ...env,
      [OPENCODE_STARTUP_PROMPT_SHA256_ENV]: digest,
      [OPENCODE_STARTUP_PROMPT_BODY_ENV]: prompt,
      [OPENCODE_STARTUP_PROMPT_SHELL_ENV]: shell
    }
  }
}
