// Share an agent with people: a shortcut to the same people list Settings › Sharing draws. The caller
// owns the people, the picks and the search (useBotTeamShareList); this draws them.
import { useRef } from 'react'
import { Laptop } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'
import { TeamShareAddField } from './BotTeamShareAddField'
import { TeamSharePeopleList } from './BotTeamShareRows'
import type { BotTeamShareList } from './use-bot-team-share-list'

export function BotTeamShareDialog({
  bot,
  hostName,
  onClose,
  children,
  sharing = false,
  othersListed,
  ...list
}: Omit<BotTeamShareList, 'connectorRows' | 'sharing'> & {
  bot: Bot
  /** The computer the agent runs on, named in the footer warning. */
  hostName: string
  sharing?: boolean
  onClose: () => void
  /** Rows the caller draws itself after `people`: Slack- and GitHub-only people, from Who can ask. */
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="flush"
        className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:max-w-[520px]"
        aria-describedby={undefined}
        // The field, not a chip's ✕, takes focus on open.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <div className="flex items-center gap-3 px-6 pt-6 pr-12">
          <BotAvatar bot={bot} className="size-9 rounded-[9px] text-base" />
          <DialogTitle className="min-w-0">
            <span className="block truncate">
              {t('bots.teamShare.title', 'Share {{name}}', { name: bot.name })}
            </span>
          </DialogTitle>
        </div>
        <div className="flex items-center gap-2 px-6 pt-4">
          <TeamShareAddField {...list} inputRef={inputRef} focusedOnOpen />
        </div>
        <div className="scrollbar-sleek min-h-0 max-h-[340px] overflow-y-auto pt-1 pb-2">
          {othersListed ? (
            <h3 className="px-6 pt-4 pb-1 text-xs font-medium text-muted-foreground">
              {t('bots.teamShare.peopleWithAccess', 'People with access')}
            </h3>
          ) : null}
          <TeamSharePeopleList {...list}>{children}</TeamSharePeopleList>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-6 py-4">
          <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs leading-4 text-muted-foreground">
            <Laptop className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              {t(
                'bots.teamShare.warning',
                'Anyone you share with can do anything {{name}} can on {{host}}, including using your accounts, files and chats.',
                { name: bot.name, host: hostName }
              )}
            </span>
          </p>
          {list.staged.length > 0 ? (
            <>
              <Button variant="ghost" disabled={sharing} onClick={list.onCancelStaged}>
                {t('bots.teamShare.cancel', 'Cancel')}
              </Button>
              <Button disabled={sharing} onClick={list.onShare}>
                {t('bots.teamShare.shareStaged', 'Share')}
              </Button>
            </>
          ) : (
            <Button onClick={onClose}>{t('bots.teamShare.done', 'Done')}</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
