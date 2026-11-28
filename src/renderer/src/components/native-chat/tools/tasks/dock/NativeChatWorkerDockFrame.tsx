import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/class-names'

const GestureContext = createContext(false)
export function useWorkerDockGestureHeld(): boolean {
  return useContext(GestureContext)
}

/** Defer structural dock updates through pointerup/click and a complete Enter/Space gesture.
 *  `overlay` is the worker chip's frame at the transcript's end: no top padding, so the chip's own
 *  zero-height row sits right on the transcript's end and floats the chip over it; anything else in
 *  it (the crew strip, a failed Stop's alert) takes its ordinary room. */
export function NativeChatWorkerDockFrame({
  overlay = false,
  children
}: {
  overlay?: boolean
  children: ReactNode
}) {
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
        // Capped like the message box: its content, not its padding, is the chat's column width.
        className={cn(
          'relative mx-auto w-full max-w-[calc(var(--chat-content-max-width)+var(--spacing)*6)] shrink-0 px-3 sm:max-w-[calc(var(--chat-content-max-width)+var(--spacing)*8)] sm:px-4 [&:not(:has([data-native-chat-background-tasks],[data-native-chat-worker-approvals]))]:hidden',
          overlay ? 'z-20' : 'pt-2'
        )}
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
