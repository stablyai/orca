import React, { useCallback, useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import { useAppStore } from '@/store'
import type { WorkspaceComposerPaneRequest } from '@/store/slices/ui/ui-slice-contract-contextual'
import { usePaneComposerEscapeDismissal } from '@/components/new-workspace/composer/use-pane-composer-escape-dismissal'
import { getWorkspaceComposerInitialFocusTarget } from '@/lib/workspace/creation/workspace-composer-initial-focus'
import { WorkspaceComposerBody } from '@/components/NewWorkspaceComposerModal'
import type { ComposerModalData } from '@/components/new-workspace/composer/composer-modal-data'

function PaneComposerHeading({
  title,
  description
}: {
  title: string
  description: string
}): React.JSX.Element {
  return (
    // Why: mirrors NativeChatEmptyState so the composer reads as the chat it is about to start.
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <MessageSquare className="size-6" />
      </div>
      <h1 className="text-sm font-medium text-chat-foreground-strong">{title}</h1>
      <p className="max-w-sm text-balance text-xs text-chat-foreground-faint">{description}</p>
    </div>
  )
}

/** Center-pane host for the prompt-first composer: the dialog's body laid out as a chat start screen. */
export default function NewWorkspaceComposerPane(): React.JSX.Element | null {
  const request = useAppStore((state) => state.workspaceComposerPaneRequest)
  if (!request) {
    return null
  }
  // Why keyed: a reopen (another project's "+") issues a new request that must reseed the body.
  return <PaneComposerHost key={request.id} request={request} />
}

function PaneComposerHost({
  request
}: {
  request: WorkspaceComposerPaneRequest
}): React.JSX.Element {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: composer openers pass ComposerModalData.
  const modalData = request.data as ComposerModalData
  const closeWorkspaceComposerPane = useAppStore((state) => state.closeWorkspaceComposerPane)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const submittedRef = useRef(false)
  // Why: a request dismissed by Escape, navigation or a reopen cancels its in-flight submit.
  const isSubmissionCancelled = useCallback(
    () => !submittedRef.current && useAppStore.getState().workspaceComposerPaneRequest !== request,
    [request]
  )
  const handleCreated = useCallback(() => {
    submittedRef.current = true
    closeWorkspaceComposerPane(request)
  }, [closeWorkspaceComposerPane, request])
  const dismiss = useCallback(
    () => closeWorkspaceComposerPane(request),
    [closeWorkspaceComposerPane, request]
  )

  useEffect(() => {
    getWorkspaceComposerInitialFocusTarget(containerRef.current ?? document)?.focus({
      preventScroll: true
    })
  }, [])

  usePaneComposerEscapeDismissal(containerRef, dismiss)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-chat-canvas scrollbar-sleek">
      <div
        ref={containerRef}
        className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-1 flex-col px-3 pt-2 pb-4 sm:px-4"
      >
        <WorkspaceComposerBody
          modalData={modalData}
          onClose={handleCreated}
          isSubmissionCancelled={isSubmissionCancelled}
          active
          cardContentClassName="-mx-2 px-2 pb-1"
          heading={PaneComposerHeading}
        />
      </div>
    </div>
  )
}
