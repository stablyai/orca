import { useCallback, useRef, useState } from 'react'

/** Copies the shared orca.yaml template and briefly flags it copied, until the pane detaches. */
export function useCopyOrcaYamlTemplate(): {
  copiedTemplate: boolean
  handleCopyTemplate: () => Promise<void>
  setRepositoryPaneRootRef: (node: HTMLDivElement | null) => void
} {
  const [copiedTemplate, setCopiedTemplate] = useState(false)
  const copiedTemplateResetTimerRef = useRef<number | null>(null)
  // Clipboard IPC may outlive navigation; do not start timers after pane detach.
  const isMountedRef = useRef(false)

  const clearCopiedTemplateResetTimer = useCallback((): void => {
    if (copiedTemplateResetTimerRef.current !== null) {
      window.clearTimeout(copiedTemplateResetTimerRef.current)
      copiedTemplateResetTimerRef.current = null
    }
  }, [])

  const setRepositoryPaneRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      isMountedRef.current = node !== null
      if (node === null) {
        clearCopiedTemplateResetTimer()
      }
    },
    [clearCopiedTemplateResetTimer]
  )

  const handleCopyTemplate = async () => {
    // Make missing-orca.yaml migration a one-click copy of the expected shared-template shape.
    await window.api.ui.writeClipboardText(`scripts:
  setup: |
    pnpm worktree:setup
  archive: |
    echo "Cleaning up before archive"`)
    if (!isMountedRef.current) {
      return
    }
    clearCopiedTemplateResetTimer()
    setCopiedTemplate(true)
    copiedTemplateResetTimerRef.current = window.setTimeout(() => {
      copiedTemplateResetTimerRef.current = null
      setCopiedTemplate(false)
    }, 1500)
  }

  return { copiedTemplate, handleCopyTemplate, setRepositoryPaneRootRef }
}
