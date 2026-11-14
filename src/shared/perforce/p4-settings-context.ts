import { AsyncLocalStorage } from 'node:async_hooks'
import { DEFAULT_PERFORCE_SETTINGS, type PerforceSettings } from './perforce-settings'

// Why: the p4 runner is shared by the desktop app and the relay; a request-scoped context lets each call use its caller's settings without threading them through every function.
const storage = new AsyncLocalStorage<PerforceSettings>()

export function runWithPerforceSettings<T>(settings: PerforceSettings, run: () => T): T {
  return storage.run(settings, run)
}

export function currentPerforceSettings(): PerforceSettings {
  return storage.getStore() ?? DEFAULT_PERFORCE_SETTINGS
}
