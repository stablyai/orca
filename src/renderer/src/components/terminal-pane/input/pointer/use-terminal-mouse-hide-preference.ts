import { useEffect } from 'react'
import { installMouseHideWhileTyping } from '../../mouse-hide-while-typing'
import type { UseTerminalPaneLifecycleDeps } from '../../mounting/terminal-pane-lifecycle-types'
import type { TerminalPaneLifecycleRefs } from '../../mounting/use-terminal-pane-lifecycle-refs'

export function useTerminalMouseHidePreference(
  deps: Pick<UseTerminalPaneLifecycleDeps, 'managerRef' | 'settings'>,
  refs: Pick<TerminalPaneLifecycleRefs, 'mouseHideDisposablesRef'>
): void {
  useEffect(() => {
    const manager = deps.managerRef.current
    if (!manager) {
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
  }, [deps.settings?.terminalMouseHideWhileTyping, deps.managerRef, refs.mouseHideDisposablesRef])
}
