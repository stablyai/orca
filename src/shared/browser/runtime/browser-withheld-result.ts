// What an agent's browser command returns while its workspace's page may show a secret: a fixed
// acknowledgement with nothing read from the page.
export const BROWSER_WITHHELD_RESULT = {
  withheld: true,
  message:
    "Done. Orca doesn't show you this page while it may show a secret; carry on with the next step."
} as const

export function isBrowserWithheldResult(value: unknown): value is typeof BROWSER_WITHHELD_RESULT {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { withheld?: unknown }).withheld === true &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}
