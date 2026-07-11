import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { isPosixAbsolutePath } from '@/lib/terminal-path-normalization'
import { useAppStore } from '@/store'
import { getWslRuntimeDistro } from '../../../../shared/wsl-repo-identity'
import { toWindowsWslPath } from '../../../../shared/wsl-paths'

// Why: WSL-runtime terminals report POSIX cwds/paths. The generic terminal-link
// resolver in terminal-links.ts only joins path text against that cwd, so its
// output is still a POSIX path that Win32 fs calls would misread as a Windows
// drive-relative one. This module maps a resolved POSIX path onto the pane's
// WSL distro UNC share and confirms existence 9P-safely instead (#8156).

/** WSL distro for the pane's worktree, or null when it isn't a WSL-runtime pane. */
export function getPaneWslRuntimeDistro(worktreeId: string): string | null {
  return getWslRuntimeDistro(
    getLocalProjectExecutionRuntimeContext(useAppStore.getState(), worktreeId)
  )
}

/** Maps a resolved POSIX absolute path onto the distro's UNC share, or null if not applicable. */
export function resolveWslLinkAbsolutePath(
  resolvedAbsolutePath: string,
  wslDistro: string | null
): string | null {
  return wslDistro && isPosixAbsolutePath(resolvedAbsolutePath)
    ? toWindowsWslPath(resolvedAbsolutePath, wslDistro)
    : null
}

/**
 * Why: Win32 fs.stat over the WSL 9P share can falsely report ENOENT; ask the
 * distro directly instead. An inconclusive (null) answer stays clickable, same
 * as other filesystem-probing gaps in this module.
 */
export async function wslLinkPathExists(uncPath: string): Promise<boolean> {
  return (await window.api.wsl.pathExists(uncPath)) !== false
}
