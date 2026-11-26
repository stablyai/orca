import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useWorktreeLineAgent } from './worktree-card-line-agents'

/** A one-line card's other agents as "+N" right after its title. Its own piece so the look can change alone. */
export function WorktreeCardLineAgentMore({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const agent = useWorktreeLineAgent(worktreeId)
  if (!agent || agent.others === 0) {
    return null
  }
  return (
    <span
      className={cn(
        'shrink-0 text-2xs leading-none tabular-nums',
        agent.othersNeedYou ? 'text-status-warning' : 'text-muted-foreground'
      )}
      aria-label={t('bots.workspaces.moreAgents', '{{count}} more agents', {
        count: agent.others,
        defaultValue_one: '{{count}} more agent'
      })}
    >
      +{agent.others}
    </span>
  )
}
