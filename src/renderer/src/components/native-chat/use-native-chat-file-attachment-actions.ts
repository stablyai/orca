import { useCallback, useEffect } from 'react'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'

export function useNativeChatFileAttachmentActions(
  attachExternalPaths: (paths: string[]) => void
): { pickAttachment: () => void } {
  useEffect(
    () =>
      window.api.ui.onFileDrop((payload) => {
        if (payload.target === NATIVE_FILE_DROP_TARGET.composer) {
          attachExternalPaths(payload.paths)
        }
      }),
    [attachExternalPaths]
  )

  const pickAttachment = useCallback(() => {
    void (async () => {
      const filePath = await window.api.shell.pickAttachment()
      if (filePath) {
        attachExternalPaths([filePath])
      }
    })()
  }, [attachExternalPaths])

  return { pickAttachment }
}
