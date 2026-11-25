import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import { useNativeChatHostSetupView, type NativeChatHostSetup } from './native-chat-host-setup-view'
import type { NativeChatSignInSurface } from './native-chat-sign-in-visibility'

const EMPTY = { selected: null, banner: true }
const subscribe = () => () => {}
const read = () => EMPTY

export function useNativeChatSignInVisibility(setup: NativeChatHostSetup | null) {
  return useSyncExternalStore(
    setup?.visibility?.subscribe ?? subscribe,
    setup?.visibility?.read ?? read
  )
}

export function useNativeChatSignInCandidate(
  surface: NativeChatSignInSurface,
  failureId: string | undefined,
  eligible: boolean,
  anchor: RefObject<HTMLElement | null>
): boolean {
  const setup = useNativeChatHostSetupView()
  const visible = useNativeChatSignInVisibility(setup)
  const key = `${surface}:${failureId ?? ''}`
  const visibility = setup?.visibility
  useEffect(() => {
    if (!eligible || !anchor.current || !visibility) {
      return
    }
    const unobserve = visibility.observe(key, surface, anchor.current)
    return () => unobserve()
  }, [anchor, eligible, visibility, key, surface])
  return !visible.selected || visible.selected === key
}
