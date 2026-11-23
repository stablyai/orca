import { Network, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { AntigravitySwarmSnapshot } from '../../../../../shared/agent-session/antigravity-swarm-wire'
import { NativeChatComposerTabStrip } from '../composer/controls/NativeChatComposerTabStrip'

export function NativeChatSwarmStrip({
  snapshot,
  isOpen,
  onToggle
}: {
  snapshot: AntigravitySwarmSnapshot
  isOpen: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const working = snapshot.members.filter((m) => m.status === 'working').length
  const waiting = snapshot.members.filter((m) => m.status === 'waiting').length
  const killed = snapshot.members.filter((m) => m.status === 'killed').length
  const failures = snapshot.members.filter((m) => m.failure !== null).length
  const unread = snapshot.members
    .filter((m) => !m.killed && m.unread > 0)
    .reduce((sum, m) => sum + m.unread, 0)

  const counts = [
    working > 0
      ? t('components.native-chat.swarm.workingCount', '{{count}} working', { count: working })
      : null,
    waiting > 0
      ? t('components.native-chat.swarm.waitingCount', '{{count}} waiting', { count: waiting })
      : null,
    killed > 0
      ? t('components.native-chat.swarm.killedCount', '{{count}} stopped', { count: killed })
      : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <NativeChatComposerTabStrip data-native-chat-swarm-strip="">
      <div className="flex min-w-0 flex-1 items-center gap-2 py-0.5">
        <Network className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground">{snapshot.title}</span>
        {counts ? <span className="shrink-0 text-2xs text-muted-foreground">{counts}</span> : null}
        {failures > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-3xs font-medium text-destructive">
            <AlertTriangle className="size-3" />
            {t('components.native-chat.swarm.failureCount', '{{count}} failed', {
              count: failures
            })}
          </span>
        ) : null}
        {unread > 0 ? (
          <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-3xs font-medium text-foreground">
            {t('components.native-chat.swarm.unreadBadge', '{{count}} unread', { count: unread })}
          </span>
        ) : null}
      </div>
      <Button type="button" variant="ghost" size="xs" onClick={onToggle}>
        {isOpen
          ? t('components.native-chat.swarm.hideBoard', 'Hide board')
          : t('components.native-chat.swarm.openBoard', 'Swarm board')}
      </Button>
    </NativeChatComposerTabStrip>
  )
}
