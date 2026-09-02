import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'

function getForkAgentLaunchPlatform(args: {
  repo: { connectionId?: string | null } | null | undefined
  worktreePath?: string | null
  projectRuntime?: ProjectExecutionRuntimeResolution
}): NodeJS.Platform | undefined {
  if (args.projectRuntime?.status === 'repair-required') {
    return args.projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : undefined
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  if (args.repo?.connectionId || (args.worktreePath && isWslUncPath(args.worktreePath))) {
    return 'linux'
  }
  return undefined
}

async function preflightForkAgentTrust(args: {
  agent: TuiAgent
  workspacePath?: string | null
  connectionId?: string | null
}): Promise<void> {
  const { agent, workspacePath, connectionId } = args
  const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
  if (!preflight || !workspacePath || !window.api.agentTrust?.markTrusted) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath,
      ...(connectionId ? { connectionId } : {})
    })
  } catch {
    // Best-effort: if the trust artifact cannot be written, keep the existing launch path.
  }
}

/**
 * Launch the fork's agent in a new terminal tab of `worktreeId` with the
 * captured transcript delivered as an editable draft.
 *
 * Why: trust preflight, launch-platform resolution, and the draft launch are
 * identical whether the fork lands in a fresh worktree or a new tab in the
 * source worktree — only the target worktree/path differs. Returns `'failed'`
 * when no startup plan can be built so callers fall back to copying the context.
 */
export async function launchForkAgentTab(args: {
  agent: TuiAgent
  worktreeId: string
  prompt: string
  workspacePath?: string | null
  repo: { connectionId?: string | null } | null | undefined
  projectRuntime?: ProjectExecutionRuntimeResolution
}): Promise<'launched' | 'failed'> {
  await preflightForkAgentTrust({
    agent: args.agent,
    workspacePath: args.workspacePath,
    connectionId: args.repo?.connectionId
  })
  const launchPlatform = getForkAgentLaunchPlatform({
    repo: args.repo,
    worktreePath: args.workspacePath,
    projectRuntime: args.projectRuntime
  })
  const result = launchAgentInNewTab({
    agent: args.agent,
    worktreeId: args.worktreeId,
    prompt: args.prompt,
    promptDelivery: 'draft',
    launchSource: 'terminal_context_menu',
    ...(launchPlatform ? { launchPlatform } : {})
  })
  return result ? 'launched' : 'failed'
}
