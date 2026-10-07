import { useCallback, useEffect } from 'react'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'

export function useNativeChatFileAttachmentActions(
  /** Pane identity published as `data-composer-scope-key` on the drop target. */
  scopeKey: string,
  attachExternalPaths: (paths: string[]) => void
): { pickAttachments: () => void } {
  useEffect(
    () =>
      window.api.ui.onFileDrop((payload) => {
        // Why: this event reaches every mounted composer, including hidden
        // background chat tabs. Only the pane the drop landed on may attach.
        if (payload.target === NATIVE_FILE_DROP_TARGET.composer && payload.scopeKey === scopeKey) {
          attachExternalPaths(payload.paths)
        }
      }),
    [attachExternalPaths, scopeKey]
  )

  const pickAttachments = useCallback(() => {
    void (async () => {
      attachExternalPaths(await window.api.shell.pickAttachments())
    })()
  }, [attachExternalPaths])

  return { pickAttachments }
}
