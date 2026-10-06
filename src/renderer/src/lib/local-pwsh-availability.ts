let known: boolean | null = null
let reading = false

/**
 * Whether pwsh.exe is installed on this machine, from main's shared probe; null until it answers.
 * The first call starts the read, so a launch before then is planned without it.
 */
export function localPwshAvailability(): boolean | null {
  if (known === null && !reading && typeof window !== 'undefined' && window.api?.pwsh) {
    reading = true
    void window.api.pwsh
      .isAvailable()
      .then((available) => {
        known = available
      })
      .catch(() => {})
      .finally(() => {
        reading = false
      })
  }
  return known
}
