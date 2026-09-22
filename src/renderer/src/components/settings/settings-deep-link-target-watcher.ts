/**
 * A deep link can name a row that does not exist yet: panes such as Remote Orca
 * Servers render their rows only after an async fetch resolves. The scroll
 * effect parks its target in a ref, but nothing re-runs it when those rows
 * finally mount, so this watcher reports the moment they do.
 */

/** Give up eventually; a target that never mounts must not leave an observer alive. */
const TARGET_WAIT_TIMEOUT_MS = 5000

export type SettingsDeepLinkTargetWatch = {
  cancel: () => void
}

export function watchForSettingsDeepLinkTarget(args: {
  /** Subtree to observe; falls back to the document body when the pane has no scroll container yet. */
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
