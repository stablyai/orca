import { defineFixture } from '../../component-fixtures/component-fixture'
import { WorktreeHostContextBadge } from '@/components/sidebar/workspace-card/host/WorktreeHostContextBadge'
import { BotAvatarTile } from '../bots/BotAvatar'
import type { NativeChatRoomMention } from './composer/native-chat-composer-types'
import { NativeChatMentionOption } from './NativeChatMentionOption'

const icon = (fallback: string) => (
  <BotAvatarTile src={null} fallback={fallback} className="size-5 shrink-0" />
)

// This computer's bot, a paired server's (its pill), one on a server that is down (dimmed in place),
// and a paused one (unpickable).
const ROWS: NativeChatRoomMention[] = [
  { name: 'Perf bot', icon: icon('⚡'), detail: 'Owns Orca performance audits and fixes' },
  {
    name: 'Bot-Release-Manager',
    icon: icon('🚀'),
    detail: 'Cuts and verifies desktop releases',
    host: <WorktreeHostContextBadge label="m4 air" />
  },
  {
    name: 'Nightly QA',
    icon: icon('🧪'),
    detail: 'Runs the nightly e2e sweep',
    host: <WorktreeHostContextBadge label="Build Box" />,
    dimmed: true
  },
  { name: 'Docs bot', icon: icon('📚'), unavailable: 'Paused' }
]

export const bots = defineFixture({
  width: 360,
  render: () => (
    <div className="rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      {ROWS.map((row, index) => (
        <div
          key={row.name}
          className={
            index === 1
              ? 'flex w-full items-center gap-2 rounded-sm bg-accent px-2 py-1.5 text-sm'
              : 'flex w-full items-center gap-2 px-2 py-1.5 text-sm'
          }
        >
          <NativeChatMentionOption value={row.name} member={row} />
        </div>
      ))}
    </div>
  )
})
