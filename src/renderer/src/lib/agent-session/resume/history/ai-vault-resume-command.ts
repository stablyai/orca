import { useAppStore } from '@/store/index'
import { readManagedAgentCommandsForWorktree } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import { assertAntigravityReferenceTarget } from './ai-vault-antigravity-reference-target'
import type { AiVaultSessionDragPayload } from '@/lib/agent-session/resume/history/ai-vault-session-drag'
import { resolveAiVaultResumeStartupShell } from '@/lib/agent-session/resume/history/ai-vault-resume-shell'
import {
  getAiVaultResumePlatform,
  type AiVaultResumePlatformState
} from '@/lib/agent-session/resume/history/ai-vault-resume-platform'
import {
  buildAiVaultLocalResumeStartup,
  type AiVaultResumeCommandSession,
  type AiVaultResumeHostShell,
  type AiVaultResumeStartup
} from '../../../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import {
  buildAiVaultRemoteResumeStartup,
  resolveAiVaultResumeHostShell
} from '../../../../../../shared/ai-vault/resume/ai-vault-resume-host-startup'

export type AiVaultResumeWorktreeArgs = {
  state: AiVaultResumePlatformState
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
  return buildAiVaultLocalResumeStartup({
    session: args.session,
    host,
    settings: args.state.settings,
    commandOverride: args.commandOverride,
    agentArgs: args.agentArgs,
    embedCwd,
    clearEnvNames,
    managedAgentCommands: readManagedAgentCommandsForWorktree(
      useAppStore.getState(),
      args.worktreeId
    )
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
