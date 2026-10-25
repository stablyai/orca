import { parseExecutionHostId } from '../../../shared/execution-host'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'
import {
  assertAiVaultCopiedSessionStoreAllowed,
  buildAiVaultForkStartup,
  resolveAiVaultCopiedSessionAgentArgs
} from '../../../shared/ai-vault-resume-startup'
import {
  buildAiVaultResumeStartupForWorktree,
  resolveAiVaultResumeHost,
  type AiVaultResumeStartup,
  type AiVaultResumeWorktreeArgs
} from '@/lib/ai-vault-resume-command'

function sharedStartupArgs(args: AiVaultResumeWorktreeArgs) {
  return {
    session: args.session,
    host: resolveAiVaultResumeHost(args),
    settings: args.state.settings,
    commandOverride: args.commandOverride
  }
}

/** The desktop's fork startup; the shared builder explains why a non-forking agent gets null. */
export function buildAiVaultForkStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeStartup | null {
  return buildAiVaultForkStartup(sharedStartupArgs(args))
}

/** Keeps the history row's launch mode while the copied conversation opens with its actual CLI. */
export function buildAiVaultCopiedSessionStartupForWorktree(
  args: AiVaultResumeWorktreeArgs,
  sourceAgent: AiVaultAgent
): AiVaultResumeStartup {
  const agentArgs = resolveAiVaultCopiedSessionAgentArgs({
    ...sharedStartupArgs(args),
    sourceAgent
  })
  return {
    ...buildAiVaultResumeStartupForWorktree({ ...args, agentArgs }),
    agent: args.session.agent
  }
}

/** Runtime hosts validate their own launch settings when making the copy. */
export function assertAiVaultCopiedSessionLaunchAllowed(args: AiVaultResumeWorktreeArgs): void {
  if (parseExecutionHostId(args.session.executionHostId)?.kind === 'runtime') {
    return
  }
  assertAiVaultCopiedSessionStoreAllowed(sharedStartupArgs(args))
}
