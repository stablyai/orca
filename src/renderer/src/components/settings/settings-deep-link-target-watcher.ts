/** Async rows can mount after the scroll effect; observe them so pending deep links resume. */

/** Bound observer lifetime when a target never mounts. */
const TARGET_WAIT_TIMEOUT_MS = 5000

export type SettingsDeepLinkTargetWatch = {
  cancel: () => void
}

export function watchForSettingsDeepLinkTarget(args: {
  root: HTMLElement | null
  isTargetPresent: () => boolean
  onTargetPresent: () => void
}): SettingsDeepLinkTargetWatch {
  const root = args.root ?? (typeof document === 'undefined' ? null : document.body)
  if (!root || typeof MutationObserver === 'undefined') {
    return { cancel: () => {} }
  }

  let settled = false
  let observer: MutationObserver | null = null
  let timeout: number | null = null

  const finish = (): void => {
    if (settled) {
      return
    }
    settled = true
    observer?.disconnect()
    observer = null
    if (timeout !== null) {
      window.clearTimeout(timeout)
      timeout = null
    }
  }

  observer = new MutationObserver(() => {
    if (settled || !args.isTargetPresent()) {
      return
    }
    finish()
    args.onTargetPresent()
  })
  observer.observe(root, { subtree: true, childList: true })
  timeout = window.setTimeout(finish, TARGET_WAIT_TIMEOUT_MS)

  return { cancel: finish }
}
