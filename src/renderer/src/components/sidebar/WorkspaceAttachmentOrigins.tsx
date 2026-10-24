import React from 'react'
import { Terminal } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { resolveNotificationTabOwner } from '@/attention/notification-subject-owner'
import { terminalLayoutContainsLeaf } from '../../../../shared/workspace-session-pane-ownership'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import type { Tab } from '../../../../shared/tab-types'
import { getWorkspaceAttachmentOriginKey } from '../../../../shared/workspace-attachment-origins'

const EMPTY_TABS: Tab[] = []

function useReferenceTabs(workspace: Worktree): Tab[] {
  const tabs = useAppStore((s) => s.unifiedTabsByWorktree?.[workspace.id] ?? EMPTY_TABS)
  const state = useAppStore.getState()
  return tabs.filter((tab) => {
    if (tab.contentType !== 'terminal' && tab.contentType !== 'agent-session') {
      return false
    }
    const owner = resolveNotificationTabOwner(state, tab)
    return owner !== null && owner.executionHostId === (workspace.hostId ?? 'local')
  })
}

function focusOrigin(workspace: Worktree, tab: Tab, paneKey: string | undefined): void {
  const state = useAppStore.getState()
  if (!state.setActiveWorktree(workspace.id, workspace.hostId)) {
    return
  }
  state.activateTab(tab.id, { worktreeId: workspace.id })
  const pane = paneKey ? parsePaneKey(paneKey) : null
  if (
    tab.contentType === 'terminal' &&
    pane &&
    pane.tabId === tab.entityId &&
    state.tabsByWorktree[workspace.id]?.some((entry) => entry.id === tab.entityId) &&
    terminalLayoutContainsLeaf(state.terminalLayoutsByTabId[tab.entityId]?.root, pane.leafId)
  ) {
    activateTabAndFocusPane(tab.entityId, pane.leafId)
  }
}

export function WorkspaceAttachmentOrigins({
  item,
  workspace,
  compact = false
}: {
  item: WorkspaceAttachment
  workspace: Worktree
  compact?: boolean
}): React.JSX.Element | null {
  const tabs = useReferenceTabs(workspace)
  const origins = item.origins?.filter((origin) => origin.kind === 'observed') ?? []
  if (!origins.length) {
    return null
  }
  return (
    <div
      className={compact ? 'flex shrink-0 items-center' : 'flex flex-wrap items-center gap-1 pl-5'}
    >
      {origins.map((origin) => {
        const tab = tabs.find(
          (candidate) =>
            candidate.id === origin.tabId &&
            (origin.hostId ?? 'local') === (workspace.hostId ?? 'local')
        )
        const label =
          tab?.customLabel ||
          tab?.label ||
          origin.label ||
          origin.agent ||
          translate('workspace.links.terminal', 'Terminal')
        const description = translate('workspace.links.seenIn', 'Seen in {{label}}', { label })
        if (compact) {
          const unavailable = translate('workspace.links.unavailableTab', 'Tab unavailable')
          return (
            <Tooltip key={getWorkspaceAttachmentOriginKey(origin)}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-4"
                  aria-disabled={!tab || undefined}
                  aria-label={tab ? description : `${description} · ${unavailable}`}
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (tab) {
                      focusOrigin(workspace, tab, origin.paneKey)
                    }
                  }}
                >
                  <Terminal className="size-3 text-muted-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {tab ? description : `${description} · ${unavailable}`}
              </TooltipContent>
            </Tooltip>
          )
        }
        return tab ? (
          <Button
            key={getWorkspaceAttachmentOriginKey(origin)}
            type="button"
            variant="ghost"
            size="xs"
            title={origin.sessionId ? `${description} · ${origin.sessionId}` : description}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
                event.stopPropagation()
              }
            }}
            onClick={(event) => {
              event.stopPropagation()
              focusOrigin(workspace, tab, origin.paneKey)
            }}
          >
            {description}
          </Button>
        ) : (
          <span
            key={getWorkspaceAttachmentOriginKey(origin)}
            className="text-[11px] text-muted-foreground"
            title={origin.sessionId}
          >
            {description} · {translate('workspace.links.unavailableTab', 'Tab unavailable')}
          </span>
        )
      })}
    </div>
  )
}
