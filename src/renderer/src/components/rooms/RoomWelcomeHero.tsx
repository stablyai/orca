import { Bot, Crown, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import { useTranslate } from '@/i18n/use-translate'

/** Static welcome for empty rooms: explains the Chief pattern, never written to the log. */
export function RoomWelcomeHero(props: {
  roomName: string
  adminName: string | null
  onQuickSend: (text: string) => void
  onSpawnBot: () => void
}) {
  const t = useTranslate()
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
          ? t('auto.components.rooms.hero.adminLeads', '{{name}} is the admin here. ', {
              name: props.adminName
            })
          : ''}
        {t(
          'auto.components.rooms.hero.subtitle',
          'Describe the team or task you need. The chief can create bots and start group chats.'
        )}
      </div>
      <div className="mt-5 grid w-full gap-2">
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => props.onQuickSend('你好，请介绍一下你能帮我做什么？')}
          >
            <Sparkles className="h-3.5 w-3.5" /> {t('auto.components.rooms.hero.sayHi', 'Say hi')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onQuickSend('帮我创建一个代码审查 Bot，并拉一个小群。')}
          >
            <Bot className="h-3.5 w-3.5" />{' '}
            {t('auto.components.rooms.hero.spawnBot', 'Create a bot')}
          </Button>
        </div>
        <Button
          variant="outline"
          className="justify-start text-left"
          onClick={() =>
            props.onQuickSend('帮我建一个小组：一个规划 Bot，一个实现 Bot，一个审查 Bot。')
          }
        >
          {t('auto.components.rooms.hero.howTo', 'Build a review team')}
        </Button>
        <Button
          variant="ghost"
          className="justify-start text-left text-muted-foreground"
          onClick={() =>
            props.onQuickSend('帮我创建一个文档整理 Bot，让它先列出可以自动整理的事项。')
          }
        >
          {t('auto.components.rooms.hero.docBot', 'Create a document bot')}
        </Button>
      </div>
    </div>
  )
}
