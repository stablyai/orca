import { AgentIcon } from '@/lib/agent-catalog'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { SessionsBoardCard } from './SessionsBoardCard'
import { SessionsBoardColumnShell } from './SessionsBoardColumnShell'
import type { SessionsBoardCardAvailability } from './sessions-board-card-availability'
import type { SessionsBoardColumn as SessionsBoardColumnData } from './sessions-board-column-model'

/**
 * One agent type's sessions, as a column. The chrome lives in `SessionsBoardColumnShell`; what is
 * left here is the part that is genuinely about agents — the icon and the cards.
 */
export function SessionsBoardColumn({
  column,
  collapsed,
  availabilityById,
  onToggleCollapsed,
  onOpenSession,
  onCopy,
  onJumpToWorkspace,
  onResume
}: {
  column: SessionsBoardColumnData
  collapsed: boolean
  availabilityById: ReadonlyMap<string, SessionsBoardCardAvailability>
  onToggleCollapsed: () => void
  onOpenSession: (session: AiVaultSession) => void
  onCopy: (text: string) => void
  onJumpToWorkspace: (session: AiVaultSession) => void
  onResume: (session: AiVaultSession) => void
}): React.JSX.Element {
  return (
    <SessionsBoardColumnShell
      columnKey={column.agent}
      label={column.label}
      count={column.sessions.length}
      icon={<AgentIcon agent={column.agent} size={14} />}
      // Why supplied separately: the rail has always drawn agent icons larger than the header does.
      railIcon={<AgentIcon agent={column.agent} size={16} />}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
    >
      {column.sessions.map((session) => (
        <SessionsBoardCard
          key={`${session.executionHostId}:${session.filePath}`}
          session={session}
          availability={availabilityById.get(session.id) ?? null}
          onOpen={() => onOpenSession(session)}
          onCopy={onCopy}
          onJump={() => onJumpToWorkspace(session)}
          onResume={() => onResume(session)}
        />
      ))}
    </SessionsBoardColumnShell>
  )
}
