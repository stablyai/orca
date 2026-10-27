import type { ProjectCatalogReadState } from '@/store/project-host-setup-selector'
import {
  assertAntigravityReferenceTarget,
  buildAntigravityReferenceStartup
} from './ai-vault-antigravity-reference-startup'
import { isAntigravityReferenceSession } from '../../../shared/antigravity-session-origin'
import { normalizeAiVaultResumeFilePath } from '../../../shared/ai-vault-resume-path'
import type { AppState } from '@/store/types'
import type { AiVaultSessionDragPayload } from '@/lib/ai-vault-session-drag'
import { resolveAiVaultResumeStartupShell } from '@/lib/ai-vault-resume-shell'
import { getAiVaultResumePlatform } from '@/lib/ai-vault-resume-platform'
import {
  buildAiVaultLocalResumeStartup,
  getAiVaultAgentProviderSession,
  type AiVaultResumeCommandSession,
  type AiVaultResumeHostShell,
  type AiVaultResumeStartup
} from '../../../shared/ai-vault-resume-startup'
import {
  buildAiVaultRemoteResumeStartup,
  resolveAiVaultResumeHostShell
} from '../../../shared/ai-vault-resume-host-startup'

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
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
  > &
    ProjectCatalogReadState
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
  const remote = buildAiVaultRemoteResumeStartup(args.session, args.commandOverride)
  if (remote) {
    return remote
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
  return resolveAiVaultResumeHostShell({
    session: args.session,
    workspacePlatform: getAiVaultResumePlatform(args.state, args.worktreeId),
    localLiveShell: (platform) =>
      resolveAiVaultResumeStartupShell({
        state: args.state,
        worktreeId: args.worktreeId,
        platform
      })
  })
}
