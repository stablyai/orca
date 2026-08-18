import { translate } from '@/i18n/i18n'

// Why: ssh.connect has no built-in timeout, so bound how long a UI control waits on it —
// a stalled backend connect must not leave a disabled spinner stuck forever. The backend
// keeps going regardless.
export const SSH_CONNECT_UI_TIMEOUT_MS = 20_000

// Why: a reconnect can legitimately outlast the composer budget — an interactive passphrase
// prompt alone allows 120s (main's CREDENTIAL_TIMEOUT_MS) before the 30s connect even starts,
// and a first relay deploy uploads a binary. A shorter fence would toast "timed out" and run
// the stale-metadata resync against a host that is about to connect fine.
export const SSH_RECONNECT_UI_TIMEOUT_MS = 180_000

export async function withUiConnectTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = SSH_CONNECT_UI_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          // Key kept from the original NewWorkspaceComposerCard home so existing
          // translations survive the move.
          translate(
            'auto.components.NewWorkspaceComposerCard.connectTimedOut',
            'Connection timed out. It may still be connecting in the background.'
          )
        )
      )
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
