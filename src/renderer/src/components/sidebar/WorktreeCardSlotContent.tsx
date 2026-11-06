import React, { useCallback, useMemo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'

import { buildAgentRowLineageTree } from '@/components/dashboard/agent-row-lineage-model'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { resolveRowProgramStatus } from '@/lib/program-status/agent-row-presentation'
import { useAppStore } from '@/store'
import { workspaceHasLiveMarker } from '@/store/slices/workspace-attention/workspace-live-markers'
import type { WorktreeCardController } from './workspace-card/controller/use-worktree-card-controller'
import { useWorktreeAgentRows } from './workspace-card/activity/useWorktreeAgentRows'
import { agentRowDisplayDotState as getAgentDotState } from '@/lib/agent-row-dot-state'
import { WorktreeCardIdentityHover } from './worktree-card-identity-hover'
import type { WorktreeCardPresentation } from './workspace-card/surface/worktree-card-presentation'
import { WorktreeCardSecondaryRows } from './workspace-card/surface/worktree-card-secondary-rows'
import { useCollapsedLineageSlot, useLineageLatestAt } from './worktree-card-slot-rollup'
import {
  classifySlotLine,
  compareSlotLines,
  slotLineAt,
  titleRowSlot
} from './worktree-card-slot-signal'
import {
  WorktreeCardDeleteQuickAction,
  WorktreeCardRenameFailedButton
} from './worktree-card-title-actions'
import { WorktreeCardSlot } from './WorktreeCardSlot'
import { useWorktreeAgentExpansionState } from './workspace-card/activity/worktree-card-agents-expansion-state'
import {
  CompactAgentExpansion,
  CompactAgentSummaryButton
} from './workspace-card/activity/worktree-card-compact-agents'
import { dispatchSuppressScrollAdjustment } from './workspace-card/activity/WorktreeCardAgents'
import { translate } from '@/i18n/i18n'
import {
  SlotAgentLinesHeader,
  WorktreeCardSlotAgentLines,
  type SlotAgentLine
} from './WorktreeCardSlotAgentLines'
import { shouldBeginWorktreeRename } from './workspace-card/controller/worktree-card-model'
import { WorktreeTitleInlineRename } from './workspace-card/identity/WorktreeTitleInlineRename'
import { WorktreeCardMetaRow } from './workspace-card/metadata/worktree-card-meta-row'

const NO_DESCENDANTS: readonly string[] = []

function useSlotAgentLines(worktreeId: string): SlotAgentLine[] {
  const agents = useWorktreeAgentRows(worktreeId)
  // Subagents belong to their lead agent's line; one line per agent.
  const rootAgents = useMemo(() => buildAgentRowLineageTree(agents).rootRows, [agents])
  const unreadCompletions = useAppStore(
    useShallow((s) =>
      rootAgents.map((agent) => Boolean(s.unreadAgentCompletionPanes[agent.paneKey]))
    )
  )
  return useMemo(() => {
    const lines = rootAgents.map((agent, index): SlotAgentLine => {
      const { presentation, dotStateOverride } = resolveRowProgramStatus(agent)
      const dotState = dotStateOverride ?? getAgentDotState(agent)
      const kind = classifySlotLine({
        dotState,
        needsAttention: Boolean(presentation.attention),
        unreadCompletion: unreadCompletions[index] ?? false
      })
      return { agent, dotState, signal: { kind, at: slotLineAt(agent, kind) } }
    })
    return lines.sort((a, b) => compareSlotLines(a.signal, b.signal))
  }, [rootAgents, unreadCompletions])
}

/** Experimental 2.0 card: name and one right-hand slot, then one line per agent. */
export function WorktreeCardSlotContent({
  card,
  presentation
}: {
  card: WorktreeCardController
  presentation: WorktreeCardPresentation
}): React.JSX.Element {
  const {
    worktree,
    affiliateListMode,
    renameRowKey,
    visibleCardTitle,
    isDeleting,
    isRuntimeDisconnected,
    setTitleRenaming,
    handleRenameTitle,
    renamingWorktreeId,
    setRenamingWorktreeId,
    showInlineAgentList,
    showDeleteQuickAction,
    showLineageChildChip,
    lineageCollapsed,
    lineageDescendantIds,
    onLineageToggle,
    lineageChildAriaLabel,
    childWorkspaceShortLabel,
    settings
  } = card
  const lines = useSlotAgentLines(worktree.id)
  const now = useNow(30_000)
  const hasLiveMarker = useAppStore((s) => workspaceHasLiveMarker(s, worktree.id))
  // A flag with no tab or agent marker behind it was set by the user.
  const manualUnread = worktree.isUnread && !hasLiveMarker
  const descendantIds = lineageDescendantIds ?? NO_DESCENDANTS
  const collapsedLineage = useCollapsedLineageSlot(
    lineageCollapsed ? descendantIds : NO_DESCENDANTS
  )
  const lineageLatestAt = useLineageLatestAt(descendantIds)
  // Several agents fold into the 1.0 summary row; the title slot speaks for them until expanded.
  const { compactRootListExpanded: agentsExpanded, toggleCompactRootList } =
    useWorktreeAgentExpansionState(worktree.id)
  const toggleAgents = useCallback(() => {
    dispatchSuppressScrollAdjustment()
    toggleCompactRootList()
  }, [toggleCompactRootList])
  const showLines = showInlineAgentList && lines.length > 0
  const foldsAgents = showLines && lines.length > 1
  const ownLinesShown = showLines && (!foldsAgents || agentsExpanded)
  const titleSlot = titleRowSlot({
    offline: isRuntimeDisconnected,
    hiddenLines: ownLinesShown ? [] : lines.map((line) => line.signal),
    collapsedLineage,
    manualUnread,
    ownLinesShown,
    lastActivityAt: worktree.lastActivityAt > 0 ? worktree.lastActivityAt : null,
    lineageLatestAt
  })
  const showDetailsRow =
    settings?.worktreeCardDetailsRow === true &&
    (presentation.hasMetaRow || presentation.detailsAndPorts !== null)
  const titleBold = manualUnread || lines.some((line) => line.signal.kind === 'unread')

  const agentLines = showLines ? (
    <WorktreeCardSlotAgentLines
      worktreeId={worktree.id}
      lines={lines}
      now={now}
      offline={isRuntimeDisconnected}
    />
  ) : null

  const agentCountLabel = translate('sidebar.agentSummary.agentCount', '{{count}} agents', {
    count: lines.length,
    defaultValue_one: '{{count}} agent'
  })
  const slotRows = (
    <>
      {foldsAgents ? (
        <>
          {agentsExpanded ? (
            <SlotAgentLinesHeader label={agentCountLabel} onCollapse={toggleAgents} />
          ) : (
            <div className="mt-[3px] min-w-0 pr-2">
              <CompactAgentSummaryButton
                agents={lines.map((line) => line.agent)}
                subjectLabel={agentCountLabel}
                expanded={false}
                onToggle={toggleAgents}
              />
            </div>
          )}
          <CompactAgentExpansion expanded={agentsExpanded}>{agentLines}</CompactAgentExpansion>
        </>
      ) : (
        agentLines
      )}
      {showLineageChildChip ? (
        <div className="mt-[3px] flex min-w-0">
          <Button
            type="button"
            variant="outline"
            size="chip"
            className="max-w-40 text-muted-foreground"
            aria-label={lineageChildAriaLabel}
            aria-expanded={!lineageCollapsed}
            onClick={onLineageToggle}
          >
            {lineageCollapsed ? (
              <ChevronRight className="size-2.5" />
            ) : (
              <ChevronDown className="size-2.5" />
            )}
            <span className="truncate">{childWorkspaceShortLabel}</span>
          </Button>
        </div>
      ) : null}
    </>
  )

  return (
    <div
      className="flex w-full min-w-0 flex-col overflow-hidden"
      data-worktree-card-parent-content=""
      data-worktree-card-style="experimental-2"
    >
      <WorktreeCardIdentityHover card={card} presentation={presentation}>
        <div
          className="group/worktree-card flex min-w-0 flex-col"
          data-worktree-card-hover-trigger=""
        >
          <div className="flex h-5 min-w-0 items-center gap-1.5 pr-2">
            <WorktreeTitleInlineRename
              displayName={visibleCardTitle}
              disabled={isDeleting || affiliateListMode}
              showUnreadEmphasis={titleBold}
              dimReadTitle
              className="text-[13px] leading-5"
              editingClassName="flex-1"
              titleWrapper={presentation.titleWrapper}
              onEditingChange={affiliateListMode ? undefined : setTitleRenaming}
              onRename={handleRenameTitle}
              beginEditing={
                !affiliateListMode &&
                shouldBeginWorktreeRename(renamingWorktreeId, worktree.id, renameRowKey)
              }
              onBeginEditingConsumed={
                affiliateListMode ? undefined : () => setRenamingWorktreeId(null)
              }
            />
            <WorktreeCardRenameFailedButton card={card} />
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {showDeleteQuickAction ? <WorktreeCardDeleteQuickAction card={card} /> : null}
              <WorktreeCardSlot signal={titleSlot} now={now} />
            </span>
          </div>
          {showDetailsRow ? (
            <div
              className="mt-1 mb-1 flex h-4 min-w-0 items-center gap-1.5 pr-2"
              data-worktree-card-details-row=""
            >
              {presentation.hasMetaRow ? (
                <div className="min-w-0 flex-1 pl-1">
                  <WorktreeCardMetaRow card={card} presentation={presentation} />
                </div>
              ) : null}
              {presentation.detailsAndPorts ? (
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {presentation.detailsAndPorts}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </WorktreeCardIdentityHover>
      <WorktreeCardSecondaryRows card={card} presentation={presentation} slotRows={slotRows} />
    </div>
  )
}
