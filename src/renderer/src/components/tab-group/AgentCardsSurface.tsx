import { useMemo } from 'react'
import { useAppStore } from '../../store'
import { AgentCard } from './AgentCard'
import {
  parseTiledPaneAttentionKey,
  resolveTiledMaximizedGroupId,
  selectTiledPaneAttentionKey
} from './tiled-pane-attention'

export function AgentCardsSurface({
  worktreeId,
  groupId: _groupId
}: {
  worktreeId: string
  groupId: string
}): React.JSX.Element {
  const slotsKey = useAppStore((state) => {
    const ids = state.agentCardGroupIdsByWorktree[worktreeId] ?? []
    const groups = state.groupsByWorktree[worktreeId] ?? []
    return ids
      .map((id) => `${id}:${groups.find((group) => group.id === id)?.activeTabId ?? ''}`)
      .join(',')
  })
  const maximizedGroupId = useAppStore((state) => resolveTiledMaximizedGroupId(state, worktreeId))
  const attentionKey = useAppStore((state) => selectTiledPaneAttentionKey(state, worktreeId))
  const frameStateByGroupId = useMemo(
    () => parseTiledPaneAttentionKey(attentionKey),
    [attentionKey]
  )
  const slots = useMemo(() => {
    if (slotsKey.length === 0) {
      return []
    }
    return slotsKey.split(',').flatMap((pair) => {
      const sep = pair.indexOf(':')
      const cardGroupId = sep === -1 ? pair : pair.slice(0, sep)
      const tabId = sep === -1 ? '' : pair.slice(sep + 1)
      return tabId.length > 0 ? [{ cardGroupId, tabId }] : []
    })
  }, [slotsKey])

  const renderCard = (cardGroupId: string, tabId: string): React.JSX.Element => {
    const frameState = frameStateByGroupId.get(cardGroupId)
    return (
      <AgentCard
        worktreeId={worktreeId}
        cardGroupId={cardGroupId}
        tabId={tabId}
        isMaximized={maximizedGroupId === cardGroupId}
        frameTone={frameStateByGroupId.size > 0 ? (frameState ?? 'plain') : undefined}
      />
    )
  }

  const cardGroupIds = slots.map((slot) => slot.cardGroupId)
  if (maximizedGroupId !== undefined && cardGroupIds.includes(maximizedGroupId)) {
    return (
      <div
        data-orca-agent-cards={worktreeId}
        className="absolute inset-0 min-h-0 min-w-0 overflow-hidden"
      >
        <div className="flex h-full w-full min-h-0 min-w-0 overflow-hidden">
          {slots.map(({ cardGroupId, tabId }) =>
            cardGroupId === maximizedGroupId ? (
              <div
                key={cardGroupId}
                data-orca-agent-card={cardGroupId}
                className="flex h-full w-full min-h-0 min-w-0 overflow-hidden"
              >
                {renderCard(cardGroupId, tabId)}
              </div>
            ) : (
              // Why zero-size, not visibility:hidden or display:none: collapses the sibling's
              // anchor body to 0x0 so anchor-size() collapses its live overlay too, without the
              // corrupted xterm fit a display:none rect would cause. inert is what takes the
              // zero-size card's controls out of the tab order; overflow-hidden does not.
              <div
                key={cardGroupId}
                data-orca-agent-card={cardGroupId}
                className="h-0 w-0 overflow-hidden pointer-events-none"
                aria-hidden={true}
                inert={true}
              >
                {renderCard(cardGroupId, tabId)}
              </div>
            )
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      data-orca-agent-cards={worktreeId}
      className="absolute inset-0 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden scrollbar-sleek"
    >
      {/* Why min(): a split pane narrower than the track floor would otherwise clip each card's
          right edge, including its header controls, behind the pane's hidden horizontal overflow. */}
      <div className="grid min-h-full box-border grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))] auto-rows-[minmax(300px,1fr)] content-start gap-3 p-3">
        {slots.map(({ cardGroupId, tabId }) => (
          <div
            key={cardGroupId}
            data-orca-agent-card={cardGroupId}
            className="flex min-h-0 min-w-0 overflow-hidden"
          >
            {renderCard(cardGroupId, tabId)}
          </div>
        ))}
      </div>
    </div>
  )
}
