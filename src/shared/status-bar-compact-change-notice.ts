import { normalizeStatusBarUsageMode } from './status-bar-usage-mode'

/** Decide once, before defaults hide whether this profile had a saved choice. */
export function resolveStatusBarCompactChangeNoticeDismissed(args: {
  rawDismissed: unknown
  rawUsageMode: unknown
  isExistingProfile: boolean
}): boolean {
  if (typeof args.rawDismissed === 'boolean') {
    return args.rawDismissed
  }
  return (
    !args.isExistingProfile || normalizeStatusBarUsageMode(args.rawUsageMode) === args.rawUsageMode
  )
}
