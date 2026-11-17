import { AlertTriangle, AtSign, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { AntigravitySwarmMember } from '../../../../../shared/agent-session/antigravity-swarm-wire'

function statusDotClass(member: AntigravitySwarmMember): string {
  if (member.failure) {
    return 'bg-destructive'
  }
  if (member.status === 'working') {
    return 'bg-foreground animate-pulse'
  }
  if (member.status === 'killed') {
    return 'bg-muted-foreground/40'
  }
  return 'bg-muted-foreground'
}

function worktreeLabel(worktree: string | null): string | null {
  if (!worktree) {
    return null
  }
  const parts = worktree.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? worktree
}

export function NativeChatSwarmRoster({
  members,
  memberFilter,
  canMention,
  onToggleFilter,
  onClearFilter,
  onOpenConversation,
  onMention
}: {
  members: readonly AntigravitySwarmMember[]
  memberFilter: string | null
  canMention: boolean
  onToggleFilter: (name: string) => void
  onClearFilter: () => void
  onOpenConversation: (conversationId: string) => void
  onMention: (name: string) => void
}): React.JSX.Element {
  const t = useTranslate()

  return (
    <section
      aria-label={t('components.native-chat.swarm.rosterLabel', 'Swarm members')}
      className="scrollbar-sleek flex min-h-0 flex-col gap-1 overflow-y-auto border-b border-border p-2 md:border-r md:border-b-0"
    >
      <div className="flex items-center justify-between px-1.5 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span>
          {t('components.native-chat.swarm.membersHeading', 'Members ({{count}})', {
            count: members.length
          })}
        </span>
        {memberFilter ? (
          <button
            type="button"
            onClick={onClearFilter}
            className="rounded px-1 py-0.5 text-2xs font-normal normal-case hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('components.native-chat.swarm.clearFilter', 'All')}
          </button>
        ) : null}
      </div>

      {members.map((member) => {
        const selected = memberFilter === member.name
        const worktree = worktreeLabel(member.worktree)
        return (
          <div
            key={member.name}
            className={cn(
              'group rounded-md border px-2 py-1.5 transition-colors',
              selected
                ? 'border-border bg-accent'
                : 'border-transparent hover:border-border hover:bg-accent/50'
            )}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onToggleFilter(member.name)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={cn('size-2 shrink-0 rounded-full', statusDotClass(member))} />
                <span className="truncate text-xs font-medium text-foreground">{member.name}</span>
                <span className="shrink-0 text-3xs uppercase text-muted-foreground">
                  {member.role === 'coordinator'
                    ? t('components.native-chat.swarm.leadRole', 'lead')
                    : member.role === 'monitor'
                      ? `${t('components.native-chat.swarm.monitorRole', 'monitor')} · ${member.status}`
                      : member.status}
                </span>
              </button>
              {member.unread > 0 && !member.killed ? (
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-3xs font-medium text-foreground">
                  {member.unread}
                </span>
              ) : null}
              {member.conversationId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onOpenConversation(member.conversationId)}
                  aria-label={t(
                    'components.native-chat.swarm.openConversation',
                    'Open {{name}} conversation',
                    { name: member.name }
                  )}
                  title={t(
                    'components.native-chat.swarm.openConversation',
                    'Open {{name}} conversation',
                    { name: member.name }
                  )}
                >
                  <MessageSquare className="size-3" />
                </Button>
              ) : null}
              {canMention ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onMention(member.name)}
                  aria-label={t('components.native-chat.swarm.mentionMember', 'Mention @{{name}}', {
                    name: member.name
                  })}
                  title={t('components.native-chat.swarm.mentionMember', 'Mention @{{name}}', {
                    name: member.name
                  })}
                >
                  <AtSign className="size-3" />
                </Button>
              ) : null}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-3.5 text-2xs text-muted-foreground">
              {member.model ? <span className="truncate">{member.model}</span> : null}
              <span>
                {t('components.native-chat.swarm.stepsCount', '{{count}} steps', {
                  count: member.steps
                })}
              </span>
              {worktree ? (
                <span className="truncate font-mono" title={member.worktree ?? undefined}>
                  {worktree}
                </span>
              ) : null}
            </div>

            {member.failure ? (
              <div className="mt-1 flex items-center gap-1 pl-3.5 text-2xs text-destructive">
                <AlertTriangle className="size-3 shrink-0" />
                <span className="truncate" title={member.failure.text}>
                  {member.failure.text}
                </span>
              </div>
            ) : member.activity ? (
              <p className="mt-0.5 truncate pl-3.5 text-2xs text-muted-foreground">
                {member.activity}
              </p>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
