import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { runBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import { buildQuickComposerStartup } from '@/hooks/composer-state/quick-startup-plan'
import { useAppStore } from '@/store'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

type LaunchContinuationInNewWorktreeArgs = {
  agent: TuiAgent
  prompt: string
  repoId: string
  branchName: string
  baseBranch?: string | null
  sourceTitle?: string | null
  telemetrySource: WorktreeCreationRequest['telemetrySource']
}

/**
 * Continue a session in a checkout that does not exist yet: create the worktree
 * and hand the continuation prompt to the agent Orca starts inside it.
 *
 * Why a separate entry point: `launchAgentSessionContinuation` opens a tab in a
 * live worktree, so it can detect agents and preflight trust against a real
 * path. Here the worktree is created first and the launch is owned by the
 * creation flow, which already knows how to seed an agent from a startup plan.
 */
export function launchAgentSessionContinuationInNewWorktree({
  agent,
  prompt,
  repoId,
  branchName,
  baseBranch,
  sourceTitle,
  telemetrySource
}: LaunchContinuationInNewWorktreeArgs): boolean {
  const state = useAppStore.getState()
  const repo = state.repos.find((entry) => entry.id === repoId)
  if (!repo) {
    toast.error(
      translate(
        'components.agentSessionContinuation.worktreeRepoMissing',
        'Could not find the project this session belongs to.'
      )
    )
    return false
  }

  const projectRuntime = repo.connectionId
    ? undefined
    : getLocalRepoProjectExecutionRuntimeContext(
        {
          activeRepoId: repoId,
          activeWorktreeId: null,
          projects: state.projects,
          repos: state.repos,
          settings: state.settings,
          worktreesByRepo: state.worktreesByRepo
        },
        repoId,
        CLIENT_PLATFORM
      )
  const platform = getAgentLaunchPlatformForRepo(repo, projectRuntime)
  const isRemote = repoIsRemote(repo)

  // Why: `prompt` and not `draftPrompt` — the continuation is already reviewed
  // in the dialog, so the new agent should start on it rather than wait on a
  // draft the user has to submit again.
  const { startupPlan, backendStartup, telemetry } = buildQuickComposerStartup({
    agent,
    prompt,
    draftPrompt: null,
    settings: state.settings,
    repoConnectionId: repo.connectionId,
    platform,
    shell: resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: state.settings?.terminalWindowsShell
    }),
    isRemote,
    telemetrySource
  })

  const creationId = runBackgroundWorktreeCreation({
    repoId,
    name: branchName,
    ...(baseBranch ? { baseBranch } : {}),
    setupDecision: 'inherit',
    agent,
    startup: backendStartup,
    startupPlan,
    quickPrompt: prompt,
    quickTelemetry: telemetry,
    pendingFirstAgentMessageRename: false,
    note: sourceTitle?.trim() ? `Continued from: ${sourceTitle.trim()}` : ''
  })

  toast.success(
    translate(
      'components.agentSessionContinuation.creatingWorktree',
      'Creating {{branch}} and starting {{agent}} there.',
      { branch: branchName, agent: getAgentLabel(agent) }
    )
  )
  return Boolean(creationId)
}
