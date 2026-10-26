import { Bot, Crown, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'

/** Static welcome for empty rooms: explains the Chief pattern, never written to the log. */
export function RoomWelcomeHero(props: {
  roomName: string
  adminName: string | null
  onQuickSend: (text: string) => void
  onSpawnBot: () => void
}) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center px-6 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
        <Crown className="h-5 w-5 text-annotation-highlight" />
      </div>
      <div className="mt-3 text-lg font-semibold">{props.adminName ?? props.roomName}</div>
      <div className="mt-2 text-sm text-muted-foreground">
        {props.adminName
          ? translate('auto.components.rooms.hero.adminLeads', '{{name}} is the admin here. ', {
              name: props.adminName
            })
          : ''}
        {translate(
          'auto.components.rooms.hero.subtitle',
          'Describe the team or task you need. The chief can create bots and start group chats.'
        )}
      </div>
      <div className="mt-5 grid w-full gap-2">
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              props.onQuickSend(
                translate(
                  'auto.components.rooms.hero.sayHiPrompt',
                  'Hi! What can you help me with?'
                )
              )
            }
          >
            <Sparkles className="h-3.5 w-3.5" />{' '}
            {translate('auto.components.rooms.hero.sayHi', 'Say hi')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              props.onQuickSend(
                translate(
                  'auto.components.rooms.hero.spawnBotPrompt',
                  'Create a code review bot and start a small group chat.'
                )
              )
            }
          >
            <Bot className="h-3.5 w-3.5" />{' '}
            {translate('auto.components.rooms.hero.spawnBot', 'Create a bot')}
          </Button>
        </div>
        <Button
          variant="outline"
          className="justify-start text-left"
          onClick={() =>
            props.onQuickSend(
              translate(
                'auto.components.rooms.hero.howToPrompt',
                'Build a team with a planning bot, an implementation bot, and a review bot.'
              )
            )
          }
        >
          {translate('auto.components.rooms.hero.howTo', 'Build a review team')}
        </Button>
        <Button
          variant="ghost"
          className="justify-start text-left"
          onClick={() =>
            props.onQuickSend(
              translate(
                'auto.components.rooms.hero.docBotPrompt',
                'Create a documentation bot and ask it to list what it can organize automatically.'
              )
            )
          }
        >
          {translate('auto.components.rooms.hero.docBot', 'Create a document bot')}
        </Button>
      </div>
    </div>
  )
}
