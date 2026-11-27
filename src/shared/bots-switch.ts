// Settings › Bots › Enable bots: on unless turned off, so a profile saved before the setting has bots.
import type { GlobalSettings } from './settings/global-settings-types'

export const BOTS_DISABLED_CODE = 'bots_disabled'

export const BOTS_DISABLED_MESSAGE =
  'Bots are turned off in Settings › Bots. Turn on Enable bots there to create or use a bot.'

export class BotsDisabledError extends Error {
  readonly code = BOTS_DISABLED_CODE

  constructor(message = BOTS_DISABLED_MESSAGE) {
    super(message)
    this.name = 'BotsDisabledError'
  }
}

export function isBotsEnabled(
  settings: Pick<GlobalSettings, 'botsEnabled'> | null | undefined
): boolean {
  return settings?.botsEnabled !== false
}
