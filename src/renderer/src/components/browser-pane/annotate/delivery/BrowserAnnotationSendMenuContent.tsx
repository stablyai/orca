import React from 'react'
import { ReviewNotesSendMenuContent } from '@/components/editor/review-note-delivery/ReviewNotesSendMenuContent'
import { DropdownMenuCheckboxItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

export type BrowserAnnotationSendMenuContentProps = {
  worktreeId: string
  groupId: string
  prompt: string
  includePageDetails: boolean
  onIncludePageDetailsChange: (include: boolean) => void
  onPromptDelivered?: () => void
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
}

export function browserAnnotationCopyTooltip(
  includePageDetails: boolean,
  t: Translate = translate
): string {
  return includePageDetails
    ? t(
        'auto.components.browser.pane.annotate.browser.page.annotation.tray.copyFeedbackWithPageDetails',
        'Copy feedback with page details'
      )
    : t(
        'auto.components.browser.pane.annotate.browser.page.annotation.tray.copyFeedback',
        'Copy feedback'
      )
}

export function BrowserAnnotationSendMenuContent({
  worktreeId,
  groupId,
  prompt,
  includePageDetails,
  onIncludePageDetailsChange,
  onPromptDelivered,
  onPromptHandedOff
}: BrowserAnnotationSendMenuContentProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
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
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={includePageDetails}
        onCheckedChange={onIncludePageDetailsChange}
        onSelect={(event) => event.preventDefault()}
      >
        {t(
          'auto.components.browser.pane.annotate.browser.page.annotation.tray.includePageDetails',
          'Include page details'
        )}
      </DropdownMenuCheckboxItem>
    </>
  )
}
