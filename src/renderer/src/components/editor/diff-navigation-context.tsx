import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { installDiffChangeNavigationShortcut } from './editor-shortcuts'

/** A mounted diff that can report its changes and scroll to one. */
export type DiffNavigator = {
  /** Modified-side start line of every hunk, in document order. */
  changeLines: readonly number[]
  scrollToChange: (args: { lineNumber: number; hunkIndex: number; hunkCount: number }) => void
  /** Element the F7 / Shift+F7 listener attaches to. */
  container: HTMLElement
}

export type DiffNavigatorRegistrationContextValue = {
  registerDiffNavigator: (navigator: DiffNavigator) => void
  unregisterDiffNavigator: (navigator: DiffNavigator) => void
}

export type DiffNavigationContextValue = {
  goToPreviousDiff: () => void
  goToNextDiff: () => void
  changeCount: number
}

const noop = (): void => {}

// Why: registration stays separate from changeCount so diff recomputation only
// rerenders the header controls, not the heavy diff consumer.
const DiffNavigatorRegistrationContext = createContext<DiffNavigatorRegistrationContextValue>({
  registerDiffNavigator: noop,
  unregisterDiffNavigator: noop
})

const DiffNavigationContext = createContext<DiffNavigationContextValue>({
  goToPreviousDiff: noop,
  goToNextDiff: noop,
  changeCount: 0
})

export function DiffNavigationProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const navigatorRef = useRef<DiffNavigator | null>(null)
  const shortcutCleanupRef = useRef<(() => void) | null>(null)
  // Why: the cursor is provider-owned because the renderer no longer tracks a
  // "current change" of its own the way Monaco's goToDiff did.
  const cursorRef = useRef(-1)
  // Why: changeCount must be state, not a ref — the header is a sibling consumer
  // and only re-renders (enabling the buttons) when the value identity changes.
  const [changeCount, setChangeCount] = useState(0)

  const goToChange = useCallback((direction: 'next' | 'previous') => {
    const navigator = navigatorRef.current
    if (!navigator) {
      return
    }
    const total = navigator.changeLines.length
    if (total === 0) {
      return
    }
    // Why: from the initial position, `next` lands on the first change and
    // `previous` wraps to the last — plain modulo would send both to index 0.
    const step = direction === 'next' ? 1 : -1
    const nextIndex =
      cursorRef.current === -1
        ? direction === 'next'
          ? 0
          : total - 1
        : (((cursorRef.current + step) % total) + total) % total
    cursorRef.current = nextIndex
    navigator.scrollToChange({
      lineNumber: navigator.changeLines[nextIndex],
      hunkIndex: nextIndex,
      hunkCount: total
    })
  }, [])

  const registerDiffNavigator = useCallback(
    (navigator: DiffNavigator) => {
      navigatorRef.current = navigator
      cursorRef.current = -1
      // Hold at most one keyboard listener; replace any prior navigator's.
      shortcutCleanupRef.current?.()
      shortcutCleanupRef.current = installDiffChangeNavigationShortcut(
        navigator.container,
        goToChange
      )
      setChangeCount(navigator.changeLines.length)
    },
    [goToChange]
  )

  const unregisterDiffNavigator = useCallback((navigator: DiffNavigator) => {
    // Why: identity guard for the fast-swap race — a stale teardown carrying the
    // old navigator must not wipe a freshly-registered new one.
    if (navigatorRef.current !== navigator) {
      return
    }
    shortcutCleanupRef.current?.()
    shortcutCleanupRef.current = null
    navigatorRef.current = null
    cursorRef.current = -1
    setChangeCount(0)
  }, [])

  const goToPreviousDiff = useCallback(() => goToChange('previous'), [goToChange])
  const goToNextDiff = useCallback(() => goToChange('next'), [goToChange])

  useEffect(() => {
    return () => {
      shortcutCleanupRef.current?.()
      shortcutCleanupRef.current = null
    }
  }, [])

  const registrationValue = useMemo(
    () => ({ registerDiffNavigator, unregisterDiffNavigator }),
    [registerDiffNavigator, unregisterDiffNavigator]
  )
  const navigationValue = useMemo(
    () => ({ goToPreviousDiff, goToNextDiff, changeCount }),
    [goToPreviousDiff, goToNextDiff, changeCount]
  )

  return (
    <DiffNavigatorRegistrationContext.Provider value={registrationValue}>
      <DiffNavigationContext.Provider value={navigationValue}>
        {children}
      </DiffNavigationContext.Provider>
    </DiffNavigatorRegistrationContext.Provider>
  )
}

export function useDiffNavigatorRegistration(): DiffNavigatorRegistrationContextValue {
  return useContext(DiffNavigatorRegistrationContext)
}

export function useDiffNavigation(): DiffNavigationContextValue {
  return useContext(DiffNavigationContext)
}
