// Receiving a shared bot: a link (opened, or pasted in New bot → From a link), its review, then New bot.
// A link this computer already made a bot from offers that bot first.
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { openBotHomeTab, useBots } from '@/lib/bot-catalog'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotShareReview } from '../../../../../shared/bots/bot-share-received'
import { parseBotShareId } from '../../../../../shared/skills/sharing/skill-share-link'
import { botShareErrorMessage } from './bot-share-error-copy'
import { BotAvatar } from '../BotAvatar'
import { closeBotShareLink, type BotShareReceiveRequest } from './bot-share-receive-open'
import { reviewBotShare } from './bot-share-rpc'
import { BotShareReviewDialog } from './BotShareReviewDialog'
import { NewBotDialog } from '../NewBotDialog'
import type { NewBotShareSource } from './new-bot-from-share'

type Step =
  | { kind: 'paste' }
  | { kind: 'loading'; shareId: string; again: boolean }
  | { kind: 'have'; shareId: string; bot: Bot }
  | { kind: 'stopped' }
  | { kind: 'review'; review: BotShareReview; updated: boolean }
  | { kind: 'create'; review: BotShareReview }

function PasteLink({ onLink }: { onLink: (shareId: string) => void }): React.JSX.Element {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const shareId = parseBotShareId(value)
  return (
    <Dialog open onOpenChange={(next) => !next && closeBotShareLink()}>
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('bots.share.receive.fromLink', 'From a link')}</DialogTitle>
          <DialogDescription>
            {t('bots.share.receive.pasteDescription', 'Paste a link someone shared.')}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (shareId) {
              onLink(shareId)
            }
          }}
        >
          <Input
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={t(
              'bots.share.receive.linkPlaceholder',
              'https://app.orca.dev/bots/share/…'
            )}
            aria-label={t('bots.share.receive.link', 'Link')}
            onChange={(event) => setValue(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={closeBotShareLink}>
              {t('bots.new.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!shareId}>
              {t('bots.share.receive.continue', 'Continue')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AlreadyHave({
  bot,
  onReviewAgain
}: {
  bot: Bot
  onReviewAgain: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const made = uiDateTimeFormat({ month: 'short', day: 'numeric' }, useIntlLocale()).format(
    new Date(bot.createdAt)
  )
  return (
    <Dialog open onOpenChange={(next) => !next && closeBotShareLink()}>
      <DialogContent
        className="max-w-sm sm:max-w-sm"
        // Opened by a link, nothing is chosen yet: no control starts focused.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="items-center sm:text-center">
          <BotAvatar bot={bot} className="size-12 rounded-xl" />
          <DialogTitle>{t('bots.share.receive.have', 'You already have this bot')}</DialogTitle>
          <DialogDescription>
            {t('bots.share.receive.haveDetail', '{{name}} · made {{date}}', {
              name: bot.name,
              date: made
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="items-center">
          <Button type="button" variant="ghost" className="mr-auto" onClick={onReviewAgain}>
            {t('bots.share.review.reviewAgain', 'Review again')}
          </Button>
          <Button type="button" variant="outline" onClick={closeBotShareLink}>
            {t('bots.share.receive.close', 'Close')}
          </Button>
          <Button
            type="button"
            onClick={() => {
              closeBotShareLink()
              void openBotHomeTab(bot)
            }}
          >
            {t('bots.share.receive.open', 'Open')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Stopped(): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open onOpenChange={(next) => !next && closeBotShareLink()}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('bots.share.receive.stopped', 'This link no longer works')}</DialogTitle>
          <DialogDescription>
            {t('bots.share.receive.stoppedDetail', 'Ask whoever shared it for a new one.')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={closeBotShareLink}>
            {t('bots.share.receive.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The regular New bot dialog, made from the review. */
function NewBotFromShare(source: NewBotShareSource): React.JSX.Element {
  return (
    <NewBotDialog open onOpenChange={(open) => !open && closeBotShareLink()} fromShare={source} />
  )
}

export function BotShareReceiveFlow({
  request
}: {
  request: BotShareReceiveRequest
}): React.JSX.Element | null {
  const bots = useBots()
  const [step, setStep] = useState<Step>(() =>
    request.shareId
      ? { kind: 'loading', shareId: request.shareId, again: false }
      : { kind: 'paste' }
  )
  const [toolIds, setToolIds] = useState<string[]>([])

  useEffect(() => {
    if (step.kind !== 'loading') {
      return
    }
    const made = step.again ? null : bots.find((bot) => bot.sharedFrom?.shareId === step.shareId)
    if (made) {
      setStep({ kind: 'have', shareId: step.shareId, bot: made })
      return
    }
    let current = true
    reviewBotShare(step.shareId).then(
      (review) => {
        if (current) {
          setToolIds([])
          setStep(review ? { kind: 'review', review, updated: false } : { kind: 'stopped' })
        }
      },
      (cause: unknown) => {
        if (current) {
          toast.error(botShareErrorMessage(cause))
          closeBotShareLink()
        }
      }
    )
    return () => {
      current = false
    }
  }, [bots, step])

  const reviewAgain = (shareId: string) => () => setStep({ kind: 'loading', shareId, again: true })

  switch (step.kind) {
    case 'paste':
      return <PasteLink onLink={(shareId) => setStep({ kind: 'loading', shareId, again: false })} />
    case 'loading':
      return null
    case 'have':
      return <AlreadyHave bot={step.bot} onReviewAgain={reviewAgain(step.shareId)} />
    case 'stopped':
      return <Stopped />
    case 'review':
      return (
        <BotShareReviewDialog
          review={step.review}
          toolIds={toolIds}
          onToolIdsChange={setToolIds}
          updated={step.updated}
          onCreate={() => setStep({ kind: 'create', review: step.review })}
          onReviewAgain={reviewAgain(step.review.shareId)}
          onClose={closeBotShareLink}
        />
      )
    case 'create':
      return (
        <NewBotFromShare
          review={step.review}
          toolIds={toolIds}
          onBack={() => setStep({ kind: 'review', review: step.review, updated: false })}
          onMoved={(why) =>
            setStep(
              why === 'stopped'
                ? { kind: 'stopped' }
                : why === 'expired'
                  ? // Main no longer holds what was shown: show the link again, as it is now.
                    {
                      kind: 'loading',
                      shareId: step.review.shareId,
                      again: true
                    }
                  : { kind: 'review', review: step.review, updated: true }
            )
          }
        />
      )
  }
}
