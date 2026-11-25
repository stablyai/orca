import React, { useCallback, useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { useAgentRowConversationNaming } from '@/components/dashboard/rows/use-agent-row-conversation-name'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import WorktreeCard from '../../workspace-card/surface/WorktreeCard'
import {
  useAgentPresentation,
  useWorktreeAgentRow
} from '../../workspace-card/activity/useWorktreeAgentRows'
import { getAgentRowPrimaryText } from '../../../../../../shared/agent-status/presentation/agent-row-primary-text'

type CardProps = React.ComponentProps<typeof WorktreeCard>

/** Whether a group session still carries the name Orca gave it ("platform workspace"), in any UI language. */
export function hasDefaultFolderWorkspaceName(name: string, groupName: string): boolean {
  const english = `${groupName} workspace`
  const localized = translate(
    'auto.components.sidebar.folderWorkspaceComposer.defaultWorkspaceName',
    '{{name}} workspace',
    { name: groupName }
  )
  return name === english || name === localized
}

function TitledByAgent({ agent, ...card }: CardProps & { agent: DashboardAgentRow }) {
  const conversationName = useAgentRowConversationNaming(agent).name
  const topic = conversationName ?? getAgentRowPrimaryText(agent.entry)
  const worktree = useMemo(
    () => (topic ? { ...card.worktree, displayName: topic } : card.worktree),
    [card.worktree, topic]
  )
  return <WorktreeCard {...card} worktree={worktree} />
}

function FirstAgentTitled({ paneKey, ...card }: CardProps & { paneKey: string }) {
  const agent = useWorktreeAgentRow(paneKey)
  return agent ? <TitledByAgent {...card} agent={agent} /> : <WorktreeCard {...card} />
}

/** Tree card style: a default-named group session reads by its first agent's topic instead. */
export function FolderWorkspaceTopicCard(card: CardProps): React.JSX.Element {
  const id = card.worktree.id
  const firstRoot = useAgentPresentation(
    `roots\0${id}`,
    useCallback((p) => p.display.roots(id)[0] ?? null, [id])
  )
  return firstRoot ? <FirstAgentTitled {...card} paneKey={firstRoot} /> : <WorktreeCard {...card} />
}
