import { useTranslate } from '@/i18n/use-translate'
import { DropdownMenuItem } from '../../../ui/dropdown-menu'
import { SettingsBadge } from '../../form-controls/SettingsFormControls'

type AgentCopyCard = { baseLabel: string; identity: React.ReactNode; onDelete: () => void }

/** What an agent's card takes for its copies: the Duplicate action, and a copy's own card. */
export type AgentCopyCardProps = {
  /** Saves a named copy of this agent; absent where copies cannot be made. */
  onDuplicate?: () => void
  /** Tells this card apart from its agent's; an agent copy's id. Absent uses `agentId`. */
  rowId?: string
  /** Opens showing its details, as a copy just made does. */
  initiallyExpanded?: boolean
  /** On an agent copy's card: the agent it copies, its name and ID fields, and its delete. */
  copy?: AgentCopyCard
}

/** Names the agent a copy's card copies. */
export function AgentCopyBadge({ baseLabel }: { baseLabel: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsBadge tone="muted">
      {t('settings.agents.copyOf', 'Copy of {{agent}}', { agent: baseLabel })}
    </SettingsBadge>
  )
}

/** The card menu's Duplicate, and on a copy's card its Delete. */
export function AgentCopyMenuItems({
  label,
  onDuplicate,
  copy
}: Pick<AgentCopyCardProps, 'onDuplicate' | 'copy'> & { label: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {onDuplicate && (
        <DropdownMenuItem onSelect={onDuplicate}>
          {t('settings.agents.duplicate', 'Duplicate')}
        </DropdownMenuItem>
      )}
      {copy && (
        <DropdownMenuItem variant="destructive" onSelect={copy.onDelete}>
          {t('settings.agents.deleteCopy', 'Delete {{name}}', { name: label })}
        </DropdownMenuItem>
      )}
    </>
  )
}
