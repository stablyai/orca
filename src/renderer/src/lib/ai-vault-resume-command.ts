import {
  assertAntigravityReferenceTarget,
  buildAntigravityReferenceStartup
} from './ai-vault-antigravity-reference-startup'
import { isAntigravityReferenceSession } from '../../../shared/antigravity-session-origin'
import { realHomeCodexResumeEnvDeletion } from '../../../shared/ai-vault-resume-command'
import { normalizeAiVaultResumeFilePath } from '../../../shared/ai-vault-resume-path'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import type { AppState } from '@/store/types'
import type { AiVaultSessionDragPayload } from '@/lib/ai-vault-session-drag'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { managedDataAccountResumeEnv } from '../../../shared/managed-data-account-resume'
import { resolveAiVaultResumeStartupShell } from '@/lib/ai-vault-resume-shell'
import { getAiVaultResumePlatform } from '@/lib/ai-vault-resume-platform'
import {
  buildAiVaultLocalResumeStartup,
  getAiVaultAgentProviderSession,
  getAiVaultResumeCodexHome,
  type AiVaultResumeCommandSession,
  type AiVaultResumeHostShell,
  type AiVaultResumeStartup
} from '../../../shared/ai-vault-resume-startup'

export type {
  AiVaultResumeCommandSession,
  AiVaultResumeStartup
} from '../../../shared/ai-vault-resume-startup'
export { getAiVaultAgentProviderSession }

export type AiVaultResumeWorktreeArgs = {
  state: Pick<
    AppState,
    | 'activeRepoId'
    | 'activeWorktreeId'
    | 'folderWorkspaces'
    | 'projectGroups'
    | 'projects'
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
  >
  worktreeId?: string | null
  session: AiVaultResumeCommandSession
  commandOverride?: string | null
  agentArgs?: string
}

export function buildAiVaultResumeCopyCommandForWorktree(args: AiVaultResumeWorktreeArgs): string {
  // Copied lines run in unknown shells; env -u avoids fish_pid probing that aborts under set -u before agent launch (#14863).
  const clearEnvNames =
    args.session.agent === 'codex' && args.session.codexHome === null
      ? (['CODEX_HOME', 'ORCA_CODEX_HOME'] as const)
      : undefined
  return buildAiVaultResumeForWorktree(args, true, clearEnvNames).command
}

export function buildAiVaultResumeStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeStartup {
  return buildAiVaultResumeForWorktree(args, false)
}

/** Rebuild with the substituted account home; the prebuilt command pins the wrong account. null cwd means no cd; absent cwd is an older payload whose original directory cannot be recovered. */
export function buildAiVaultDropRepinStartup(args: {
  state: AiVaultResumeWorktreeArgs['state']
  payload: Pick<
    AiVaultSessionDragPayload,
    'agent' | 'sessionId' | 'sessionCwd' | 'sessionExecutionHostId' | 'sessionFilePath'
  >
  substituteCodexHome: string
  worktreeId: string
}): AiVaultResumeStartup | null {
  if (args.payload.sessionCwd === undefined || !args.payload.sessionFilePath) {
    return null
  }
  return buildAiVaultResumeStartupForWorktree({
    state: args.state,
    worktreeId: args.worktreeId,
    session: {
      agent: args.payload.agent,
      sessionId: args.payload.sessionId,
      cwd: args.payload.sessionCwd,
      codexHome: args.substituteCodexHome,
      executionHostId: args.payload.sessionExecutionHostId,
      filePath: args.payload.sessionFilePath
    },
    commandOverride: args.state.settings?.agentCmdOverrides?.[args.payload.agent]
  })
}

function buildAiVaultResumeForWorktree(
  args: AiVaultResumeWorktreeArgs,
  embedCwd: boolean,
  /** Copied lines strip env from the agent command; spawned startups use envToDelete. */
  clearEnvNames?: readonly string[]
): AiVaultResumeStartup {
  assertAntigravityReferenceTarget(args)
  const providerSession = getAiVaultAgentProviderSession(args.session)
  if (
    args.session.executionHostId &&
    args.session.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    args.session.resumeCommand &&
    !isAntigravityReferenceSession(args.session) &&
    args.session.agent !== 'omp' &&
    !(args.session.agent === 'codex' && args.session.codexHome === null) &&
    !args.commandOverride?.trim()
  ) {
    const accountEnv = managedDataAccountResumeEnv(args.session)
    return {
      command: args.session.resumeCommand,
      ...(Object.keys(accountEnv).length > 0 ? { env: accountEnv } : {}),
      ...realHomeCodexResumeEnvDeletion(args.session),
      ...(providerSession ? { providerSession } : {})
    }
  }
  const host = resolveAiVaultResumeHost(args)
  if (isAntigravityReferenceSession(args.session)) {
    const reference = buildAntigravityReferenceStartup({
      session: {
        ...args.session,
        filePath: normalizeAiVaultResumeFilePath(args.session.filePath, host.platform)
      },
      cwd: embedCwd ? args.session.cwd : null,
      platform: host.platform,
      shell: host.liveShell,
      commandOverride: args.commandOverride,
      settings: args.state.settings
    })
    if (reference) {
      return { ...reference, ...(!embedCwd && args.session.cwd ? { cwd: args.session.cwd } : {}) }
    }
  }
  return buildAiVaultLocalResumeStartup({
    session: args.session,
    host,
    settings: args.state.settings,
    commandOverride: args.commandOverride,
    agentArgs: args.agentArgs,
    embedCwd,
    clearEnvNames
  })
}

export function resolveAiVaultResumeHost(args: AiVaultResumeWorktreeArgs): AiVaultResumeHostShell {
  const isLocalSession =
    !args.session.executionHostId || args.session.executionHostId === LOCAL_EXECUTION_HOST_ID
  const platform =
    !isLocalSession && args.session.executionHostPlatform
      ? args.session.executionHostPlatform
      : getAiVaultResumePlatform(args.state, args.worktreeId)
  // Local shell settings cannot describe remote Windows hosts; preserve remote PowerShell-default quoting.
  const liveShell: AgentStartupShell | undefined =
    platform === 'win32'
      ? isLocalSession
        ? resolveAiVaultResumeStartupShell({
            state: args.state,
            worktreeId: args.worktreeId,
            platform,
            isLocalSession
          })
        : 'powershell'
      : undefined
  return {
    platform,
    codexHome: getAiVaultResumeCodexHome(args.session.codexHome, platform),
    liveShell
  }
}
