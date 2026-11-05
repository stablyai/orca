import type { GlobalSettings } from './global-settings-types'

type Osc52ClipboardSettings = Pick<
  GlobalSettings,
  'terminalAllowOsc52Clipboard' | 'terminalAllowOsc52ClipboardDefaultedOnForAllUsers'
>

export function normalizeOsc52ClipboardDefaultOn(
  settings: Partial<Osc52ClipboardSettings> | undefined
): Osc52ClipboardSettings {
  const defaultedOn = settings?.terminalAllowOsc52ClipboardDefaultedOnForAllUsers === true

  return {
    // Only migration-stamped profiles distinguish explicit opt-out from the old persisted false default.
    terminalAllowOsc52Clipboard: defaultedOn
      ? (settings?.terminalAllowOsc52Clipboard ?? true)
      : true,
    terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
  }
}

/** Notify when migration enables OSC 52 over persisted false: both stores saved the old default,
 * so deliberate opt-outs cannot be distinguished. Fresh profiles lack that value and are excluded. */
export function osc52ClipboardDefaultOnOverridesPersistedOff(
  settings: Partial<Osc52ClipboardSettings> | undefined
): boolean {
  return (
    settings?.terminalAllowOsc52ClipboardDefaultedOnForAllUsers !== true &&
    settings?.terminalAllowOsc52Clipboard === false
  )
}
