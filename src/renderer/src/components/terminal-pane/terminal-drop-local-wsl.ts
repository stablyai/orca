import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import type { useAppStore } from '@/store'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { parseWslUncPath } from '../../../../shared/wsl-paths'

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
