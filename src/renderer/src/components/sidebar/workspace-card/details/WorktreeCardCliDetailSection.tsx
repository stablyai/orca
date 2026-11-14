import React from 'react'
import { SquareTerminal } from 'lucide-react'
import type { CliWorkspaceProvenance } from '../../../../../../shared/worktree/types'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { DetailHeader } from '../metadata/WorktreeCardMetadataControls'
import { useTranslate } from '@/i18n/use-translate'

export function WorktreeCardCliDetailSection({
  provenance
}: {
  provenance: CliWorkspaceProvenance
}): React.JSX.Element {
  const t = useTranslate()
  const agentLabel = provenance.startupAgent
    ? formatAgentTypeLabel(provenance.startupAgent)
    : undefined

  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<SquareTerminal className="size-3 text-muted-foreground" />}
        label={t('auto.components.sidebar.WorktreeCardMeta.cliHeader', 'Orca CLI')}
      />
      <WorktreeCardDetailSectionContent className="space-y-1.5">
        <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
          {provenance.callerTerminalHandle
            ? t(
                'auto.components.sidebar.WorktreeCardMeta.cliCreatedFromAgent',
                'Created by an agent via `orca worktree create`'
              )
            : t(
                'auto.components.sidebar.WorktreeCardMeta.cliCreatedFromShell',
                'Created via `orca worktree create`'
              )}
        </div>
        {agentLabel ? (
          <div className="text-[11.5px] leading-snug text-muted-foreground break-words">
            {t(
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
