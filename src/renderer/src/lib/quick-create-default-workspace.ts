import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { OrcaHooks, Repo, SetupDecision, TuiAgent } from '../../../shared/types'
import { activateAndRevealWorktree, type AgentStartedTelemetry } from '@/lib/worktree-activation'
import { CLIENT_PLATFORM, ensureAgentStartupInTerminal, getSetupConfig } from '@/lib/new-workspace'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { getSuggestedCreatureName } from '@/components/sidebar/worktree-name-suggestions'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'

export type QuickCreateDefaultWorkspaceArgs = {
  openModalFallback: () => void
}

function getCurrentRepo(): Repo | null {
  const state = useAppStore.getState()
  if (state.activeWorktreeId) {
    for (const worktrees of Object.values(state.worktreesByRepo)) {
      const activeWorktree = worktrees.find((worktree) => worktree.id === state.activeWorktreeId)
      if (activeWorktree) {
        return (
          state.repos.find((repo) => repo.id === activeWorktree.repoId && isGitRepoKind(repo)) ??
          null
        )
      }
    }
  }

  const activeRepo = state.repos.find(
    (repo) => repo.id === state.activeRepoId && isGitRepoKind(repo)
  )
  if (activeRepo) {
    return activeRepo
  }

  const eligibleRepos = state.repos.filter((repo) => isGitRepoKind(repo))
  return eligibleRepos.length === 1 ? eligibleRepos[0] : null
}

async function resolveSetupDecision(
  repoId: string,
  repo: Repo
): Promise<{ kind: 'decided'; decision: SetupDecision } | { kind: 'needs-modal' }> {
  let yamlHooks: OrcaHooks | null = null
  try {
    const result = await window.api.hooks.check({ repoId })
    yamlHooks = result.hooks
  } catch {
    yamlHooks = null
  }

  const setupConfig = getSetupConfig(repo, yamlHooks)
  if (!setupConfig) {
    return { kind: 'decided', decision: 'inherit' }
  }

  const policy = repo.hookSettings?.setupRunPolicy ?? 'run-by-default'
  if (policy === 'ask') {
    return { kind: 'needs-modal' }
  }

  return { kind: 'decided', decision: policy === 'run-by-default' ? 'run' : 'skip' }
}

async function resolveConfiguredAgent(repo: Repo): Promise<TuiAgent | null | 'needs-modal'> {
  const state = useAppStore.getState()
  const preference = state.settings?.defaultTuiAgent
  if (preference === null || preference === undefined) {
    return 'needs-modal'
  }
  if (preference === 'blank') {
    return null
  }
  if (!isTuiAgentEnabled(preference, state.settings?.disabledTuiAgents)) {
    return 'needs-modal'
  }

  const detected = repo.connectionId
    ? await state.ensureRemoteDetectedAgents(repo.connectionId)
    : await state.ensureDetectedAgents()
  return detected.includes(preference) ? preference : 'needs-modal'
}

export async function quickCreateDefaultWorkspace({
  openModalFallback
}: QuickCreateDefaultWorkspaceArgs): Promise<void> {
  const state = useAppStore.getState()
  const settings = state.settings
  const repo = getCurrentRepo()
  if (!settings?.quickCreateWorkspaceWithDefaultAgent || !repo) {
    openModalFallback()
    return
  }

  const agent = await resolveConfiguredAgent(repo)
  if (agent === 'needs-modal') {
    openModalFallback()
    return
  }

  const setupResolution = await resolveSetupDecision(repo.id, repo)
  if (setupResolution.kind === 'needs-modal') {
    openModalFallback()
    return
  }

  try {
    const trustDecision = await ensureHooksConfirmed(useAppStore.getState(), repo.id, 'setup')
    const setupDecision: SetupDecision =
      trustDecision === 'skip' ? 'skip' : setupResolution.decision
    const latest = useAppStore.getState()
    const workspaceName = getSuggestedCreatureName(latest.worktreesByRepo)
    const result = await latest.createWorktree(
      repo.id,
      workspaceName,
      undefined,
      setupDecision,
      undefined,
      'sidebar',
      undefined,
      undefined,
      undefined,
      undefined,
      agent ?? undefined
    )

    if (agent && result.worktree.path && window.api.agentTrust?.markTrusted) {
      const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
      if (preflight) {
        try {
          await window.api.agentTrust.markTrusted({
            preset: preflight,
            workspacePath: result.worktree.path
          })
        } catch {
          // Best-effort: continue with launch.
        }
      }
    }

    const startupPlan =
      agent === null
        ? null
        : buildAgentStartupPlan({
            agent,
            prompt: '',
            cmdOverrides: settings.agentCmdOverrides ?? {},
            platform: CLIENT_PLATFORM,
            allowEmptyPromptLaunch: true
          })
    const telemetry: AgentStartedTelemetry | null =
      agent === null
        ? null
        : {
            agent_kind: tuiAgentToAgentKind(agent),
            launch_source: 'sidebar',
            request_kind: 'new'
          }

    activateAndRevealWorktree(result.worktree.id, {
      setup: result.setup,
      ...(startupPlan
        ? {
            startup: {
              command: startupPlan.launchCommand,
              ...(startupPlan.env ? { env: startupPlan.env } : {}),
              ...(telemetry ? { telemetry } : {})
            }
          }
        : {})
    })
    if (startupPlan) {
      void ensureAgentStartupInTerminal({ worktreeId: result.worktree.id, startup: startupPlan })
    }

    const postCreate = useAppStore.getState()
    postCreate.setSidebarOpen(true)
    if (settings.rightSidebarOpenByDefault) {
      postCreate.setRightSidebarTab('explorer')
      postCreate.setRightSidebarOpen(true)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create workspace.'
    toast.error(message)
  }
}
