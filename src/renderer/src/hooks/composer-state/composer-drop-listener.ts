import { useEffect, useRef } from 'react'
import { isCurrentComposerDropOwner } from '../composer-drop-owner'

const composerDropStack: symbol[] = []

export function useComposerDropListener(
  applyDrop: (paths: string[], isCurrentOwner: () => boolean) => void
): void {
  const applyDropRef = useRef(applyDrop)
  useEffect(() => {
    applyDropRef.current = applyDrop
  }, [applyDrop])
  const instanceIdRef = useRef<symbol>(undefined!)
  instanceIdRef.current ??= Symbol('composer')

  useEffect(() => {
    const instanceId = instanceIdRef.current
    composerDropStack.push(instanceId)
    const unsubscribe = window.api.ui.onFileDrop((data) => {
      if (
        data.target !== 'composer' ||
        // Why: a scoped payload belongs to the pane composer that published that
        // scope key; this stack only owns drops from unscoped composers.
        data.scopeKey !== undefined ||
        !isCurrentComposerDropOwner(composerDropStack, instanceId)
      ) {
        return
      }
      const isCurrentOwner = (): boolean =>
        isCurrentComposerDropOwner(composerDropStack, instanceId)
      applyDropRef.current(data.paths, isCurrentOwner)
    })
    return () => {
      unsubscribe()
      const index = composerDropStack.lastIndexOf(instanceId)
      if (index !== -1) {
        composerDropStack.splice(index, 1)
      }
    }
  }, [])
}
