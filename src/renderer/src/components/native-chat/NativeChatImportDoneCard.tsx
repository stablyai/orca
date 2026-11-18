// What an import brought over (`orca bot import done`): each thing created, with a way to open it, what stayed
// in the old app, and when to turn the paused automations on.
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { openBotSettings } from '@/components/bots/bot-settings-open'
import type { BotImportDone } from '../../../../shared/bots/bot-import-cards'
import { NativeChatCardAvatar, NativeChatCardFrame } from './NativeChatCardFrame'

type Created = BotImportDone['created'][number]

/** Soul and memory are edited on the bot's Settings page; automations on the Automations page. */
function opener(entry: Created, botId: string): (() => void) | null {
  switch (entry.kind) {
    case 'soul':
    case 'memory': {
      const place = entry.kind
      return () => openBotSettings(botId, place)
    }
    case 'automations':
      return () => useAppStore.getState().openAutomationsPage()
    case 'abilities':
    case 'tools':
    case 'other':
      return null
  }
}

export function NativeChatImportDoneCard({ done }: { done: BotImportDone }): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  return (
    <NativeChatCardFrame
      avatar={
        <NativeChatCardAvatar>
          <Check className="size-4 text-muted-foreground" aria-hidden />
        </NativeChatCardAvatar>
      }
      heading={t('components.native-chat.importDone.heading', 'Import finished')}
    >
      <p className="mt-0.5 text-sm font-medium text-foreground">
        {t('components.native-chat.importDone.title', '{{name}} came over from {{app}}', {
          name: done.name,
          app: done.app
        })}
      </p>
      {done.created.length ? (
        <div className="mt-2 space-y-1">
          {done.created.map((entry) => {
            const open = opener(entry, done.botId)
            return (
              <div
                key={`${entry.kind}:${entry.what}`}
                className="flex min-w-0 items-center justify-between gap-3"
              >
                <p className="min-w-0 truncate text-sm">
                  <span className="font-medium">{entry.what}</span>
                  {entry.detail ? (
                    <span className="text-muted-foreground"> {entry.detail}</span>
                  ) : null}
                </p>
                {open ? (
                  <Button type="button" variant="outline" size="xs" onClick={open}>
                    {t('components.native-chat.importDone.open', 'Open')}
                  </Button>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
      <p className="mt-2 text-2xs text-muted-foreground">
        {done.stayed.length
          ? t(
              'components.native-chat.importDone.stayed',
              'Stayed in {{app}}: {{things}}. Nothing in {{app}} was changed.',
              { app: done.app, things: done.stayed.join(', ') }
            )
          : t('components.native-chat.importDone.unchanged', 'Nothing in {{app}} was changed.', {
              app: done.app
            })}
      </p>
      {done.paused ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          {t(
            'components.native-chat.importDone.paused',
            'Automations are paused so nothing runs twice. Turn them on once the old bot is switched off in {{app}}.',
            { app: done.app }
          )}
        </p>
      ) : null}
    </NativeChatCardFrame>
  )
}
