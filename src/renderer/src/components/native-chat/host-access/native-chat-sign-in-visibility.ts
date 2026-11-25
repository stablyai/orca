export type NativeChatSignInSurface = 'banner' | 'transcript' | 'queue'
type Candidate = { surface: NativeChatSignInSurface; visible: boolean; full: boolean }

/** Keep the composer stable while a recovery action crosses the scroll edge. */
export function createNativeChatSignInVisibility() {
  const candidates = new Map<string, Candidate>()
  const listeners = new Set<() => void>()
  let snapshot: { selected: string | null; banner: boolean } = { selected: null, banner: true }
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = (selected: string | null, banner: boolean) => {
    if (snapshot.selected === selected && snapshot.banner === banner) {
      return
    }
    snapshot = { selected, banner }
    listeners.forEach((notify) => notify())
  }
  const update = () => {
    clearTimeout(timer)
    const ordered = [...candidates].sort(
      (a, b) => Number(b[1].surface === 'queue') - Number(a[1].surface === 'queue')
    )
    const chosen =
      ordered.find(([, value]) => value.full) ?? ordered.find(([, value]) => value.visible)
    if (chosen?.[1].full) {
      publish(chosen[0], false)
    } else if (chosen) {
      publish(chosen[0], snapshot.banner)
    } else {
      const selected = ordered[0]?.[0] ?? null
      publish(selected, snapshot.banner)
      if (!snapshot.banner) {
        timer = setTimeout(() => publish(selected, true), 300)
      }
    }
  }
  return {
    subscribe: (notify: () => void) => {
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    read: () => snapshot,
    observe: (key: string, surface: NativeChatSignInSurface, element: Element) => {
      const candidate = { surface, visible: false, full: false }
      candidates.set(key, candidate)
      update()
      let root = element.parentElement
      while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) {
        root = root.parentElement
      }
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries.at(-1)
          if (!entry || candidates.get(key) !== candidate) {
            return
          }
          candidate.visible = entry.isIntersecting && entry.intersectionRatio > 0
          candidate.full = entry.isIntersecting && entry.intersectionRatio >= 1
          update()
        },
        { root, threshold: [0, 0.01, 1] }
      )
      observer.observe(element)
      return () => {
        observer.disconnect()
        if (candidates.get(key) === candidate) {
          candidates.delete(key)
          update()
        }
      }
    },
    dispose: () => {
      clearTimeout(timer)
      listeners.clear()
      candidates.clear()
      snapshot = { selected: null, banner: true }
    }
  }
}
