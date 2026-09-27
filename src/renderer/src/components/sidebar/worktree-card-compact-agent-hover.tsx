import React from 'react'
import type { AgentDotState } from '@/components/AgentStateDot'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { preloadCommentMarkdown } from './comment-markdown-lazy'
import { WORKTREE_NATIVE_CONTEXT_MENU_ATTR } from './worktree-context-menu-policy'
import { WorktreeHoverCardBody, type WorktreeHoverSubagent } from './worktree-hover-card-body'
import { WorktreeHoverWorkspaceChips } from './worktree-hover-workspace-chips'
import { useWorktreeHoverFacts } from './worktree-hover-facts-context'
import type { WorktreeHoverFacts } from './worktree-hover-facts'

type CompactAgentRowHoverProps = {
  agentType: string
  dotState: AgentDotState
  primary: string
  secondary: string
  /** True when `secondary` is the agent's last reply; tool previews are plain text. */
  secondaryIsAssistantMessage: boolean
  model: string
  shortTime: string | null
  hideIdentityIcon: boolean
  subagents: WorktreeHoverSubagent[]
  children: React.ReactElement
}

function stopRowActivation(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

// Why: agent rows also render where no worktree card published its facts; the
// session alone is still worth a card.
const SESSION_ONLY_FACTS: WorktreeHoverFacts = {
  title: '',
  identityKind: 'branch',
  portCount: 0,
  portLabels: [],
  childWorkspaceCount: 0
}

/**
 * Hover preview for a sidebar agent row: the workspace the row belongs to plus the
 * session under the cursor, so a truncated prompt and reply read as rendered text
 * instead of the native title blob.
 */
export function CompactAgentRowHover({
  agentType,
  dotState,
  primary,
  secondary,
  secondaryIsAssistantMessage,
  model,
  shortTime,
  hideIdentityIcon,
  subagents,
  children
}: CompactAgentRowHoverProps): React.JSX.Element {
  const cardFacts = useWorktreeHoverFacts()
  // Why: the markdown chunk is lazy, so a cold first hover would show the raw
  // asterisks the card exists to render. Warm it while the row is on screen.
  React.useEffect(() => {
    if (secondaryIsAssistantMessage) {
      preloadCommentMarkdown()
    }
  }, [secondaryIsAssistantMessage])

  return (
    <HoverCard openDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-80"
        {...{ [WORKTREE_NATIVE_CONTEXT_MENU_ATTR]: '' }}
        // Why: the card is portaled but still bubbles into the worktree card, which would
        // activate the workspace or start a drag.
        onClick={stopRowActivation}
        onDoubleClick={stopRowActivation}
        onMouseDown={stopRowActivation}
        onPointerDown={stopRowActivation}
      >
        <SelectedTextCopyMenu className="scrollbar-sleek-parent max-h-[24rem] overflow-y-auto text-xs scrollbar-sleek">
          <WorktreeHoverCardBody
            facts={cardFacts ?? SESSION_ONLY_FACTS}
            workspaceSlot={
              cardFacts?.worktreeId ? (
                <WorktreeHoverWorkspaceChips
                  worktreeId={cardFacts.worktreeId}
                  workspaceStatusId={cardFacts.workspaceStatusId}
                />
              ) : undefined
            }
            session={{
              agentType,
              dotState,
              primary,
              body: secondary,
              bodyIsMarkdown: secondaryIsAssistantMessage,
              model,
              timeAgo: shortTime,
              hideAgentIcon: hideIdentityIcon,
              subagents
            }}
          />
        </SelectedTextCopyMenu>
      </HoverCardContent>
    </HoverCard>
  )
}
