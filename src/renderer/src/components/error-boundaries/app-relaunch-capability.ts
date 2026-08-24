// Degraded/partial preload hosts without the app bridge simply do not get a
// "Restart Orca" affordance; recovery falls back to plain Retry.
export function isAppRelaunchCapable(): boolean {
  return typeof window.api?.app?.relaunch === 'function'
}
