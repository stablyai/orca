import React, { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { DropdownMenuCheckboxItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

const ReviewNotesSendMenuContent = lazy(() =>
  import('@/components/editor/review-note-delivery/ReviewNotesSendMenuContent').then((module) => ({
    default: module.ReviewNotesSendMenuContent
  }))
)

export type BrowserAnnotationSendMenuContentProps = {
  worktreeId: string
  groupId: string
  prompt: string
  includePageDetails: boolean
  onIncludePageDetailsChange: (include: boolean) => void
  onPromptDelivered?: () => void
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
  /** Checked again right before dispatch, so a prompt built before an edit is never sent. */
  canSendPrompt?: () => boolean
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
  onPromptHandedOff,
  canSendPrompt
}: BrowserAnnotationSendMenuContentProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <Suspense fallback={null}>
        <ReviewNotesSendMenuContent
          worktreeId={worktreeId}
          groupId={groupId}
          prompt={prompt}
          // Keep annotation delivery and telemetry stable when shared menu defaults change.
          promptDelivery="submit-after-ready"
          launchSource="notes_send"
          canSendPrompt={canSendPrompt}
          onPromptDelivered={onPromptDelivered}
          onPromptHandedOff={onPromptHandedOff}
        />
      </Suspense>
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
