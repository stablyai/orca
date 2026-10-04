import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { PdfAnnotation } from '@/store/slices/pdf-annotations'
import type { BrowserAnnotationIntent } from '../../../../shared/browser-grab-types'
import { formatPdfAnnotationsAsMarkdown } from './pdf-annotation-output'
import type { PdfAnnotationContext } from './use-pdf-annotate-mode'

/** Tray actions for PDF annotations, matching browser Design Mode's send/copy/clear flow. */
export function usePdfAnnotationSend(
  context: PdfAnnotationContext | null,
  annotations: PdfAnnotation[]
) {
  const worktreeId = context?.worktreeId ?? ''
  const fileKey = context?.fileKey ?? ''
  const displayPath = context?.displayPath ?? ''
  const synctex = context?.synctex ?? null
  const [staleSources, setStaleSources] = useState<string[]>([])
  const sourcePathsKey = useMemo(
    () => [...new Set(annotations.flatMap((a) => a.sources?.map((s) => s.path) ?? []))].join('\n'),
    [annotations]
  )
  const staleRequestRef = useRef(0)
  // Why: re-stats every time a prompt goes out — the agent may have edited the .tex since the
  // PDF was built, and a stale warning is only useful if it matches the files right now.
  const freshPrompt = useCallback(async (): Promise<string> => {
    const request = ++staleRequestRef.current
    const paths = sourcePathsKey ? sourcePathsKey.split('\n') : []
    const stale =
      synctex && paths.length > 0
        ? await synctex.findStaleSources(paths).catch((): string[] => [])
        : []
    // Why: only the newest call may publish; an older one resolving late would restore the
    // previous annotation set's warning. The tray's send menu reads this state: it opens only
    // after the send-open call resolves, in the same render as its write.
    if (request === staleRequestRef.current) {
      setStaleSources((current) => (current.join('\n') === stale.join('\n') ? current : stale))
    }
    return formatPdfAnnotationsAsMarkdown(displayPath, annotations, stale)
  }, [annotations, displayPath, sourcePathsKey, synctex])
  useEffect(() => {
    void freshPrompt()
  }, [freshPrompt])
  const prompt = useMemo(
    () => formatPdfAnnotationsAsMarkdown(displayPath, annotations, staleSources),
    [annotations, displayPath, staleSources]
  )
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[worktreeId])
  const openAgentSendPopoverTargetMode = useAppStore((s) => s.openAgentSendPopoverTargetMode)
  const closeAgentSendPopoverTargetMode = useAppStore((s) => s.closeAgentSendPopoverTargetMode)
  const sendModeId = `pdf-annotations:${fileKey}:tray`
  const sendOpen = useAppStore((s) => s.agentSendPopoverTargetMode?.id === sendModeId)
  const updatePdfAnnotation = useAppStore((s) => s.updatePdfAnnotation)
  const deletePdfAnnotation = useAppStore((s) => s.deletePdfAnnotation)
  const clearPdfAnnotations = useAppStore((s) => s.clearPdfAnnotations)
  const removeDeliveredPdfAnnotations = useAppStore((s) => s.removeDeliveredPdfAnnotations)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(copyTimerRef.current), [])
  useEffect(
    () => () => closeAgentSendPopoverTargetMode(sendModeId),
    [closeAgentSendPopoverTargetMode, sendModeId]
  )

  const handleSentToAgent = useCallback((): void => {
    removeDeliveredPdfAnnotations(annotations)
  }, [annotations, removeDeliveredPdfAnnotations])

  const handleSendOpenChange = useCallback(
    (open: boolean): void => {
      if (!open) {
        closeAgentSendPopoverTargetMode(sendModeId)
        return
      }
      void freshPrompt().then((current) =>
        openAgentSendPopoverTargetMode({
          id: sendModeId,
          worktreeId,
          // Same delivery path and agent picker as browser Design Mode.
          source: 'browser-annotations',
          prompt: current,
          label: translate(
            'auto.components.editor.PdfViewer.pdfAnnotationsLabel',
            'PDF annotations'
          ),
          launchSource: 'notes_send',
          onPromptDelivered: handleSentToAgent
        })
      )
    },
    [
      closeAgentSendPopoverTargetMode,
      freshPrompt,
      handleSentToAgent,
      openAgentSendPopoverTargetMode,
      sendModeId,
      worktreeId
    ]
  )

  const handleCopy = useCallback((): void => {
    void freshPrompt().then((current) => {
      if (!current) {
        return
      }
      void window.api.ui.writeClipboardText(current)
      clearTimeout(copyTimerRef.current)
      setCopied(true)
      copyTimerRef.current = setTimeout(() => setCopied(false), 1400)
    })
  }, [freshPrompt])

  const handleClear = useCallback((): void => {
    clearTimeout(copyTimerRef.current)
    setCopied(false)
    clearPdfAnnotations(fileKey)
  }, [clearPdfAnnotations, fileKey])

  const handleDelete = useCallback(
    (annotationId: string): void => deletePdfAnnotation(fileKey, annotationId),
    [deletePdfAnnotation, fileKey]
  )

  const handleUpdate = useCallback(
    (annotationId: string, comment: string, intent: BrowserAnnotationIntent): void =>
      updatePdfAnnotation(fileKey, annotationId, { comment, intent }),
    [fileKey, updatePdfAnnotation]
  )

  // Why: named to match the shared Design Mode tray's props, so the tray is spread as-is.
  return {
    browserAnnotations: annotations,
    annotationTraySendOpen: sendOpen,
    handleAnnotationTraySendOpenChange: handleSendOpenChange,
    worktreeId,
    activeGroupId,
    browserAnnotationsPrompt: prompt,
    handleBrowserAnnotationsSentToAgent: handleSentToAgent,
    handleCopyBrowserAnnotations: handleCopy,
    browserAnnotationsCopied: copied,
    handleClearBrowserAnnotations: handleClear,
    handleDeleteBrowserAnnotation: handleDelete,
    handleUpdateBrowserAnnotation: handleUpdate
  }
}
