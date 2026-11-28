/** A host lacking the WSL-source capability: an older Orca, or a server started outside WSL hosts. */
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  WSL_MOVE_HOST_LAUNCH_UNPROVEN_DETAIL,
  WSL_MOVE_HOST_NOT_WSL_LAUNCHED_DETAIL
} from '../../../../shared/wsl-move/wsl-move-driver-types'

export function wslMoveHostUpdateRequiredMessage(
  detail: string | undefined,
  distro: string,
  t: Translate = translate
): string {
  if (detail === WSL_MOVE_HOST_NOT_WSL_LAUNCHED_DETAIL) {
    return t(
      'wslMove.refusal.hostNotWslLaunched',
      "The Orca server in {{distro}} was not started as a WSL host (an SSH host for this distro usually started it), so it can't take these projects. Updating won't help. Choose Restart as WSL host on the {{distro}} host in Settings, then try again.",
      { distro }
    )
  }
  if (detail === WSL_MOVE_HOST_LAUNCH_UNPROVEN_DETAIL) {
    return t(
      'wslMove.refusal.hostLaunchUnproven',
      "The Orca server in {{distro}} runs this version of Orca but can't take these projects, so updating won't help. It may have been started outside WSL hosts, such as by an SSH host. Remove the {{distro}} host in Settings, then add it again.",
      { distro }
    )
  }
  return t(
    'wslMove.refusal.hostUpdateRequired',
    'The {{distro}} host runs an older version of Orca. Update it in Settings, then try again.',
    { distro }
  )
}
