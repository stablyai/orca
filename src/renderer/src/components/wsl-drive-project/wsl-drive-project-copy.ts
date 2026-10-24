/** Plain-language copy for converting a WSL project on a Windows drive to Windows Git. */
import { translate } from '@/i18n/i18n'
import type { WslDriveProjectBlocker } from '../../../../shared/wsl-drive-project-types'

export function wslDriveProjectBlockerMessage(blocker: WslDriveProjectBlocker): string {
  switch (blocker.kind) {
    case 'not-wsl-runtime':
      return translate(
        'wslDriveProject.blocker.notWsl',
        'This project already runs Git on Windows.'
      )
    case 'runtime-needs-repair':
      return translate(
        'wslDriveProject.blocker.repair',
        'Fix this project’s WSL runtime first: its distro is missing or WSL is not available.'
      )
    case 'not-windows-drive':
      return translate(
        'wslDriveProject.blocker.notWindowsDrive',
        'A folder of this project is not on a Windows drive.'
      )
    case 'windows-git-missing':
      return translate(
        'wslDriveProject.blocker.gitMissing',
        'Git for Windows is not installed. Install it from git-scm.com, then try again.'
      )
    case 'wsl-authored-worktrees':
      return translate(
        'wslDriveProject.blocker.wslWorktrees',
        'WSL Git created these workspaces, and Git for Windows cannot read them: {{paths}}. Remove them, or keep this project on WSL Git.',
        { paths: blocker.paths.join(', ') }
      )
    case 'worktree-folder-in-distro':
      return translate(
        'wslDriveProject.blocker.worktreeFolder',
        'New workspaces for this project are set to go inside WSL. Choose a folder on a Windows drive in this project’s settings first.'
      )
  }
}
