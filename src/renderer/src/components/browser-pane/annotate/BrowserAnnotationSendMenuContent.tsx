import React from 'react'
import { ReviewNotesSendMenuContent } from '@/components/editor/ReviewNotesSendMenuContent'

export type BrowserAnnotationSendMenuContentProps = {
  worktreeId: string
  groupId: string
  prompt: string
  onPromptDelivered?: () => void
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
}

export function BrowserAnnotationSendMenuContent({
  worktreeId,
  groupId,
  prompt,
  onPromptDelivered,
  onPromptHandedOff
}: BrowserAnnotationSendMenuContentProps): React.JSX.Element {
  return (
    <ReviewNotesSendMenuContent
      worktreeId={worktreeId}
      groupId={groupId}
      prompt={prompt}
      // Keep annotation delivery and telemetry stable when shared menu defaults change.
      promptDelivery="submit-after-ready"
      launchSource="notes_send"
      onPromptDelivered={onPromptDelivered}
      onPromptHandedOff={onPromptHandedOff}
    />
  )
}
