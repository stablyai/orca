// A bot's SOUL.md editor and MEMORY.md panel, read from its home on the computer that runs it.
import { Loader2 } from 'lucide-react'
import type { BotRef } from '@/lib/bot-hosts'
import { Button } from '@/components/ui/button'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostLabel } from '../../bots/use-bot-host-label'
import { BotMemoryPanel } from './BotMemoryPanel'
import { BotSoulEditor } from './BotSoulEditor'
import type { BotHome } from './bot-home-files'
import { type BotHomeFile, useBotHomeFile } from './use-bot-home-file'

function BotHomeFileBody({
  home,
  file,
  name,
  children
}: {
  home: BotHome
  file: BotHomeFile
  name: string
  children: (file: BotHomeFile & { disk: string }) => React.ReactNode
}): React.ReactNode {
  const t = useTranslate()
  const offline = useBotHostOffline(home.bot.hostId)
  const host = useBotHostLabel(home.bot.hostId)
  if (file.disk !== null) {
    return children({ ...file, disk: file.disk })
  }
  if (file.readError && offline && host) {
    // The view already says it can't reach the host; the transport error adds nothing.
    return (
      <p className="px-1 text-xs text-muted-foreground">
        {t('bots.settingsView.unreadOffline', '{{file}} opens once {{host}} is back.', {
          file: name,
          host
        })}
      </p>
    )
  }
  if (file.readError) {
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
        {file.readError}
        <Button variant="ghost" size="xs" onClick={() => void file.refresh()}>
          {t('settings.bots.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  return (
    <div className="flex min-h-24 items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {t('bots.settingsView.reading', 'Reading {{file}}…', { file: name })}
    </div>
  )
}

export function BotSoulBody({
  home,
  footer
}: {
  home: BotHome
  /** Under the editor, such as Open as file. */
  footer?: React.ReactNode
}): React.ReactNode {
  const t = useTranslate()
  const soul = useBotHomeFile(home, 'SOUL.md')
  return (
    <BotHomeFileBody home={home} file={soul} name="SOUL.md">
      {(file) => (
        <>
          <BotSoulEditor file={file} label={t('settings.bots.soul', 'Soul')} />
          {footer}
        </>
      )}
    </BotHomeFileBody>
  )
}

export function BotMemoryBody({
  bot,
  home,
  defaultTab,
  children
}: {
  bot: BotRef
  home: BotHome
  defaultTab?: 'facts' | 'history'
  /** After the facts: the topic files. */
  children?: React.ReactNode
}): React.ReactNode {
  const memory = useBotHomeFile(home, 'MEMORY.md')
  return (
    <BotHomeFileBody home={home} file={memory} name="MEMORY.md">
      {(file) => (
        <BotMemoryPanel bot={bot} file={file} defaultTab={defaultTab}>
          {children}
        </BotMemoryPanel>
      )}
    </BotHomeFileBody>
  )
}
