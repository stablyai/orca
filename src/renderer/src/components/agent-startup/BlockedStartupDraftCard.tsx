import { X } from 'lucide-react'
import { useSyncExternalStore, type JSX } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useTranslate } from '@/i18n/use-translate'
import {
  blockedStartupTitle,
  closeStartupDraft,
  copyStartupDraft,
  getStartupDrafts,
  subscribeToStartupDrafts
} from '@/lib/agent-session/launch/prompt/blocked-agent-startup-notice'

export function BlockedStartupDraftCard(): JSX.Element {
  const t = useTranslate()
  const drafts = useSyncExternalStore(subscribeToStartupDrafts, getStartupDrafts)
  const draft = drafts[0]
  const heading = draft && blockedStartupTitle(draft.reason)
  const message =
    draft && draft.reason !== 'unbuildable'
      ? t('terminal.startupPromptNotDelivered', "The startup prompt wasn't delivered.")
      : undefined
  const moreCount = drafts.length - 1
  return (
    <>
      <p role="status" className="sr-only absolute!">
        {draft && (
          <span key={draft.id}>
            {heading} {message}
          </span>
        )}
      </p>
      {draft && (
        <Card
          key={draft.id}
          size="notice"
          role="group"
          aria-labelledby="blocked-startup-draft-heading"
        >
          <div className="flex flex-col gap-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <h3 id="blocked-startup-draft-heading" className="text-sm font-semibold">
                {heading}
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('auto.components.ui.dialog.f26c4baeda', 'Close')}
                onClick={() => closeStartupDraft(draft.id)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            {(message || moreCount > 0) && (
              <p className="text-sm text-muted-foreground">
                {message}
                {moreCount > 0 &&
                  ` ${t('terminal.startupPromptMore', '({{count}} more)', {
                    count: moreCount,
                    defaultValue_one: '({{count}} more)'
                  })}`}
              </p>
            )}
            <p className="line-clamp-4 font-mono text-xs wrap-anywhere whitespace-pre-wrap">
              {draft.preview}
            </p>
            <Button
              type="button"
              size="xs"
              className="self-end"
              onClick={() => void copyStartupDraft(draft.id)}
            >
              {t('menu.copy', 'Copy')}
            </Button>
          </div>
        </Card>
      )}
    </>
  )
}
