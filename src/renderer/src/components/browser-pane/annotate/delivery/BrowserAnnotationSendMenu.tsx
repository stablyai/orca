import React from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  SendNotesButton,
  type SendNotesButtonSize
} from '@/components/editor/review-note-delivery/SendNotesButton'
import {
  NotesMenuCopyClearItems,
  useClearNotesConfirm
} from '@/components/editor/review-note-delivery/notes-copy-clear'
import { BrowserAnnotationSendMenuContent } from './BrowserAnnotationSendMenuContent'
import { preventAgentSendTargetOutsideDismiss } from './prevent-agent-send-target-outside-dismiss'
import type { BrowserAnnotationsClearRequest } from './use-browser-page-annotation-send'

/** The browser's "Send N notes" button and menu; hidden when the page has no annotations. */
export function BrowserAnnotationSendMenu({
  annotationCount,
  sendableCount,
  open,
  onOpenChange,
  worktreeId,
  groupId,
  prompt,
  includePageDetails,
  onIncludePageDetailsChange,
  onPromptDelivered,
  onPromptHandedOff,
  onCopy,
  createClearRequest,
  size
}: {
  annotationCount: number
  sendableCount: number
  open: boolean
  onOpenChange: (open: boolean) => void
  worktreeId: string
  groupId: string
  prompt: string
  includePageDetails: boolean
  onIncludePageDetailsChange: (include: boolean) => void
  onPromptDelivered: () => void
  onPromptHandedOff: (delivered: Promise<unknown>) => void
  onCopy: () => void
  createClearRequest: () => BrowserAnnotationsClearRequest
  size?: SendNotesButtonSize
}): React.JSX.Element | null {
  const clearConfirm = useClearNotesConfirm()
  return (
    <>
      {annotationCount > 0 ? (
        <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
          <DropdownMenuTrigger asChild>
            <SendNotesButton
              count={sendableCount}
              // An empty prompt means every annotation is already on its way.
              sending={!prompt}
              size={size}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="min-w-[180px]"
            onInteractOutside={preventAgentSendTargetOutsideDismiss}
            onPointerDownOutside={preventAgentSendTargetOutsideDismiss}
          >
            <BrowserAnnotationSendMenuContent
              worktreeId={worktreeId}
              groupId={groupId}
              prompt={prompt}
              includePageDetails={includePageDetails}
              onIncludePageDetailsChange={onIncludePageDetailsChange}
              onPromptDelivered={onPromptDelivered}
              onPromptHandedOff={onPromptHandedOff}
            />
            <NotesMenuCopyClearItems
              onCopy={onCopy}
              onClear={() => clearConfirm.requestClear(createClearRequest())}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {clearConfirm.dialog}
    </>
  )
}
