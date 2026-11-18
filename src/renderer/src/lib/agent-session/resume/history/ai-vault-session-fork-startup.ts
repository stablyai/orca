import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  assertAiVaultCopiedSessionStoreAllowed,
  buildAiVaultForkStartup,
  type AiVaultResumeStartup
} from '../../../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import {
  buildAiVaultResumeStartupForWorktree,
  resolveAiVaultResumeHost,
  type AiVaultResumeWorktreeArgs
} from '@/lib/agent-session/resume/history/ai-vault-resume-command'

function sharedStartupArgs(args: AiVaultResumeWorktreeArgs) {
  return {
    session: args.session,
    host: resolveAiVaultResumeHost(args),
    settings: args.state.settings,
    commandOverride: args.commandOverride
  }
}

export function buildAiVaultForkStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeStartup | null {
  return buildAiVaultForkStartup(sharedStartupArgs(args))
}

/** The copy is the terminal's own conversation: a plain resume with its CLI's own launch settings. */
export function buildAiVaultCopiedSessionStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeStartup {
  return { ...buildAiVaultResumeStartupForWorktree(args), agent: args.session.agent }
}

/** Runtime hosts validate their own launch settings when making the copy. */
export function assertAiVaultCopiedSessionLaunchAllowed(args: AiVaultResumeWorktreeArgs): void {
  if (parseExecutionHostId(args.session.executionHostId)?.kind === 'runtime') {
    return
  }
  assertAiVaultCopiedSessionStoreAllowed(sharedStartupArgs(args))
}
