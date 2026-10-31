import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type {
  BrowserAnnotationIntent,
  BrowserPageAnnotation
} from '../../../../../shared/browser-grab-types'
import { formatBrowserAnnotationsAsMarkdown } from './browser-annotation-output'
import { EMPTY_BROWSER_ANNOTATIONS } from '../describe-page/browser-annotation-geometry'
import {
  holdNotesForSend,
  isNoteInFlight,
  useNotesInFlightVersion
} from '@/lib/notes-send-in-flight'

export function useBrowserPageAnnotationSend({
  browserTabId,
  worktreeId
}: {
  browserTabId: string
  worktreeId: string
}): {
  browserAnnotations: BrowserPageAnnotation[]
  browserAnnotationsPrompt: string
  includePageDetails: boolean
  handleIncludePageDetailsChange: (include: boolean) => void
  browserAnnotationsCopied: boolean
  annotationBannerSendOpen: boolean
  annotationTraySendOpen: boolean
  handleAnnotationBannerSendOpenChange: (open: boolean) => void
  handleAnnotationTraySendOpenChange: (open: boolean) => void
  handleCopyBrowserAnnotations: () => void
  handleClearBrowserAnnotations: () => void
  handleDeleteBrowserAnnotation: (annotationId: string) => void
  handleUpdateBrowserAnnotation: (
    annotationId: string,
    comment: string,
    intent: BrowserAnnotationIntent,
    imagePaths: string[]
  ) => void
  handleBrowserAnnotationsSentToAgent: () => void
  handleBrowserAnnotationsHandedOff: (delivered: Promise<unknown>) => void
  activeGroupId: string | undefined
} {
  const browserAnnotations = useAppStore(
    (s) => s.browserAnnotationsByPageId[browserTabId] ?? EMPTY_BROWSER_ANNOTATIONS
  )
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[worktreeId])
  const browserAnnotationsRef = useRef(browserAnnotations)
  const [browserAnnotationsCopied, setBrowserAnnotationsCopied] = useState(false)
  const annotationCopyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [includePageDetails, setIncludePageDetails] = useState(false)
  const copyPrompt = useMemo(
    () =>
      formatBrowserAnnotationsAsMarkdown(browserAnnotations, {
        includeDiagnostics: includePageDetails
      }),
    [browserAnnotations, includePageDetails]
  )
  // Annotations another send holds are left out of the next one.
  const inFlightVersion = useNotesInFlightVersion()
  const sendableAnnotations = useMemo(() => {
    void inFlightVersion
    return browserAnnotations.filter((annotation) => !isNoteInFlight(annotation))
  }, [browserAnnotations, inFlightVersion])
  const browserAnnotationsPrompt = useMemo(
    () =>
      formatBrowserAnnotationsAsMarkdown(sendableAnnotations, {
        includeDiagnostics: includePageDetails
      }),
    [sendableAnnotations, includePageDetails]
  )
  const openAgentSendPopoverTargetMode = useAppStore((s) => s.openAgentSendPopoverTargetMode)
  const closeAgentSendPopoverTargetMode = useAppStore((s) => s.closeAgentSendPopoverTargetMode)
  const activeAgentSendTargetModeId = useAppStore((s) => s.agentSendPopoverTargetMode?.id ?? null)
  const annotationBannerSendModeId = `browser-annotations:${browserTabId}:banner`
  const annotationTraySendModeId = `browser-annotations:${browserTabId}:tray`
  const annotationBannerSendOpen = activeAgentSendTargetModeId === annotationBannerSendModeId
  const annotationTraySendOpen = activeAgentSendTargetModeId === annotationTraySendModeId
  const deleteBrowserPageAnnotation = useAppStore((s) => s.deleteBrowserPageAnnotation)
  const updateBrowserPageAnnotation = useAppStore((s) => s.updateBrowserPageAnnotation)
  const clearBrowserPageAnnotations = useAppStore((s) => s.clearBrowserPageAnnotations)
  const removeDeliveredBrowserPageAnnotations = useAppStore(
    (s) => s.removeDeliveredBrowserPageAnnotations
  )
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  useLayoutEffect(() => {
    browserAnnotationsRef.current = browserAnnotations
  }, [browserAnnotations])

  useEffect(() => {
    return () => {
      clearTimeout(annotationCopyTimerRef.current)
    }
  }, [])

  const handleCopyBrowserAnnotations = useCallback((): void => {
    if (!copyPrompt) {
      return
    }
    void window.api.ui.writeClipboardText(copyPrompt)
    recordFeatureInteraction('browser-annotations')
    clearTimeout(annotationCopyTimerRef.current)
    setBrowserAnnotationsCopied(true)
    annotationCopyTimerRef.current = setTimeout(() => setBrowserAnnotationsCopied(false), 1400)
  }, [copyPrompt, recordFeatureInteraction])

  const handleBrowserAnnotationsSentToAgent = useCallback((): void => {
    recordFeatureInteraction('browser-annotations-sent-to-agent')
    removeDeliveredBrowserPageAnnotations(browserTabId, sendableAnnotations)
  }, [
    sendableAnnotations,
    browserTabId,
    recordFeatureInteraction,
    removeDeliveredBrowserPageAnnotations
  ])

  const handleBrowserAnnotationsHandedOff = useCallback(
    (delivered: Promise<unknown>): void =>
      holdNotesForSend(sendableAnnotations, delivered, handleBrowserAnnotationsSentToAgent),
    [handleBrowserAnnotationsSentToAgent, sendableAnnotations]
  )

  const handleClearBrowserAnnotations = useCallback((): void => {
    if (browserAnnotationsRef.current.length === 0) {
      return
    }
    clearTimeout(annotationCopyTimerRef.current)
    setBrowserAnnotationsCopied(false)
    recordFeatureInteraction('browser-annotations')
    clearBrowserPageAnnotations(browserTabId)
  }, [browserTabId, clearBrowserPageAnnotations, recordFeatureInteraction])

  const openAnnotationSendTargetMode = useCallback(
    (modeId: string, prompt: string): void => {
      openAgentSendPopoverTargetMode({
        id: modeId,
        worktreeId,
        source: 'browser-annotations',
        prompt,
        label: translate(
          'auto.components.browser.pane.BrowserPane.27d863542c',
          'Browser annotations'
        ),
        launchSource: 'notes_send',
        onPromptDelivered: handleBrowserAnnotationsSentToAgent,
        onPromptHandedOff: handleBrowserAnnotationsHandedOff
      })
    },
    [
      handleBrowserAnnotationsSentToAgent,
      handleBrowserAnnotationsHandedOff,
      openAgentSendPopoverTargetMode,
      worktreeId
    ]
  )

  const handleAnnotationSendOpenChange = useCallback(
    (modeId: string, open: boolean): void => {
      if (open) {
        // Every annotation may already be on its way: there is nothing to send.
        if (!browserAnnotationsPrompt) {
          return
        }
        openAnnotationSendTargetMode(modeId, browserAnnotationsPrompt)
      } else {
        closeAgentSendPopoverTargetMode(modeId)
      }
    },
    [browserAnnotationsPrompt, closeAgentSendPopoverTargetMode, openAnnotationSendTargetMode]
  )

  const handleIncludePageDetailsChange = useCallback(
    (include: boolean): void => {
      setIncludePageDetails(include)
      const openModeId =
        annotationBannerSendOpen || annotationTraySendOpen ? activeAgentSendTargetModeId : null
      // The sidebar agent picker holds the prompt it was opened with.
      if (openModeId && sendableAnnotations.length > 0) {
        openAnnotationSendTargetMode(
          openModeId,
          formatBrowserAnnotationsAsMarkdown(sendableAnnotations, { includeDiagnostics: include })
        )
      }
    },
    [
      activeAgentSendTargetModeId,
      annotationBannerSendOpen,
      annotationTraySendOpen,
      openAnnotationSendTargetMode,
      sendableAnnotations
    ]
  )

  const handleAnnotationBannerSendOpenChange = useCallback(
    (open: boolean): void => handleAnnotationSendOpenChange(annotationBannerSendModeId, open),
    [annotationBannerSendModeId, handleAnnotationSendOpenChange]
  )

  const handleAnnotationTraySendOpenChange = useCallback(
    (open: boolean): void => handleAnnotationSendOpenChange(annotationTraySendModeId, open),
    [annotationTraySendModeId, handleAnnotationSendOpenChange]
  )

  useEffect(
    () => () => {
      closeAgentSendPopoverTargetMode(annotationBannerSendModeId)
      closeAgentSendPopoverTargetMode(annotationTraySendModeId)
    },
    [annotationBannerSendModeId, annotationTraySendModeId, closeAgentSendPopoverTargetMode]
  )

  const handleDeleteBrowserAnnotation = useCallback(
    (annotationId: string): void => {
      if (browserAnnotationsRef.current.length === 1) {
        clearTimeout(annotationCopyTimerRef.current)
        setBrowserAnnotationsCopied(false)
      }
      deleteBrowserPageAnnotation(browserTabId, annotationId)
      recordFeatureInteraction('browser-annotations')
    },
    [browserTabId, deleteBrowserPageAnnotation, recordFeatureInteraction]
  )

  const handleUpdateBrowserAnnotation = useCallback(
    (
      annotationId: string,
      comment: string,
      intent: BrowserAnnotationIntent,
      imagePaths: string[]
    ): void => {
      updateBrowserPageAnnotation(browserTabId, annotationId, { comment, intent, imagePaths })
      recordFeatureInteraction('browser-annotations')
    },
    [browserTabId, recordFeatureInteraction, updateBrowserPageAnnotation]
  )

  return {
    browserAnnotations,
    browserAnnotationsPrompt,
    includePageDetails,
    handleIncludePageDetailsChange,
    browserAnnotationsCopied,
    annotationBannerSendOpen,
    annotationTraySendOpen,
    handleAnnotationBannerSendOpenChange,
    handleAnnotationTraySendOpenChange,
    handleCopyBrowserAnnotations,
    handleClearBrowserAnnotations,
    handleDeleteBrowserAnnotation,
    handleUpdateBrowserAnnotation,
    handleBrowserAnnotationsSentToAgent,
    handleBrowserAnnotationsHandedOff,
    activeGroupId
  }
}
