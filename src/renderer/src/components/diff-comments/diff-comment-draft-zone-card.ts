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
import { resizeDiffCommentZone, type DraftZoneEntry } from './diff-comment-view-zone-entry'
import type { DiffCommentCreate, DiffCommentFileSession } from './diff-comment-session'

type DraftZoneCardContext = {
  draftZoneRef: RefObject<DraftZoneEntry | null>
  onCreateCommentRef: RefObject<DiffCommentCreate | undefined>
  monacoModelIdentity?: string
  combined: boolean
  focusOnOpen: boolean
  captureCreateComment: boolean
  imageUploadAddress?: GitHubImageIntake['address']
  draftPlaceholder?: string
  draftSubmitLabel?: string
  cancelDraftZone: (entry: DraftZoneEntry) => void
  fileSession: DiffCommentFileSession
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
    cancelDraftZone,
    fileSession
  }: DraftZoneCardContext
): void {
  const { editor, zoneId, domNode: dom, lifetime, session } = entry
  const draft = session.target
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
    autoFocus: !combined && focusOnOpen,
    session,
    imageUploadAddress,
    placeholder: draftPlaceholder,
    submitLabel: draftSubmitLabel,
    resizeZone,
    onCancel: () => {
      if (draftZoneRef.current === entry) {
        cancelDraftZone(entry)
      }
    },
    onSubmit: (body) => {
      if (lifetime.signal.aborted || draftZoneRef.current !== entry) {
        return Promise.resolve(false)
      }
      const createComment = captureCreateComment
        ? session.createComment
        : onCreateCommentRef.current
      if (!createComment) {
        return Promise.resolve(false)
      }
      return fileSession.submitDraft(session, createComment, body)
    }
  })
}
