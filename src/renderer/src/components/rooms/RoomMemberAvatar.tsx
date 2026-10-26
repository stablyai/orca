import { Bot, Crown, User } from 'lucide-react'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { RoomMember } from './room-types'

type AvatarMember = Pick<RoomMember, 'name'> & { isAdmin?: boolean; agent?: string }

const ROOM_AGENT_IDS = new Set([
  'codex',
  'claude',
  'pi',
  'grok',
  'opencode',
  'opencode2',
  'omp',
  'antigravity'
])

/** Bot member ids look like `orca_session_id:codex_<uuid>`; parse the agent slug. */
export function agentFromMemberId(memberId: string | undefined): string | null {
  if (!memberId?.startsWith('orca_session_id:')) {
    return null
  }
  const slug = memberId.slice('orca_session_id:'.length).split('_')[0] ?? ''
  return ROOM_AGENT_IDS.has(slug) ? slug : null
}

/** A stable identity tile for room speakers and roster rows. */
export function RoomMemberAvatar(props: {
  member?: AvatarMember
  fallbackName?: string
  className?: string
}) {
  const name = props.member?.name ?? props.fallbackName ?? ''
  const isAdmin = props.member?.isAdmin === true
  const agent = props.member?.agent ?? null
  const catalogAgent = getAgentCatalog().find((entry) => entry.id === agent)
  const showAgent = !isAdmin && catalogAgent
  const Icon = isAdmin ? Crown : props.member && !showAgent ? Bot : User
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-secondary text-secondary-foreground',
        isAdmin &&
          'border-annotation-highlight/50 bg-annotation-highlight/10 text-annotation-highlight dark:text-annotation-highlight',
        props.className
      )}
    >
      {showAgent ? <AgentIcon agent={catalogAgent.id} size={14} /> : <Icon className="size-3.5" />}
      <span className="sr-only">{name}</span>
    </span>
  )
}
