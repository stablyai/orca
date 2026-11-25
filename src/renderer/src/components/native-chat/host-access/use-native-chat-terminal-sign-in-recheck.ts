import { useEffect, useEffectEvent, useRef } from 'react'
import { useAppStore } from '@/store/index'

export type NativeChatTerminalSignIn = {
  identity: string
  ticket: number
  worktreeId: string | null
  tabId?: string
}

export function useNativeChatTerminalSignInRecheck(
  signIn: NativeChatTerminalSignIn | null,
  isVisible: boolean | undefined,
  check: (ticket: number) => Promise<boolean>,
  onFinished: (ticket: number, signedIn: boolean) => void
): void {
  const checkSignIn = useEffectEvent(check)
  const finish = useEffectEvent(onFinished)
  const chatVisible = useEffectEvent(() => isVisible !== false)
  const refreshOnReturn = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!signIn) {
      return
    }
    let cancelled = false
    let checking = false
    let checkAgain = false
    let terminalEnded = false
    const refresh = async () => {
      if (checking) {
        checkAgain = true
        return
      }
      checking = true
      do {
        checkAgain = false
        const final = terminalEnded
        const signedIn = await checkSignIn(signIn.ticket).catch(() => false)
        if (cancelled) {
          return
        }
        if (final || (signedIn && !terminalEnded)) {
          finish(signIn.ticket, signedIn)
          return
        }
      } while (checkAgain)
      checking = false
    }
    const requestRefresh = () => void refresh()
    refreshOnReturn.current = requestRefresh
    const onFocus = () => {
      if (chatVisible()) {
        requestRefresh()
      }
    }
    window.addEventListener('focus', onFocus)
    const stopWatching = signIn.tabId
      ? watchSignInPty(signIn.tabId, signIn.worktreeId, () => {
          terminalEnded = true
          requestRefresh()
        })
      : undefined
    return () => {
      cancelled = true
      refreshOnReturn.current = null
      window.removeEventListener('focus', onFocus)
      stopWatching?.()
    }
  }, [signIn])
  useEffect(() => {
    if (isVisible) {
      refreshOnReturn.current?.()
    }
  }, [isVisible])
}

function watchSignInPty(tabId: string, worktreeId: string | null, onExit: () => void): () => void {
  const read = (state: ReturnType<typeof useAppStore.getState>) => ({
    ptys: state.ptyIdsByTabId[tabId],
    tabs: worktreeId ? state.tabsByWorktree[worktreeId] : undefined
  })
  const initial = read(useAppStore.getState())
  let ptyId: string | undefined = initial.ptys?.[0]
  let seenTab = initial.tabs?.some((tab) => tab.id === tabId) ?? false
  return useAppStore.subscribe((state, previous) => {
    const { ptys, tabs } = read(state)
    const prior = read(previous)
    if (ptys === prior.ptys && tabs === prior.tabs) {
      return
    }
    const hasTab = tabs?.some((tab) => tab.id === tabId) ?? false
    if ((ptyId && !ptys?.includes(ptyId)) || (seenTab && !hasTab)) {
      ptyId = undefined
      seenTab = false
      onExit()
      return
    }
    ptyId ??= ptys?.[0]
    seenTab ||= hasTab
  })
}
