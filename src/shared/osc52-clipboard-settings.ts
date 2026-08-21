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
    // Why: profiles saved under the old off default persisted `false`, which is
    // indistinguishable from a real opt-out; only stamped profiles can express one.
    terminalAllowOsc52Clipboard: defaultedOn
      ? (settings?.terminalAllowOsc52Clipboard ?? true)
      : true,
    terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
  }
}

/** True when the migration is about to turn OSC 52 on over a persisted `false`.
 *  Why surface it: flipping a security posture back on without telling anyone is worse
 *  than the copy bug. Scope is deliberately wide — both stores rewrite the whole settings
 *  object on every save, so every profile saved under the old off default holds `false`,
 *  opt-out or not. This is an upgrade notice, not an opt-out notice; the cohort that
 *  genuinely chose `false` is not distinguishable on disk. Fresh profiles have no
 *  persisted value and are correctly excluded. */
export function osc52ClipboardDefaultOnOverridesPersistedOff(
  settings: Partial<Osc52ClipboardSettings> | undefined
): boolean {
  return (
    settings?.terminalAllowOsc52ClipboardDefaultedOnForAllUsers !== true &&
    settings?.terminalAllowOsc52Clipboard === false
  )
}
