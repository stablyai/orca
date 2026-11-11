import type { GitHubImageIntake } from '@/components/github/use-github-image-uploads'
import type { RefObject } from 'react'
import {
  isCombinedEditorBindingCurrent,
  measureCombinedCommentZone,
  registerCombinedCommentZone,
  revealCombinedCommentZone
} from '../editor/combined-diff/scroll-viewport/combined-diff-editor-geometry'
import { untilDiffCommentZoneRemoved } from './diff-comment-zone-lifetime'
import {
  registerDiffCommentZoneMeasurement,
  requestDiffCommentZoneMeasurement
} from './diff-comment-zone-measurement'
import { renderDiffCommentDraftCard } from './diff-comment-zone-card'
import {
  resizeDiffCommentZone,
  type DraftZoneEntry,
  type RestoreDiffCommentDraft
} from './diff-comment-view-zone-entry'

type DraftZoneCardContext = {
  draftZoneRef: RefObject<DraftZoneEntry | null>
  onCreateCommentRef: RefObject<DraftZoneEntry['createComment'] | undefined>
  monacoModelIdentity?: string
  combined: boolean
  focusOnOpen: boolean
  captureCreateComment: boolean
  imageUploadAddress?: GitHubImageIntake['address']
  draftPlaceholder?: string
  draftSubmitLabel?: string
  disposeDraftZone: (focusEditor?: boolean) => void
  restoreFailedSubmit: RestoreDiffCommentDraft
}

export function renderDiffCommentDraftZoneCard(
  entry: DraftZoneEntry,
  {
    draftZoneRef,
    onCreateCommentRef,
    monacoModelIdentity,
    combined,
    focusOnOpen,
    captureCreateComment,
    imageUploadAddress,
    draftPlaceholder,
    draftSubmitLabel,
    disposeDraftZone,
    restoreFailedSubmit
  }: DraftZoneCardContext
): void {
  const { editor, zoneId, domNode: dom, lifetime, draft } = entry
  let openingRequested = !focusOnOpen
  untilDiffCommentZoneRemoved(
    lifetime.signal,
    registerCombinedCommentZone(editor, zoneId, dom, () => {
      if (
        draftZoneRef.current !== entry ||
        lifetime.signal.aborted ||
        !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
      ) {
        return []
      }
      const textarea = dom.querySelector<HTMLTextAreaElement>('textarea')
      const footer = dom.querySelector<HTMLElement>('.orca-diff-comment-popover-footer')
      return textarea?.isConnected && footer?.isConnected ? [textarea, footer] : []
    })
  )

  const measured = (): void => {
    if (
      draftZoneRef.current !== entry ||
      lifetime.signal.aborted ||
      !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
    ) {
      return
    }
    if (!combined || openingRequested) {
      return
    }
    measureCombinedCommentZone(editor, zoneId, dom, () => {
      const textarea = dom.querySelector<HTMLTextAreaElement>('textarea')
      const footer = dom.querySelector<HTMLElement>('.orca-diff-comment-popover-footer')
      if (!textarea || !footer || textarea.offsetHeight <= 0 || footer.offsetHeight <= 0) {
        return false
      }
      openingRequested = revealCombinedCommentZone({
        editor,
        id: zoneId,
        node: dom,
        controls: () =>
          !lifetime.signal.aborted && draftZoneRef.current === entry ? [textarea, footer] : [],
        focus: () => {
          if (
            draftZoneRef.current === entry &&
            !lifetime.signal.aborted &&
            isCombinedEditorBindingCurrent(editor, monacoModelIdentity) &&
            dom.querySelector('textarea') === textarea &&
            dom.querySelector('.orca-diff-comment-popover-footer') === footer &&
            textarea.isConnected &&
            footer.isConnected
          ) {
            // Flush the native zone's scheduled display update only after the owner resolves opening.
            editor.render()
            if (
              draftZoneRef.current === entry &&
              !lifetime.signal.aborted &&
              isCombinedEditorBindingCurrent(editor, monacoModelIdentity) &&
              textarea.isConnected &&
              dom.contains(textarea)
            ) {
              textarea.focus({ preventScroll: true })
            }
          }
        }
      })
      return openingRequested
    })
  }
  if (combined) {
    registerDiffCommentZoneMeasurement(
      editor,
      entry,
      lifetime.signal,
      () =>
        draftZoneRef.current === entry &&
        !lifetime.signal.aborted &&
        isCombinedEditorBindingCurrent(editor, monacoModelIdentity),
      measured
    )
  }

  const resizeZone = (): void => {
    if (
      draftZoneRef.current !== entry ||
      lifetime.signal.aborted ||
      !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
    ) {
      return
    }
    if (combined) {
      requestDiffCommentZoneMeasurement(editor, entry)
    } else {
      resizeDiffCommentZone(editor, entry)
    }
  }
  renderDiffCommentDraftCard(entry.root, draft, {
    lifetime: lifetime.signal,
    autoFocus: !combined,
    imageUploadAddress,
    placeholder: draftPlaceholder,
    submitLabel: draftSubmitLabel,
    initialBody: entry.body,
    onBodyChange: (body) => {
      if (draftZoneRef.current === entry) {
        entry.body = body
      }
    },
    resizeZone,
    onCancel: () => {
      if (draftZoneRef.current === entry) {
        disposeDraftZone(true)
      }
    },
    onSubmit: async (body) => {
      if (lifetime.signal.aborted || draftZoneRef.current !== entry) {
        return false
      }
      const createComment = captureCreateComment ? entry.createComment : onCreateCommentRef.current
      if (!createComment) {
        return false
      }
      entry.submitting = true
      let succeeded = false
      try {
        const result = await createComment({
          lineNumber: draft.lineNumber,
          startLine: draft.startLine,
          body
        })
        succeeded = result !== false
        return result
      } finally {
        entry.submitting = false
        if (succeeded) {
          if (draftZoneRef.current === entry) {
            // Restore Monaco focus only if this card still owns it when the save settles.
            disposeDraftZone(entry.domNode.contains(document.activeElement))
          }
        } else if (draftZoneRef.current !== entry) {
          restoreFailedSubmit(draft, body, entry.createComment)
        }
      }
    }
  })
}
