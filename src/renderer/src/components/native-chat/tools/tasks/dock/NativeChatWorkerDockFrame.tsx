import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

const GestureContext = createContext(false)
export function useWorkerDockGestureHeld(): boolean {
  return useContext(GestureContext)
}

/** Defer structural dock updates through pointerup/click and a complete Enter/Space gesture. */
export function NativeChatWorkerDockFrame({ children }: { children: ReactNode }) {
  const [held, setHeld] = useState(false)
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
  return (
    <GestureContext.Provider value={held}>
      <div
        data-native-chat-worker-dock=""
        // A tab strip (the goal) pads nothing above itself, so the dock's 8px row gap comes from here.
        // Capped like the message box: its content, not its padding, is the chat's column width.
        className="relative mx-auto w-full max-w-[calc(var(--chat-content-max-width)+var(--spacing)*6)] shrink-0 px-3 pt-2 sm:max-w-[calc(var(--chat-content-max-width)+var(--spacing)*8)] sm:px-4 [&:has(+[data-native-chat-composer-tab-strip])]:pb-2 [&:not(:has([data-native-chat-background-tasks],[data-native-chat-worker-approvals]))]:hidden"
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
