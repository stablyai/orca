/** Async rows can mount after the scroll effect; observe them so pending deep links resume. */
const TARGET_WAIT_TIMEOUT_MS = 5000

export type SettingsDeepLinkTargetWatch = { cancel: () => void }

export function watchForSettingsDeepLinkTarget(args: {
  root: HTMLElement | null
  isTargetPresent: () => boolean
  onTargetPresent: () => void
  onTimeout?: () => void
  timeoutMs?: number
  isTargetUnavailable?: () => boolean
  waitForLayout?: boolean
  cancelOnInteraction?: boolean
  onCancel?: () => void
}): SettingsDeepLinkTargetWatch {
  const root = args.root ?? (typeof document === 'undefined' ? null : document.body)
  if (!root || typeof MutationObserver === 'undefined') {
    return { cancel: () => {} }
  }
  const owner = root.ownerDocument
  let settled = false
  let observer: MutationObserver | null = null
  let timeout: number | null = null
  let frame: number | null = null
  const scrollPositions = new Map<Element, { top: number; left: number }>()
  for (const element of [root, ...root.querySelectorAll('[data-settings-scroll-list]')]) {
    scrollPositions.set(element, { top: element.scrollTop, left: element.scrollLeft })
  }
  const interactionEvents = ['pointerdown', 'click', 'keydown', 'input', 'focusin', 'scroll']
  const finish = (): void => {
    if (settled) {
      return
    }
    settled = true
    observer?.disconnect()
    observer = null
    if (frame !== null) {
      cancelAnimationFrame(frame)
    }
    frame = null
    if (timeout !== null) {
      window.clearTimeout(timeout)
    }
    timeout = null
    for (const name of interactionEvents) {
      owner.removeEventListener(name, onInteraction, true)
    }
  }
  const onInteraction = (event: Event): void => {
    if (event.type === 'scroll') {
      const target = event.target === owner ? owner.scrollingElement : event.target
      if (target instanceof Element) {
        const before = scrollPositions.get(target)
        if (target.scrollTop === (before?.top ?? 0) && target.scrollLeft === (before?.left ?? 0)) {
          return
        }
      }
    }
    finish()
    args.onCancel?.()
  }
  const check = (): void => {
    if (settled) {
      return
    }
    if (args.isTargetPresent()) {
      if (args.waitForLayout && frame === null) {
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            frame = null
            if (settled) {
              return
            }
            if (!args.isTargetPresent()) {
              check()
              return
            }
            finish()
            args.onTargetPresent()
          })
        })
      } else if (!args.waitForLayout) {
        finish()
        args.onTargetPresent()
      }
    } else if (args.isTargetUnavailable?.()) {
      finish()
      args.onTimeout?.()
    }
  }
  observer = new MutationObserver(check)
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: Boolean(args.isTargetUnavailable)
  })
  timeout = window.setTimeout(() => {
    finish()
    args.onTimeout?.()
  }, args.timeoutMs ?? TARGET_WAIT_TIMEOUT_MS)
  if (args.cancelOnInteraction) {
    for (const name of interactionEvents) {
      owner.addEventListener(name, onInteraction, true)
    }
  }
  check()
  return { cancel: finish }
}
