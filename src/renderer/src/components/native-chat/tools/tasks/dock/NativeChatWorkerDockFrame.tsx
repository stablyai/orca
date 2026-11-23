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
const ScrollContext = createContext<{
  ref: React.RefObject<HTMLDivElement | null>
  shared: boolean
} | null>(null)
export function useWorkerDockScrollViewport(
  viewport: React.RefObject<HTMLDivElement | null>,
  narrow: boolean,
  expanded: boolean
) {
  const shared = useContext(ScrollContext)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    if (shared?.shared && shared.ref.current && viewport.current) {
      setScrollMargin(
        viewport.current.getBoundingClientRect().top -
          shared.ref.current.getBoundingClientRect().top +
          shared.ref.current.scrollTop
      )
    } else if (scrollMargin) {
      setScrollMargin(0)
    }
  }, [shared, viewport, narrow, expanded, scrollMargin])
  return { scroller: shared?.shared ? shared.ref : viewport, scrollMargin }
}
const RosterContext = createContext({ expanded: false, setExpanded: (_value: boolean) => {} })
function revealFocusedDockRow(frame: HTMLDivElement | null): boolean {
  const focused = document.activeElement
  if (
    !frame ||
    !(focused instanceof HTMLElement) ||
    !frame.contains(focused) ||
    !focused.closest('[data-native-chat-worker-question-summary], [data-worker-dock-row]')
  ) {
    return false
  }
  const bounds = frame.getBoundingClientRect()
  const top =
    bounds.top +
    (frame.querySelector('[data-worker-dock-header]')?.getBoundingClientRect().height ?? 0)
  const target = focused.getBoundingClientRect()
  if (target.top < top) {
    frame.scrollTop += target.top - top
  } else if (target.bottom > bounds.bottom - 1) {
    frame.scrollTop += target.bottom - bounds.bottom + 1
  }
  return true
}
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
  const [questions, setQuestions] = useState(false)
  const [height, setHeight] = useState<number | undefined>(undefined)
  const measure = useLatestHandler(() => {
    const element = frame.current
    if (held || !element || !element.getClientRects().length) {
      return
    }
    const hasQuestions = Boolean(element.querySelector('[data-native-chat-worker-approvals]'))
    if (questions !== hasQuestions) {
      setQuestions(hasQuestions)
    }
    const paneHeight =
      element.closest('[data-native-chat-root]')?.getBoundingClientRect().height ?? innerHeight
    const cap = Math.max(44, Math.min(paneHeight * 0.4, paneHeight - 180))
    if (!hasQuestions) {
      setHeight(Math.floor(cap))
      return
    }
    const border = Number.parseFloat(getComputedStyle(element).borderBottomWidth) || 0
    const contentCap = cap - border
    const top = element.getBoundingClientRect().top
    const headerHeight =
      element.querySelector('[data-worker-dock-header]')?.getBoundingClientRect().height ?? 0
    const firstQuestion = [
      ...element.querySelectorAll<HTMLElement>('[data-native-chat-worker-question-summary]')
    ].find((row) => row.getBoundingClientRect().bottom > top + headerHeight + 1)
    if (firstQuestion && firstQuestion.getBoundingClientRect().top <= top + headerHeight + 1) {
      setHeight(
        headerHeight + Math.max(1, Math.floor((cap - headerHeight - border) / 44)) * 44 + border
      )
      return
    }
    let boundary = cap
    for (const row of element.querySelectorAll<HTMLElement>(
      '[data-native-chat-worker-question-summary], [data-native-chat-background-tasks] [data-index]'
    )) {
      const rect = row.getBoundingClientRect()
      const queue = row.parentElement?.getBoundingClientRect()
      if (queue && (rect.bottom <= queue.top || rect.top >= queue.bottom)) {
        continue
      }
      const bottom = rect.bottom - top
      const start = rect.top - top
      if (start > 0 && start < contentCap && bottom > contentCap) {
        const first =
          row.hasAttribute('data-native-chat-worker-question-summary') &&
          row.parentElement?.firstElementChild === row
        boundary = Math.min(boundary, start + border - (first ? 24 : 0))
      }
    }
    setHeight(Math.max(44, Math.min(Math.floor(cap), Math.ceil(boundary))))
  })
  useLayoutEffect(measure, [held, measure])
  useLayoutEffect(() => {
    revealFocusedDockRow(frame.current)
  }, [height])
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
  const scrollEnd = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(scrollEnd.current), [])
  const roster = useMemo(() => ({ expanded, setExpanded }), [expanded])
  const scroll = useMemo(() => ({ ref: frame, shared: questions }), [questions])
  return (
    <RosterContext.Provider value={roster}>
      <GestureContext.Provider value={held}>
        <ScrollContext.Provider value={scroll}>
          <div
            ref={frame}
            data-native-chat-worker-dock=""
            className="group/worker-dock scrollbar-sleek -mx-1.5 -mt-1.5 mb-1.5 min-h-0 overflow-hidden rounded-t-xl border-b border-border bg-muted/50 [overflow-anchor:none] has-[[data-native-chat-worker-approvals]]:overflow-y-auto"
            style={{
              maxHeight: height ?? 'min(40cqh, calc(100cqh - 180px))',
              scrollPaddingTop: 44
            }}
            onFocusCapture={() => {
              if (pointer.current === null) {
                requestAnimationFrame(() => revealFocusedDockRow(frame.current))
              }
            }}
            onScroll={() => {
              clearTimeout(scrollEnd.current)
              scrollEnd.current = setTimeout(() => {
                const element = frame.current
                if (!element || pointer.current !== null) {
                  return
                }
                const top =
                  element.getBoundingClientRect().top +
                  (element.querySelector('[data-worker-dock-header]')?.getBoundingClientRect()
                    .height ?? 0)
                const rows = [
                  ...element.querySelectorAll<HTMLElement>(
                    '[data-native-chat-worker-question-summary], [data-native-chat-background-tasks] [data-index]'
                  )
                ]
                const first = rows.find((row) => row.getBoundingClientRect().bottom > top + 1)
                if (
                  !revealFocusedDockRow(element) &&
                  first &&
                  first.getBoundingClientRect().top < top - 1
                ) {
                  element.scrollTop += first.getBoundingClientRect().top - top
                }
                measure()
              }, 100)
            }}
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
        </ScrollContext.Provider>
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
