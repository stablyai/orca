import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useActiveSkillDiscoveryRuntimeTarget } from '../discovery/use-active-skill-discovery-runtime-target'
import { useWindowsTerminalCapabilities } from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import { servingExecutionHostId } from '@/lib/skills/runtime/bundled-skill-target'
import {
  resolveProjectSkillRuntime,
  type ProjectSkillRuntime
} from '@/lib/skills/runtime/project-skill-runtime-resolution'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { useAppStore } from '@/store/index'
import { getPairedWebClientEnvironmentId } from '@/app-shell/platform/paired-web-client-host'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

// Compare the full serialized Windows resolution so equal store-driven reconstructions retain discovery identity, including future fields.
function activeProjectSkillRuntimeIdentity(runtime: ProjectSkillRuntime): string {
  return JSON.stringify(runtime)
}

/** The active project's skill runtime; with hostId, that host's, using the active project only when it lives there. */
export function useActiveProjectSkillRuntime(hostId?: ExecutionHostId): ProjectSkillRuntime {
  const runtimeState = useAppStore(
    useShallow((state) => ({
      activeRepoId: state.activeRepoId,
      activeWorktreeId: state.activeWorktreeId,
      projects: state.projects,
      repos: state.repos,
      folderWorkspaces: selectFolderWorkspaces(state),
      projectGroups: state.projectGroups,
      settings: state.settings,
      worktreesByRepo: selectWorktreesByRepo(state)
    }))
  )
  const activeWorkspaceHostId = useAppStore((state) =>
    servingExecutionHostId(
      getResolvedExecutionHostIdForWorktree(state, state.activeWorktreeId),
      state.runtimeEnvironments
    )
  )
  const currentPlatform = getCurrentPlatform()
  const windowsCapabilities = useWindowsTerminalCapabilities(currentPlatform === 'win32')
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  const webClientEnvironmentId = useAppStore(getPairedWebClientEnvironmentId)

  const resolved = useMemo(() => {
    const input = {
      state: runtimeState,
      activeWorkspaceHostId,
      runtimeTarget,
      currentPlatform,
      wslContext: {
        wslAvailable: windowsCapabilities.isLoading ? undefined : windowsCapabilities.wslAvailable,
        availableWslDistros: windowsCapabilities.isLoading ? null : windowsCapabilities.wslDistros
      },
      hostId,
      webClientEnvironmentId
    }
    return resolveProjectSkillRuntime(input)
  }, [
    activeWorkspaceHostId,
    currentPlatform,
    hostId,
    runtimeState,
    runtimeTarget,
    webClientEnvironmentId,
    windowsCapabilities
  ])

  // Keep content-equal runtime identity; update React state during render so discarded renders cannot leak ref writes.
  const [stable, setStable] = useState(resolved)
  const stableIdentity = activeProjectSkillRuntimeIdentity(stable)
  const resolvedIdentity = activeProjectSkillRuntimeIdentity(resolved)
  if (stableIdentity !== resolvedIdentity) {
    setStable(resolved)
  }
  return stableIdentity === resolvedIdentity ? stable : resolved
}

function getCurrentPlatform(): NodeJS.Platform {
  const platform =
    typeof window === 'undefined' ? undefined : window.api?.platform?.get?.()?.platform
  if (platform) {
    return platform
  }

  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  return 'linux'
}
