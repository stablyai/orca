import { useCallback } from 'react'

export function useNativeChatFileAttachmentActions(
  captureExternalPaths: () => (paths: string[]) => void | Promise<void>
): { pickAttachments: () => void } {
  const pickAttachments = useCallback(() => {
    const attach = captureExternalPaths()
    void (async () => {
      await attach(await window.api.shell.pickAttachments())
    })()
  }, [captureExternalPaths])

  return { pickAttachments }
}
