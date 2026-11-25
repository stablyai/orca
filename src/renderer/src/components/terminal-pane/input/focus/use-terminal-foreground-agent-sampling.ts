import { useEffect } from 'react'
import type { IDisposable } from '@xterm/xterm'
import type { UseTerminalPaneLifecycleDeps } from '../../mounting/terminal-pane-lifecycle-types'

export function useTerminalForegroundAgentSampling(
  deps: Pick<
    UseTerminalPaneLifecycleDeps,
    'isActive' | 'isVisible' | 'managerRef' | 'panePtyBindingsRef'
  >
): void {
  useEffect(() => {
    if (!deps.isActive || !deps.isVisible || typeof window === 'undefined') {
      return
    }
    const onWindowFocus = (): void => {
      const activePane = deps.managerRef.current?.getActivePane()
      if (!activePane) {
        return
      }
      // SAFETY: Sampling is optional on the disposable binding and guarded before invocation.
      const binding = deps.panePtyBindingsRef.current.get(activePane.id) as
        | (IDisposable & { sampleForegroundAgentOnFocus?: () => void })
        | undefined
      binding?.sampleForegroundAgentOnFocus?.()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [deps.isActive, deps.isVisible, deps.managerRef, deps.panePtyBindingsRef])
}
