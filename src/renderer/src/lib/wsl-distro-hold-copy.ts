import { translate } from '@/i18n/i18n'
import {
  findWslDistroHoldInText,
  type WslDistroHoldState
} from '../../../shared/wsl-distro-stopped-hold'

export function localizedWslDistroHoldMessage(hold: {
  distro: string
  state: WslDistroHoldState
}): string {
  return hold.state === 'stopped'
    ? translate(
        'wslDistroHold.terminalStopped',
        "The WSL distro {{distro}} is stopped, so Orca didn't start this terminal. Start the distro, then try again.",
        { distro: hold.distro }
      )
    : translate(
        'wslDistroHold.terminalUnverifiable',
        "Orca couldn't check whether the WSL distro {{distro}} is running, so it didn't start this terminal. Start the distro, then try again.",
        { distro: hold.distro }
      )
}

/** Host text naming a held terminal (its code from older hosts, its English sentence from newer) in the user's language. */
export function localizeWslDistroHoldText(text: string): string {
  const found = findWslDistroHoldInText(text)
  return found ? text.split(found.matched).join(localizedWslDistroHoldMessage(found.hold)) : text
}
