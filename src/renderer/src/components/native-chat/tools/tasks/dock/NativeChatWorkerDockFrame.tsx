import { useLatestHandler } from '@/lib/use-latest-handler'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

const GestureContext = createContext(false)
const RosterContext = createContext({ expanded: false, setExpanded: (_value: boolean) => {} })
export function useWorkerDockRosterState() {
  return useContext(RosterContext)
}
export function useWorkerDockGestureHeld(): boolean {
  return useContext(GestureContext)
}

function observeDockFrame(element: HTMLDivElement | null, measure: () => void) {
  const pane = element?.closest('[data-native-chat-root]')
  if (!element || !pane) {
    return
  }
  let scheduled = 0
  const schedule = () => {
    cancelAnimationFrame(scheduled)
    scheduled = requestAnimationFrame(measure)
  }
  const resize = new ResizeObserver(schedule)
  const observeChildren = () => {
    resize.disconnect()
    resize.observe(pane)
    resize.observe(element)
    for (const child of element.children) {
      resize.observe(child)
    }
    schedule()
  }
  observeChildren()
  element.addEventListener('scroll', schedule)
  const mutations = new MutationObserver(observeChildren)
  mutations.observe(element, { childList: true, subtree: true })
  return () => {
    resize.disconnect()
    mutations.disconnect()
    element.removeEventListener('scroll', schedule)
    cancelAnimationFrame(scheduled)
  }
}

/** Defer structural dock updates through pointerup/click and a complete Enter/Space gesture. */
export function NativeChatWorkerDockFrame({ children }: { children: ReactNode }) {
  const [held, setHeld] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | undefined>(undefined)
  const measure = useLatestHandler(() => {
    const element = frame.current
    if (held || !element || !element.getClientRects().length) {
      return
    }
    const paneHeight =
      element.closest('[data-native-chat-root]')?.getBoundingClientRect().height ?? innerHeight
    const cap = Math.max(44, Math.min(paneHeight * 0.4, paneHeight - 180))
    const border = Number.parseFloat(getComputedStyle(element).borderBottomWidth) || 0
    const contentCap = cap - border
    const top = element.getBoundingClientRect().top
    let boundary = cap
    for (const row of element.querySelectorAll<HTMLElement>(
      '[data-native-chat-worker-question-summary]'
    )) {
      const rect = row.getBoundingClientRect()
      const queue = row.parentElement?.getBoundingClientRect()
      if (queue && (rect.bottom <= queue.top || rect.top >= queue.bottom)) {
        continue
      }
      const bottom = rect.bottom - top
      const start = rect.top - top
      if (start > 0 && start < contentCap && bottom > contentCap) {
        const first = row.parentElement?.firstElementChild === row
        boundary = Math.min(boundary, start + border - (first ? 24 : 0))
      }
    }
    setHeight(Math.max(44, Math.min(Math.floor(cap), Math.ceil(boundary))))
  })
  useLayoutEffect(measure, [held, measure])
  useEffect(() => observeDockFrame(frame.current, measure), [measure])
  useEffect(() => {
    if (!held) {
      return
    }
    let release: ReturnType<typeof setTimeout> | undefined
    const end = () => {
      clearTimeout(release)
      release = setTimeout(() => setHeld(false), 0)
    }
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
    const keyEnd = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        end()
      }
    }
    window.addEventListener('keyup', keyEnd, true)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      window.removeEventListener('keyup', keyEnd, true)
      window.removeEventListener('blur', end)
      clearTimeout(release)
    }
  }, [held])
  const pointer = useRef<number | null>(null)
  const roster = useMemo(() => ({ expanded, setExpanded }), [expanded])
  return (
    <RosterContext.Provider value={roster}>
      <GestureContext.Provider value={held}>
        <div
          ref={frame}
          data-native-chat-worker-dock=""
          className="scrollbar-sleek -mx-1.5 -mt-1.5 mb-1.5 min-h-0 overflow-y-auto rounded-t-xl border-b border-border bg-muted/50"
          style={{ maxHeight: height ?? 'min(40cqh, calc(100cqh - 180px))' }}
          onPointerDownCapture={(event) => {
            if (event.button === 0) {
              pointer.current = event.pointerId
              setHeld(true)
            }
          }}
          onPointerUpCapture={(event) => {
            if (pointer.current === event.pointerId) {
              pointer.current = null
              setTimeout(() => setHeld(false), 0)
            }
          }}
          onPointerCancelCapture={() => {
            pointer.current = null
            setHeld(false)
          }}
          onKeyDownCapture={(event) => {
            if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
              setHeld(true)
            }
          }}
          onKeyUpCapture={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              setTimeout(() => setHeld(false), 0)
            }
          }}
        >
          {children}
        </div>
      </GestureContext.Provider>
    </RosterContext.Provider>
  )
}

export function useWorkerDockStructuralValue<T>(value: T): T {
  const held = useWorkerDockGestureHeld()
  const [previous, setPrevious] = useState({ value })
  if (!held && previous.value !== value) {
    setPrevious({ value })
  }
  return held ? previous.value : value
}
