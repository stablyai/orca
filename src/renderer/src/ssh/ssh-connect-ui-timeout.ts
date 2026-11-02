import { translate } from '@/i18n/i18n'

// Bound UI wait for unbounded ssh.connect; backend dialing continues after the control times out.
export const SSH_CONNECT_UI_TIMEOUT_MS = 20_000

// Reconnect includes 120s credential wait before 30s connect plus possible relay upload; composer budget would report timeout/resync against a soon-reachable host.
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
          // Retain NewWorkspaceComposerCard’s translation key for existing catalogs.
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
