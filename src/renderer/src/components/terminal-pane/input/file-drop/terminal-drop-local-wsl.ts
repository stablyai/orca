import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/workspace/creation/new-workspace'
import { isWindowsAbsolutePathLike } from '../../../../../../shared/cross-platform-path'
import { parseWslUncPath } from '../../../../../../shared/wsl-paths'
import type { useAppStore } from '@/store/index'

export function isWorktreeUsingLocalWslRuntime(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): boolean {
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId, CLIENT_PLATFORM)
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl'
  }
  return projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
}

export function toLocalWslDropPath(path: string): string {
  const wslUnc = parseWslUncPath(path)
  if (wslUnc) {
    return wslUnc.linuxPath
  }
  if (isWindowsAbsolutePathLike(path)) {
    const drive = path[0].toLowerCase()
    return `/mnt/${drive}/${path.slice(3).replace(/\\/g, '/')}`
  }
  return path.replace(/\\/g, '/')
}
