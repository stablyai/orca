// How a saved conversation resumes on the session's own host: its platform, shell and prebuilt line.

import { isAntigravityReferenceSession } from './antigravity-session-origin'
import { realHomeCodexResumeEnvDeletion } from './ai-vault-resume-command'
import {
  getAiVaultAgentProviderSession,
  getAiVaultResumeCodexHome,
  type AiVaultResumeCommandSession,
  type AiVaultResumeHostShell,
  type AiVaultResumeStartup
} from './ai-vault-resume-startup'
import { LOCAL_EXECUTION_HOST_ID } from './execution-host'
import { managedDataAccountResumeEnv } from './managed-data-account-resume'
import type { AgentStartupShell } from './tui-agent-startup-shell'

/** A remote session resumes on its own host's platform; a local one on the target workspace's.
 *  Local shell settings cannot describe remote Windows hosts, so those keep PowerShell-default quoting. */
export function resolveAiVaultResumeHostShell(args: {
  session: Pick<
    AiVaultResumeCommandSession,
    'codexHome' | 'executionHostId' | 'executionHostPlatform'
  >
  /** null when the workspace's SSH or paired host has not reported its OS. */
  workspacePlatform: NodeJS.Platform | null
  localLiveShell: (platform: NodeJS.Platform) => AgentStartupShell | undefined
}): AiVaultResumeHostShell {
  const isLocalSession =
    !args.session.executionHostId || args.session.executionHostId === LOCAL_EXECUTION_HOST_ID
  const agentHostPlatform =
    !isLocalSession && args.session.executionHostPlatform
      ? args.session.executionHostPlatform
      : args.workspacePlatform
  // Why linux when unknown: SSH and paired hosts are almost always POSIX, and earlier resumes quoted that way.
  const platform = agentHostPlatform ?? 'linux'
  const liveShell: AgentStartupShell | undefined =
    platform === 'win32'
      ? isLocalSession
        ? args.localLiveShell(platform)
        : 'powershell'
      : undefined
  return {
    platform,
    // Why: an unknown host keeps OS-specific agent flags off; see withAgentTerminalInputArgs.
    agentHostPlatform,
    codexHome: getAiVaultResumeCodexHome(args.session.codexHome, platform),
    liveShell
  }
}

/** The remote scanner's own resume line, when it still fits: it already targets that host's shell and Codex home. */
export function buildAiVaultRemoteResumeStartup(
  session: AiVaultResumeCommandSession,
  commandOverride: string | null | undefined
): AiVaultResumeStartup | null {
  if (
    !session.executionHostId ||
    session.executionHostId === LOCAL_EXECUTION_HOST_ID ||
    !session.resumeCommand ||
    isAntigravityReferenceSession(session) ||
    session.agent === 'omp' ||
    (session.agent === 'codex' && session.codexHome === null) ||
    commandOverride?.trim()
  ) {
    return null
  }
  const providerSession = getAiVaultAgentProviderSession(session)
  const accountEnv = managedDataAccountResumeEnv(session)
  return {
    command: session.resumeCommand,
    ...(Object.keys(accountEnv).length > 0 ? { env: accountEnv } : {}),
    ...realHomeCodexResumeEnvDeletion(session),
    ...(providerSession ? { providerSession } : {})
  }
}
