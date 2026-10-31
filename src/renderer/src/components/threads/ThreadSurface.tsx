import { useEffect, useMemo } from 'react'
import { X } from 'lucide-react'
import { useAppStore } from '@/store'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { translate } from '@/i18n/i18n'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import NativeChatView from '../native-chat/NativeChatView'
import { useStructuredSessionSummaries } from '../native-chat/structured-session-summary-store'
import { RepoIconGlyph } from '../repo/repo-icon'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { NewThread } from './NewThread'
import { clearThreadSelection, useThreadNavigation } from './thread-navigation'
import { threadProjectForLocation } from './thread-projects'

export function useThreadSurfaceActive(): boolean {
  const enabled = useAppStore((s) => s.settings?.experimentalThreads === true)
  const activeView = useAppStore((s) => s.activeView)
  const selected = useThreadNavigation((s) => s.selection)
  useEffect(() => {
    if (!enabled || activeView !== 'terminal') {
      clearThreadSelection()
    }
  }, [enabled, activeView])
  return enabled && activeView === 'terminal' && selected !== null
}

export function ThreadSurface({
  reserveCollapsedSidebarHeaderSpace = false
}: {
  reserveCollapsedSidebarHeaderSpace?: boolean
}): React.JSX.Element | null {
  useUiLanguageRevision()
  const selected = useThreadNavigation((s) => s.selection)
  const tab = useAppStore((s) => (selected?.kind === 'thread' ? s.getTab(selected.tabId) : null))
  const summary = useStructuredSessionSummaries((s) => (tab ? s.byTabId.get(tab.id) : undefined))
  const owner = useAppStore((s) => (tab ? structuredAgentSessionOwnerForTab(s, tab) : null))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  const repo = useAppStore((s) =>
    tab && owner
      ? threadProjectForLocation(s, { workspaceId: tab.worktreeId, executionHostId: owner })
      : null
  )
  useEffect(() => {
    if (selected?.kind === 'thread' && !tab) {
      clearThreadSelection()
    }
  }, [selected, tab])
  if (selected?.kind === 'new') {
    return (
      <NewThread
        key={selected.draftId}
        projectKey={selected.projectKey}
        draftId={selected.draftId}
      />
    )
  }
  if (!tab || !target || tab.contentType !== 'agent-session' || !tab.agentSessionAgent) {
    return null
  }
  const title = summary?.conversationName || summary?.latestPrompt || tab.label
  const close = translate('threads.close', 'Close thread')
  return (
    <div className="absolute inset-0 flex min-h-0 flex-col bg-background">
      <div className="titlebar flex h-9 shrink-0 items-center border-b border-border px-2">
        {reserveCollapsedSidebarHeaderSpace ? (
          <div className="h-full w-(--collapsed-sidebar-header-width) shrink-0" />
        ) : null}
        <div className="flex h-full max-w-72 items-center gap-2 border-x border-border bg-background px-3 text-xs [-webkit-app-region:no-drag]">
          <AgentTypeIcon agentType={tab.agentSessionAgent} size={14} />
          <span className="truncate">{title}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={close}
                onClick={() =>
                  dispatchWorkspaceTabCommand({
                    type: 'close',
                    target: { kind: 'tab', worktreeId: tab.worktreeId, tabId: tab.id }
                  })
                }
              >
                <X className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{close}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {repo ? (
        <div className="flex items-center gap-1.5 px-6 py-2 text-xs text-muted-foreground">
          <RepoIconGlyph repoIcon={repo.repoIcon} className="size-3" />
          {repo.displayName}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <NativeChatView
          key={tab.id}
          mode="structured"
          tabId={tab.id}
          groupId={tab.groupId}
          sessionId={tab.entityId}
          agent={tab.agentSessionAgent}
          target={target}
          isVisible
          isFocusedGroup
        />
      </div>
    </div>
  )
}
