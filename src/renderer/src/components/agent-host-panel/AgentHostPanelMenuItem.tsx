// The host ⋯ menu's one entry into the panel (Q11). It replaces the "Agents on {{host}}" group;
// sign-out lives in the panel.
import React from 'react'
import { KeyRound } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../../shared/execution-host/execution-host-health'
import { openAgentHostPanel } from './agent-host-panel-store'

export function AgentHostPanelMenuItem({
  hostId,
  host
}: {
  hostId: ExecutionHostId
  /** The row's label and health, so the panel needn't re-derive them. */
  host?: { label: string; health: ExecutionHostHealth }
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => openAgentHostPanel({ hostId, ...(host ? { host } : {}) })}>
        <KeyRound className="size-3.5" />
        {t('agentHostPanel.menuEntry', 'Agent accounts & secrets…')}
      </DropdownMenuItem>
    </>
  )
}
