import { useMemo, useState } from 'react'
import { ExternalLink, LoaderCircle, RotateCcw, X } from 'lucide-react'
import NativeChatView from '@/components/native-chat/NativeChatView'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { translate } from '@/i18n/i18n'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { startIssueDraftChat } from '@/lib/issue-draft-agent-launch'
import { cn } from '@/lib/utils'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import { splitGitRemoteKey } from '../../../../../shared/git-remote-identity'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import {
  buildIssueDraftAgentPrompt,
  type IssueDraftAgentPromptItem
} from '../../../../../shared/issue-draft-agent-prompt'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import { useIssueDraftPanelStore } from './issue-draft-panel-store'

const PANEL_DEFAULT_WIDTH = 440
const PANEL_MIN_WIDTH = 320
const PANEL_MAX_WIDTH = 760

function toPromptItem(item: GitHubWorkItem): IssueDraftAgentPromptItem {
  return {
    kind: item.type,
    number: item.number,
    title: item.title,
    state: item.state,
    url: item.url,
    labels: item.labels
  }
}

function repositoryLabel(repo: Repo, items: readonly GitHubWorkItem[]): string {
  // Why: listed issue URLs name the issue source (origin or fork upstream) that New issue files to.
  const listed = items.find((item) => item.repoId === repo.id && item.type === 'issue')
  const slug = listed ? parseGitHubIssueOrPRLink(listed.url)?.slug : null
  if (slug) {
    return `${slug.owner}/${slug.repo}`
  }
  return (
    splitGitRemoteKey(repo.gitRemoteIdentity?.canonicalKey, (host) => host)?.tail ??
    repo.displayName
  )
}

/** Right-hand Tasks panel: a chat in the primary checkout that drafts and files new issues. */
export function TaskPageIssueDraftPanel({
  repo,
  items,
  query
}: {
  repo: Repo
  items: readonly GitHubWorkItem[]
  query: string
}): React.JSX.Element {
  const setOpen = useIssueDraftPanelStore((s) => s.setOpen)
  const chat = useIssueDraftPanelStore((s) => s.chatByRepoId[repo.id] ?? null)
  const setChat = useIssueDraftPanelStore((s) => s.setChat)
  // Why: closing the chat's tab in the workspace ends the conversation, so the panel starts over.
  const tab = useAppStore((s) =>
    chat
      ? ((s.unifiedTabsByWorktree[chat.worktreeId] ?? []).find((t) => t.id === chat.tabId) ?? null)
      : null
  )
  const owner = useAppStore((s) => (tab ? structuredAgentSessionOwnerForTab(s, tab) : null))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  const [includeList, setIncludeList] = useState(true)
  const [starting, setStarting] = useState(false)
  const [width, setWidth] = useState(PANEL_DEFAULT_WIDTH)
  const { containerRef, isResizing, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width,
    minWidth: PANEL_MIN_WIDTH,
    maxWidth: PANEL_MAX_WIDTH,
    deltaSign: -1,
    setWidth
  })

  const start = async (): Promise<void> => {
    setStarting(true)
    try {
      const started = await startIssueDraftChat({
        repoId: repo.id,
        prompt: buildIssueDraftAgentPrompt({
          repositoryLabel: repositoryLabel(repo, items),
          query: query.trim() || null,
          existingItems: includeList ? items.map(toPromptItem) : []
        })
      })
      if (started) {
        setChat(repo.id, started)
      }
    } finally {
      setStarting(false)
    }
  }
  const startAndLog = (): void => {
    start().catch((error) => console.error('issue draft chat failed to start', error))
  }

  const conversation =
    chat && tab?.agentSessionAgent && target ? (
      <NativeChatView
        mode="structured"
        tabId={chat.tabId}
        sessionId={chat.sessionId}
        agent={tab.agentSessionAgent}
        target={target}
        isVisible
        isFocusedGroup
      />
    ) : null

  return (
    <aside
      ref={containerRef}
      style={{ width }}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-border/60 bg-background"
      aria-label={translate('auto.components.TaskPage.issueDraftPanel.title', 'Draft issues')}
    >
      <div
        role="separator"
        aria-label={translate(
          'auto.components.TaskPage.issueDraftPanel.resize',
          'Resize issue drafting panel'
        )}
        onMouseDown={onResizeStart}
        className={cn(
          'group absolute -left-1.5 top-0 z-20 flex h-full w-3 cursor-col-resize justify-center',
          isResizing && 'bg-ring/10'
        )}
      >
        <div
          className={cn(
            'h-full w-px bg-transparent transition-colors group-hover:bg-ring/50',
            isResizing && 'bg-ring'
          )}
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {translate('auto.components.TaskPage.issueDraftPanel.title', 'Draft issues')}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {translate(
              'auto.components.TaskPage.issueDraftPanel.runsIn',
              '{{project}} · primary checkout',
              { project: repo.displayName }
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {conversation && chat ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => {
                      activateStructuredAgentSessionTab({
                        worktreeId: chat.worktreeId,
                        tabId: chat.tabId,
                        ...(target ? { target } : {})
                      })
                    }}
                    aria-label={translate(
                      'auto.components.TaskPage.issueDraftPanel.openInWorkspace',
                      'Open in workspace'
                    )}
                  >
                    <ExternalLink className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate(
                    'auto.components.TaskPage.issueDraftPanel.openInWorkspace',
                    'Open in workspace'
                  )}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setChat(repo.id, null)}
                    aria-label={translate(
                      'auto.components.TaskPage.issueDraftPanel.newConversation',
                      'New conversation'
                    )}
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate(
                    'auto.components.TaskPage.issueDraftPanel.newConversation',
                    'New conversation'
                  )}
                </TooltipContent>
              </Tooltip>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setOpen(false)}
            aria-label={translate('auto.components.TaskPage.b6795e65fd', 'Close')}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      {conversation ? (
        <div className="relative min-h-0 flex-1">{conversation}</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-4 px-5">
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.TaskPage.issueDraftPanel.intro',
              'Talk through new issues with your default agent. It checks for duplicates, drafts the issue with you, and files it only when you tell it to.'
            )}
          </p>
          <div className="flex items-center gap-2">
            <Checkbox
              id="task-page-issue-draft-include-list"
              checked={includeList}
              onCheckedChange={(checked) => setIncludeList(checked === true)}
            />
            <Label htmlFor="task-page-issue-draft-include-list">
              {translate(
                'auto.components.TaskPage.issueDraftPanel.includeList',
                'Share the {{total}} items shown to check for duplicates',
                { total: items.length }
              )}
            </Label>
          </div>
          <Button onClick={startAndLog} disabled={starting} className="self-start">
            {starting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {translate('auto.components.TaskPage.issueDraftPanel.start', 'Start conversation')}
          </Button>
        </div>
      )}
    </aside>
  )
}
