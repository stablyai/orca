/** Plain-language copy for why a UNC Windows-drive project can't be converted right now. */
import { translate } from '@/i18n/i18n'
import type {
  WslDriveUncConversionBlocker,
  WslDriveUncConversionResult
} from '../../../../shared/wsl-drive-unc-conversion-types'
import { wslDriveProjectBlockerMessage } from './wsl-drive-project-copy'

export function wslDriveUncConversionMessages(
  result: Exclude<WslDriveUncConversionResult, { outcome: 'restarting' }>,
  drivePath: string
): string[] {
  switch (result.outcome) {
    case 'refused':
      return result.blockers.map((blocker) => blockerMessage(blocker, drivePath))
    case 'terminals-blocked':
      return [
        translate(
          'wslDriveUnc.terminalsBusy',
          'Some terminals in this project are busy. Let them finish or close them, then try again.'
        )
      ]
    case 'pause-failed':
      return [
        translate(
          'wslDriveUnc.pauseFailed',
          'Orca could not pause this project’s terminals, so nothing changed.'
        )
      ]
  }
}

function blockerMessage(blocker: WslDriveUncConversionBlocker, drivePath: string): string {
  switch (blocker.kind) {
    case 'conversion-pending':
      return translate(
        'wslDriveUnc.blocker.pending',
        'Orca is already converting a project. It finishes when Orca restarts.'
      )
    case 'windows-git-missing':
    case 'wsl-authored-worktrees':
      return wslDriveProjectBlockerMessage(blocker)
    case 'state-conflict':
      if (blocker.cause === 'differing-saved-data') {
        return translate(
          'wslDriveUnc.blocker.differingState',
          'Orca saved different details for this folder under both its WSL path and {{drivePath}}, so nothing changed.',
          { drivePath }
        )
      }
      if (blocker.cause === 'project-split') {
        return translate(
          'wslDriveUnc.blocker.projectSplit',
          'This project also holds a repository that isn’t converting, so nothing changed.'
        )
      }
      return translate(
        'wslDriveUnc.blocker.state',
        'Orca found saved state for this project it can’t convert safely, so nothing changed.'
      )
    case 'not-convertible':
      switch (blocker.reason) {
        case 'duplicate-windows-project':
          return translate(
            'wslDriveUnc.blocker.duplicate',
            '{{drivePath}} is already a project in Orca.',
            { drivePath }
          )
        case 'mixed-locations':
          return translate(
            'wslDriveUnc.blocker.mixed',
            'Some of this project’s folders are inside WSL, not on a Windows drive.'
          )
        case 'not-windows-drive-mount':
          return translate(
            'wslDriveUnc.blocker.notDriveMount',
            'In this distro, that folder isn’t {{drivePath}}: it isn’t mounted from that Windows drive.',
            { drivePath }
          )
        case 'overlaps-refused-project':
          return translate(
            'wslDriveUnc.blocker.overlap',
            'This project shares folders with a project Orca can’t convert, so they would split.'
          )
        case 'not-local':
        case 'not-in-scope':
          return translate(
            'wslDriveUnc.blocker.notConvertible',
            'This project isn’t on a Windows drive on this computer.'
          )
      }
  }
}
