import { useState } from 'react'
import { ExternalLink, LoaderCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { useTranslate } from '@/i18n/use-translate'
import type { NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'
import type { useNgitItemDetails } from './use-ngit-item-details'
import { NgitMergeButton } from './ngit-merge-button'
import { NgitStatusActions } from './ngit-status-actions'

/** Comment box, merge, status changes and links for one item. */
export function NgitItemActions({
  item,
  state,
  onUse
}: {
  item: NgitWorkItem
  state: ReturnType<typeof useNgitItemDetails>
  /** Absent where the item already has its workspace. */
  onUse?: (item: NgitWorkItem) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { details, viewer, writing, publish } = state
  const [comment, setComment] = useState('')
  const [merging, setMerging] = useState(false)
  // A reread after a write is newer than the list row.
  const shown = details?.item ?? item
  const cannotSign = viewer !== null && viewer.account === null
  const canMerge =
    viewer?.account != null && details?.maintainers.includes(viewer.account.npub) === true
  const canComment = comment.trim().length > 0 && !writing && !cannotSign
  const submitComment = (): void => {
    void publish((api) => api.addComment(item.type, item.eventId, comment)).then((published) => {
      if (published) {
        setComment('')
      }
    })
  }
  const merge = (): void => {
    setMerging(true)
    void publish((api) => api.mergePr(item.eventId)).then(() => setMerging(false))
  }

  return (
    <div className="space-y-3">
      {cannotSign ? (
        <p className="text-xs text-muted-foreground">
          {viewer.cliInstalled
            ? t(
                'components.taskPage.ngit.signInToWrite',
                'Run ngit account login on this machine to comment or change status.'
              )
            : t(
                'components.taskPage.ngit.installToWrite',
                'Install the ngit CLI on this machine to comment or change status.'
              )}
        </p>
      ) : null}
      {shown.type === 'pr' && shown.state === 'open' ? (
        <div className="flex flex-wrap items-center gap-2">
          <NgitMergeButton
            item={shown}
            disabled={writing || !canMerge}
            merging={merging}
            onMerge={merge}
          />
          {details && viewer?.account && !canMerge ? (
            <span className="text-xs text-muted-foreground">
              {t('components.taskPage.ngit.maintainersMerge', 'Only maintainers can merge.')}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <ImeTextarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={
            viewer?.account
              ? t('components.taskPage.ngit.commentAs', 'Comment publicly as {{name}}…', {
                  name: viewer.account.name ?? viewer.account.npub.slice(0, 12)
                })
              : t('components.taskPage.ngit.commentPlaceholder', 'Comment…')
          }
          rows={2}
          disabled={writing || cannotSign}
          className="min-h-9 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
          onKeyDown={(event) => {
            if (isScreenSubmitShortcut(event) && canComment) {
              event.preventDefault()
              submitComment()
            }
          }}
        />
        <Button size="sm" disabled={!canComment} onClick={submitComment} className="shrink-0">
          {writing && !merging ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          {t('components.taskPage.ngit.comment', 'Comment')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={(event) => openAppHttpLink(shown.url, { event })}
        >
          <ExternalLink className="size-3.5" />
          {t('components.taskPage.ngit.openInBrowser', 'Open on gitworkshop.dev')}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <NgitStatusActions
            item={shown}
            disabled={writing || cannotSign}
            onAction={(action) =>
              void publish((api) => api.setStatus(item.type, item.eventId, action))
            }
          />
          {onUse ? (
            <Button size="sm" onClick={() => onUse(shown)}>
              {t('components.taskPage.ngit.createWorkspace', 'Create workspace')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
