import { useCallback } from 'react'

export function useNativeChatFileAttachmentActions(
  attachExternalPaths: (paths: string[]) => void
): { pickAttachments: () => void } {
  const pickAttachments = useCallback(() => {
    void (async () => {
      attachExternalPaths(await window.api.shell.pickAttachments())
    })()
  }, [attachExternalPaths])

  return { pickAttachments }
}
