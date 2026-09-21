import React from 'react'
import { SquareTerminal } from 'lucide-react'
import type { CliWorkspaceProvenance } from '../../../../shared/worktree/types'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { DetailHeader } from './WorktreeCardMetadataControls'
import { translate } from '@/i18n/i18n'

export function WorktreeCardCliDetailSection({
  provenance
}: {
  provenance: CliWorkspaceProvenance
}): React.JSX.Element {
  const agentLabel = provenance.startupAgent
    ? formatAgentTypeLabel(provenance.startupAgent)
    : undefined

  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<SquareTerminal className="size-3 text-muted-foreground" />}
        label={translate('auto.components.sidebar.WorktreeCardMeta.cliHeader', 'Orca CLI')}
      />
      <WorktreeCardDetailSectionContent className="space-y-1.5">
        <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
          {provenance.callerTerminalHandle
            ? translate(
                'auto.components.sidebar.WorktreeCardMeta.cliCreatedFromAgent',
                'Created by an agent via `orca worktree create`'
              )
            : translate(
                'auto.components.sidebar.WorktreeCardMeta.cliCreatedFromShell',
                'Created via `orca worktree create`'
              )}
        </div>
        {agentLabel ? (
          <div className="text-[11.5px] leading-snug text-muted-foreground break-words">
            {translate(
              'auto.components.sidebar.WorktreeCardMeta.cliStartupAgent',
              'Started with {{value0}}',
              { value0: agentLabel }
            )}
          </div>
        ) : null}
      </WorktreeCardDetailSectionContent>
    </WorktreeCardDetailSection>
  )
}
