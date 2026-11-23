// One owner for the long-chat list: hover timers, keyboard opening, the Escape latch and teardown.

import { useCallback, useEffect, useRef, useState } from 'react'

export const NATIVE_CHAT_RAIL_LIST_OPEN_MS = 200
export const NATIVE_CHAT_RAIL_LIST_CLOSE_MS = 150

/** `hover` never holds focus or keys; `focus` is a dialog the reader is typing in. */
export type NativeChatRailListMode = 'hover' | 'focus'

export type NativeChatRailListOpen = {
  open: boolean
  mode: NativeChatRailListMode
  /** The tick focus returns to; it stays sampled and is the rail's tab stop while focus is inside. */
  openerId: string | null
  /** Bumped by every keyboard open, so an already-mounted panel still moves focus to its filter. */
  focusRequest: number
  pointerEnter: (event: React.PointerEvent) => void
  pointerLeave: (event: React.PointerEvent) => void
  openFromKeyboard: (openerId: string | null) => void
  /** Focus entered a hover-opened panel, as by clicking its filter. */
  promote: (openerId: string | null) => void
  close: (reason: 'escape' | 'pick' | 'blur') => void
  /** The opener's message left the rail. */
  dropOpener: () => void
}

export function useNativeChatRailListOpen({
  enabled,
  railRef,
  panelRef
}: {
  enabled: boolean
  railRef: React.RefObject<HTMLElement | null>
  panelRef: React.RefObject<HTMLElement | null>
}): NativeChatRailListOpen {
  const [state, setState] = useState<{
    open: boolean
    mode: NativeChatRailListMode
    openerId: string | null
    focusRequest: number
  }>({ open: false, mode: 'hover', openerId: null, focusRequest: 0 })
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const [latched, setLatched] = useState(false)
  const latchedRef = useRef(false)
  latchedRef.current = latched
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  // Teardown: hidden, cleared, subagent view, narrow or short. Focus is the pane's to hand off.
  const [wasEnabled, setWasEnabled] = useState(enabled)
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled)
    if (!enabled) {
      setState((current) => ({ ...current, open: false, mode: 'hover', openerId: null }))
      setLatched(false)
    }
  }
  const modeRef = useRef(state.mode)
  modeRef.current = state.mode

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  const shut = useCallback(() => {
    clearTimers()
    setState((current) =>
      current.open || current.openerId !== null
        ? { ...current, open: false, mode: 'hover', openerId: null }
        : current
    )
  }, [clearTimers])

  useEffect(() => {
    if (!enabled) {
      clearTimers()
    }
  }, [clearTimers, enabled])

  // After Escape, hover stays closed until the pointer is seen outside the rail and list.
  useEffect(() => {
    if (!latched) {
      return
    }
    const onMove = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null
      if (!railRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setLatched(false)
      }
    }
    document.addEventListener('pointermove', onMove, true)
    return () => document.removeEventListener('pointermove', onMove, true)
  }, [latched, panelRef, railRef])

  const pointerEnter = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || event.pointerType === 'touch') {
        return
      }
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
      if (latchedRef.current || openTimer.current !== null) {
        return
      }
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null
        if (!enabledRef.current) {
          return
        }
        setState((current) => (current.open ? current : { ...current, open: true, mode: 'hover' }))
      }, NATIVE_CHAT_RAIL_LIST_OPEN_MS)
    },
    [enabled]
  )

  const pointerLeave = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === 'touch') {
      return
    }
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    // Focus mode belongs to the keyboard: only focus leaving closes it.
    if (modeRef.current === 'focus' || closeTimer.current !== null) {
      return
    }
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setState((current) =>
        current.open && current.mode === 'hover'
          ? { ...current, open: false, openerId: null }
          : current
      )
    }, NATIVE_CHAT_RAIL_LIST_CLOSE_MS)
  }, [])

  const openFromKeyboard = useCallback(
    (openerId: string | null) => {
      if (!enabled) {
        return
      }
      clearTimers()
      setState((current) => ({
        open: true,
        mode: 'focus',
        openerId,
        focusRequest: current.focusRequest + 1
      }))
    },
    [clearTimers, enabled]
  )

  const promote = useCallback(
    (openerId: string | null) => {
      clearTimers()
      setState((current) =>
        current.open && current.mode === 'hover' ? { ...current, mode: 'focus', openerId } : current
      )
    },
    [clearTimers]
  )

  const close = useCallback(
    (reason: 'escape' | 'pick' | 'blur') => {
      shut()
      if (reason === 'escape') {
        setLatched(true)
      }
    },
    [shut]
  )

  const dropOpener = useCallback(() => {
    setState((current) => (current.openerId === null ? current : { ...current, openerId: null }))
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  return {
    ...state,
    pointerEnter,
    pointerLeave,
    openFromKeyboard,
    promote,
    close,
    dropOpener
  }
}
