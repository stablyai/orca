import type { AppState } from '@/store/types'
import { resolveWorktreeExecutionHostPlatform } from '@/lib/execution-host-facts'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  claudeConfigProfileLaunchEnv,
  type ClaudeConfigProfile
} from '../../../shared/claude-config-profiles'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'

/** Whether a local project's resolved or preferred runtime is WSL. */
function runsInWsl(runtime: ProjectExecutionRuntimeResolution | undefined): boolean {
  return runtime?.status === 'resolved'
    ? runtime.runtime.kind === 'wsl'
    : runtime?.status === 'repair-required' && runtime.repair.preferredRuntime.kind === 'wsl'
}

/** Profile folders are paths on this computer, so SSH, Orca servers and WSL runtimes (a `\\wsl$` folder or a Windows-drive project set to WSL) cannot use them. */
export function claudeConfigProfilesRunHere(state: AppState, worktreeId: string): boolean {
  const workspacePath = (
    state.getKnownWorktreeById?.(worktreeId) ??
    state.allWorktrees?.().find((entry) => entry.id === worktreeId)
  )?.path
  const host = resolveWorktreeExecutionHostPlatform(state, worktreeId, workspacePath)
  if (host.kind !== 'known' || host.hostKind !== 'local') {
    return false
  }
  if (workspacePath && isWslUncPath(workspacePath)) {
    return false
  }
  if (isWebRuntimeSessionActive(runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId))) {
    return false
  }
  return !runsInWsl(getLocalProjectExecutionRuntimeContext(state, worktreeId))
}

/** The saved profiles a menu for this workspace may offer; none where their folders are out of reach. */
export function launchableClaudeConfigProfiles(
  state: AppState,
  worktreeId: string | undefined
): ClaudeConfigProfile[] | undefined {
  const profiles = state.settings?.claudeConfigProfiles
  return profiles?.length && worktreeId && claudeConfigProfilesRunHere(state, worktreeId)
    ? profiles
    : undefined
}

/** `undefined`: an ordinary launch. `null`: refuse, since running without the folder would use another login. */
export function claudeConfigProfileLaunchEnvFor(args: {
  agent: TuiAgent
  profileId: string | undefined
  profiles: readonly ClaudeConfigProfile[] | undefined
  local: boolean
}): Record<string, string> | null | undefined {
  if (args.profileId === undefined) {
    return undefined
  }
  const profile = args.profiles?.find((candidate) => candidate.id === args.profileId)
  return profile && args.agent === 'claude' && args.local
    ? claudeConfigProfileLaunchEnv(profile)
    : null
}
