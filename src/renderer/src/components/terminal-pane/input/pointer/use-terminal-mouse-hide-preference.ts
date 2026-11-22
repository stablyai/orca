import { useEffect } from 'react'
import { installMouseHideWhileTyping } from './mouse-hide-while-typing'
import type { MountedTerminalPaneLifecycleDeps } from '../../mounting/terminal-pane-lifecycle-types'
import type { TerminalPaneLifecycleRefs } from '../../mounting/use-terminal-pane-lifecycle-refs'

export function useTerminalMouseHidePreference(
  deps: Pick<MountedTerminalPaneLifecycleDeps, 'mountedManager' | 'managerRef' | 'settings'>,
  refs: Pick<TerminalPaneLifecycleRefs, 'mouseHideDisposablesRef'>
): void {
  useEffect(() => {
    const manager = deps.managerRef.current
    if (!deps.mountedManager || manager !== deps.mountedManager) {
      return
    }
    const hide = deps.settings?.terminalMouseHideWhileTyping ?? false
    for (const pane of manager.getPanes()) {
      const existing = refs.mouseHideDisposablesRef.current.get(pane.id)
      if (hide && !existing) {
        refs.mouseHideDisposablesRef.current.set(
          pane.id,
          installMouseHideWhileTyping(pane.terminal, pane.container)
        )
      } else if (!hide && existing) {
        existing.dispose()
        refs.mouseHideDisposablesRef.current.delete(pane.id)
      }
    }
  }, [
    deps.mountedManager,
    deps.settings?.terminalMouseHideWhileTyping,
    deps.managerRef,
    refs.mouseHideDisposablesRef
  ])
}
