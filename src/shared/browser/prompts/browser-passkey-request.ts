/** Guest frame → main: whether the frame's document is waiting on a passkey (WebAuthn) request. */
export const BROWSER_PASSKEY_REQUEST_PENDING_CHANNEL = 'browser:passkeyRequestPending'
/** Main → guest frame: cancel its pending passkey requests. */
export const BROWSER_PASSKEY_REQUEST_CANCEL_CHANNEL = 'browser:passkeyRequestCancel'

/** What an agent should do about a page's pending passkey request. */
export function formatBrowserPasskeyRequest(origin: string, dismissCommand: string): string {
  return `${origin} is waiting for a passkey or security key, which you can't provide. Ask the user to finish it, or run \`${dismissCommand}\` to cancel it.`
}
