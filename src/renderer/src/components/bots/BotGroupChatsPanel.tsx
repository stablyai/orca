import { MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import {
  BotGroupRoomUnavailableError,
  openBotGroupRoom,
  selectActiveBotGroupRoomId
} from '@/lib/bot-group-catalog'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { botRefKey } from '@/lib/bot-hosts'
import { useAppStore } from '@/store'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { botGroupFaces } from '../../../../shared/bots/bot-group-face-layout'
import { BotGroupFaces } from './BotGroupFaces'
import { useBotGroupMembers } from './use-bot-group-members'

export function BotGroupChatsPanel({ group }: { group: BotGroup }): React.JSX.Element {
  const t = useTranslate()
  const current = useAppStore(selectActiveBotGroupRoomId)
  const offline = useBotHostOffline(group.hostId)
  const members = useBotGroupMembers(group)
  const newThread = t('bots.groups.newThreadTab', 'New thread')
  const threads = group.threads?.toSorted((a, b) => b.createdAt - a.createdAt)
  const roomRow = (id: string, label: string, icon: React.ReactNode): React.JSX.Element => (
    <button
      key={id}
      type="button"
      disabled={offline}
      aria-current={id === current ? 'page' : undefined}
      data-current={id === current || undefined}
      className="flex h-8 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-[13px] font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[current=true]:bg-accent"
      onClick={() =>
        void openBotGroupRoom(group, id, label).catch((error: unknown) => {
          if (!(error instanceof BotGroupRoomUnavailableError && error.userNotified)) {
            toast.error(error instanceof Error ? error.message : String(error))
          }
        })
      }
    >
      <span
        className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-2.5 pb-3">
      {offline ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          {t('bots.panel.disconnected', 'Disconnected')}
        </p>
      ) : null}
      {roomRow(
        group.id,
        group.name,
        <BotGroupFaces faces={botGroupFaces(members, botRefKey)} className="size-5" slot={20} />
      )}
      {threads?.map((thread) =>
        roomRow(thread.id, thread.title ?? newThread, <MessageSquare className="size-3.5" />)
      )}
    </div>
  )
}
