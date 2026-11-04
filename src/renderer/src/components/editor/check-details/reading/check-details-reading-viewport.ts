import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { hasCheckReadingLayout } from '@/components/right-sidebar/check-log-initial-diagnostic-position'
import type { CheckDetailsReadingOwner } from './check-details-reading-owner'

export function attachCheckReadingViewport({
  node,
  owner,
  cacheKey,
  job,
  text,
  initial,
  consumeIntent,
  localPosition
}: {
  node: HTMLElement
  owner?: CheckDetailsReadingOwner
  cacheKey?: string
  job?: string
  text?: string | null
  initial?: () => number | null
  consumeIntent?: () => boolean
  localPosition?: { current: number | undefined }
}): () => void {
  let active = true
  let started = false
  let established = false
  let lastValid: number | undefined
  let retained: number | undefined
  let frame: number | undefined
  let programmatic: number | undefined
  let eligible = false
  const current = (): boolean => active && (!owner || owner.current(job, text))
  const observe = (): number | undefined => {
    if (!established || !hasCheckReadingLayout(node) || (text && node.textContent !== text)) {
      return lastValid ?? retained
    }
    const value = node.scrollTop
    if (Number.isFinite(value) && value >= 0) {
      lastValid = value
    }
    return lastValid ?? retained
  }
  const save = (): void => {
    if (!current()) {
      return
    }
    const value = observe()
    if (!owner && localPosition && value !== undefined) {
      localPosition.current = value
    }
    if (value !== undefined && owner && cacheKey && current()) {
      setWithLRU(scrollTopCache, cacheKey, value)
    }
  }
  const cancelFrame = (): void => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
    }
    frame = undefined
  }
  const cancel = (): void => {
    eligible = false
    cancelFrame()
  }
  const reading = (): void => {
    if (!current()) {
      return
    }
    if (owner) {
      owner.cancel(job)
    } else {
      cancel()
    }
    if (hasCheckReadingLayout(node)) {
      established = true
    }
  }
  const scroll = (): void => {
    if (!current()) {
      return
    }
    if (programmatic !== undefined && node.scrollTop === programmatic) {
      programmatic = undefined
    } else {
      programmatic = undefined
      if (owner) {
        owner.cancel(job)
      } else {
        cancel()
      }
    }
    save()
  }
  const pointer = (event: PointerEvent): void => {
    if (event.target === node) {
      reading()
    }
  }
  const keydown = (event: KeyboardEvent): void => {
    if (
      event.target === node &&
      ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)
    ) {
      reading()
    }
  }
  const setup = (lastAttempt: boolean): void => {
    if (!current()) {
      return
    }
    let target: number | null = retained ?? 0
    if (!hasCheckReadingLayout(node) || (text && node.textContent !== text)) {
      target = null
    } else if (eligible && initial) {
      target = initial()
    }
    if (target === null) {
      if (!lastAttempt) {
        frame = requestAnimationFrame(() => {
          frame = undefined
          setup(true)
        })
      } else if (eligible && retained === undefined && owner && cacheKey && current()) {
        setWithLRU(scrollTopCache, cacheKey, 0)
      }
      if (lastAttempt) {
        eligible = false
      }
      return
    }
    eligible = false
    node.scrollTop = Math.min(
      Math.max(0, node.scrollHeight - node.clientHeight),
      Math.max(0, target)
    )
    programmatic = node.scrollTop
    established = true
    save()
  }
  const start = (): void => {
    if (started || !current()) {
      return
    }
    started = true
    retained = cacheKey ? scrollTopCache.get(cacheKey) : localPosition?.current
    const intent = consumeIntent?.() ?? false
    eligible = retained === undefined && intent
    node.addEventListener('scroll', scroll)
    node.addEventListener('wheel', reading, { passive: true })
    node.addEventListener('touchstart', reading, { passive: true })
    node.addEventListener('pointerdown', pointer)
    node.addEventListener('keydown', keydown)
    setup(false)
  }
  const retire = (): number | undefined => {
    if (!active) {
      return undefined
    }
    save()
    const value = observe()
    active = false
    cancelFrame()
    node.removeEventListener('scroll', scroll)
    node.removeEventListener('wheel', reading)
    node.removeEventListener('touchstart', reading)
    node.removeEventListener('pointerdown', pointer)
    node.removeEventListener('keydown', keydown)
    return value
  }
  const unregister = owner?.register({ job, text, start, retire, cancel })
  if (!owner) {
    start()
  }
  return () => {
    save()
    retire()
    unregister?.()
  }
}
