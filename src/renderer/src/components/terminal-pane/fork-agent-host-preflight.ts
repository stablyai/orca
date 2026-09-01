import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/types'
import { resolveTuiAgentConfig } from '../../../../shared/custom-tui-agents'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'

export function getForkAgentLaunchPlatform(args: {
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

export async function preflightForkAgentTrust(args: {
  agent: TuiAgent
  workspacePath?: string | null
  connectionId?: string | null
}): Promise<void> {
  const { agent, workspacePath, connectionId } = args
  // Why: resolve a custom id to its base harness's config before reading the
  // built-in-only trust preset — a raw custom id would index an undefined entry
  // and crash; a tombstoned/unknown id degrades to no preflight.
  const { settings } = useAppStore.getState()
  const preflight = resolveTuiAgentConfig(
    agent,
    settings?.customTuiAgents,
    settings?.deletedCustomTuiAgents
  )?.preflightTrust
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
