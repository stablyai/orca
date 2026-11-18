/** Why a project of the distro is listed under "Not moving", in the move dialog's words. */
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function wslMoveScopeRefusalReason(reason: string, t: Translate = translate): string {
  switch (reason) {
    case 'windows-drive':
      return t(
        'wslMove.scopeRefused.windowsDrive',
        'Its folder is on a Windows drive, so it stays on this computer.'
      )
    case 'mixed-locations':
      return t(
        'wslMove.scopeRefused.mixedLocations',
        'Some of its folders are outside this distro, so it stays on this computer.'
      )
    case 'not-local':
      return t('wslMove.scopeRefused.notLocal', 'It already runs on another host.')
    case 'windows-git-worktrees':
      return t(
        'wslMove.scopeRefused.windowsGitWorktrees',
        'Git for Windows recorded some of its worktrees, including any since deleted, and Git on the WSL host can’t use those records. Remove those worktrees, or run git worktree repair from WSL, then move it.'
      )
    case 'windows-git-dir':
      return t(
        'wslMove.scopeRefused.windowsGitDir',
        'Its Git folder is linked by a Windows path (a worktree or a separate Git folder Git for Windows set up), which Git on the WSL host can’t follow.'
      )
    case 'git-unreadable':
      return t(
        'wslMove.scopeRefused.gitUnreadable',
        'Orca couldn’t read its Git details in time to check them, so it stays on this computer. Check again in a moment.'
      )
    case 'mapped-drive-unverifiable':
      return t(
        'wslMove.scopeRefused.mappedDriveUnverifiable',
        'Orca couldn’t check where its drive letter points just now. Make sure the drive is connected, then check again.'
      )
    default:
      return t('wslMove.scopeRefused.other', 'It cannot move.')
  }
}
