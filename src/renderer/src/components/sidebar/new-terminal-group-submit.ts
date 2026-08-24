import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { repoIsRemote } from '../../../../shared/agent-launch-remote'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { Worktree } from '../../../../shared/worktree/types'
import type { LaunchSource } from '../../../../shared/telemetry-events'

export type TerminalGroupLaunchRepo = Pick<Repo, 'id' | 'displayName' | 'path' | 'connectionId'>

type SubmitTerminalGroupCreateParams = {
  repo: TerminalGroupLaunchRepo
  name: string
  agent: TuiAgent | null
  /** Repo-scoped launch platform, resolved by the caller from the project's execution host. */
  platform: NodeJS.Platform
  agentCmdOverrides?: Record<string, string>
  agentArgs?: string | null
  agentEnv?: Record<string, string>
  terminalWindowsShell?: string | null
  launchSource?: LaunchSource
  createTerminalGroup: (input: { repoId: string; name: string }) => Promise<Worktree | null>
  onOpenChange: (open: boolean) => void
}

/** Falls back to a project-derived label so an unnamed group never lands as an empty card. */
export function resolveTerminalGroupName(name: string, repoDisplayName: string): string {
  return name.trim() || `${repoDisplayName} terminals`
}

async function preflightTerminalGroupAgentTrust(args: {
  agent: TuiAgent | null
  workspacePath: string
  connectionId?: string | null
}): Promise<void> {
  if (!args.agent || !window.api.agentTrust?.markTrusted) {
    return
  }
  const preflight = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preflight || !args.workspacePath) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Best-effort: the user can still accept the agent trust prompt manually.
  }
}

export async function submitTerminalGroupCreate({
  repo,
  name,
  agent,
  platform,
  agentCmdOverrides,
  agentArgs,
  agentEnv,
  terminalWindowsShell,
  launchSource = 'sidebar',
  createTerminalGroup,
  onOpenChange
}: SubmitTerminalGroupCreateParams): Promise<boolean> {
  const isRemote = repoIsRemote(repo)
  const startupPlan = agent
    ? buildAgentStartupPlan({
        agent,
        prompt: '',
        cmdOverrides: agentCmdOverrides ?? {},
        agentArgs,
        agentEnv,
        platform,
        shell: resolveLocalWindowsAgentStartupShell({
          platform,
          isRemote,
          terminalWindowsShell
        }),
        isRemote,
        allowEmptyPromptLaunch: true
      })
    : null

  const worktree = await createTerminalGroup({
    repoId: repo.id,
    name: resolveTerminalGroupName(name, repo.displayName)
  })
  if (!worktree) {
    return false
  }
  // The group runs in the project checkout, so trust is granted for that path.
  await preflightTerminalGroupAgentTrust({
    agent,
    workspacePath: worktree.path,
    connectionId: repo.connectionId
  })
  if (startupPlan && !startupPlan.launchToken) {
    // Why: delayed delivery must target the exact pane spawned from this queued
    // startup, so both halves share one renderer-session token.
    startupPlan.launchToken = createBrowserUuid()
  }
  const startup =
    agent && startupPlan
      ? {
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          launchConfig: startupPlan.launchConfig,
          ...(startupPlan.launchToken ? { launchToken: startupPlan.launchToken } : {}),
          launchAgent: agent,
          ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
          telemetry: {
            agent_kind: tuiAgentToAgentKind(agent),
            launch_source: launchSource,
            request_kind: 'new' as const
          }
        }
      : undefined
  onOpenChange(false)
  try {
    const activation = activateAndRevealWorktree(worktree.id, startup ? { startup } : {})
    if (startupPlan?.followupPrompt && activation !== false) {
      void ensureAgentStartupInTerminal({
        worktreeId: worktree.id,
        primaryTabId: activation.primaryTabId,
        startup: startupPlan
      })
    }
  } catch (error) {
    // Why: creation already succeeded. Do not leave the completed create modal
    // open if the follow-up reveal/startup path hits a transient issue.
    console.error('Failed to activate terminal group after create:', error)
  }
  return true
}
