import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Copy, MessageSquareText, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useActiveWorktree, useActiveWorktreeId, useAllWorktrees } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { AI_VAULT_AGENT_LABELS, type AiVaultAgent } from '../../../../shared/ai-vault-types'
import { deriveAiVaultWorkspaceScopePaths } from './ai-vault-scope-paths'
import { isAiVaultSessionInWorkspacePath } from './ai-vault-session-filters'
import { useAiVaultExecutionHostScope } from './ai-vault-host-scope'
import { useAiVaultSessionRefresh } from './ai-vault-session-refresh'
import { SessionTime } from './AiVaultSessionDetails'

// Bound the DOM: even with the 500-session scan cap × up to 40 prompts each, we
// only ever render the most recent slice (search narrows further).
const MAX_VISIBLE_PROMPTS = 500

type PromptHistoryRow = {
  key: string
  text: string
  agent: AiVaultAgent
  sessionTitle: string
  cwd: string | null
  timestamp: string | null
  sortMs: number
}

export default function PromptHistoryPanel(): React.JSX.Element {
  const activeWorktreeId = useActiveWorktreeId()
  const activeWorktree = useActiveWorktree()
  const allWorktrees = useAllWorktrees()
  const resumeTargetState = useAppStore(
    useShallow((state) => ({
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'workspace' | 'all'>('workspace')

  // Match the AI Vault: scope to the active worktree's execution host (so an SSH
  // worktree scans its remote sessions instead of showing an empty local list).
  const { executionHostScope } = useAiVaultExecutionHostScope({
    activeWorktreeId: activeWorktreeId ?? null,
    resumeTargetState
  })
  // Active worktree paths (incl. prior same-repo worktrees). Sent to the scanner
  // so scoped views surface in-scope sessions older than the global recency cap.
  const workspaceScopePaths = useMemo(
    () => deriveAiVaultWorkspaceScopePaths(activeWorktree ?? null, allWorktrees),
    [activeWorktree, allWorktrees]
  )

  const { error, loading, refresh, sessions } = useAiVaultSessionRefresh(
    workspaceScopePaths,
    executionHostScope
  )

  const rows = useMemo<PromptHistoryRow[]>(() => {
    const collected: PromptHistoryRow[] = []
    for (const session of sessions) {
      const sessionTime = session.updatedAt ?? session.modifiedAt
      for (const [index, prompt] of (session.userPrompts ?? []).entries()) {
        const timestamp = prompt.timestamp ?? sessionTime
        collected.push({
          key: `${session.id}:${index}`,
          text: prompt.text,
          agent: session.agent,
          sessionTitle: session.title,
          cwd: session.cwd,
          timestamp,
          sortMs: timestamp ? Date.parse(timestamp) : 0
        })
      }
    }
    collected.sort((left, right) => (right.sortMs || 0) - (left.sortMs || 0))
    return collected
  }, [sessions])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const out: PromptHistoryRow[] = []
    for (const row of rows) {
      if (scope === 'workspace') {
        // Fail closed: with no workspace paths (no active worktree) show nothing
        // rather than every workspace's prompts.
        if (
          !workspaceScopePaths.some((path) => isAiVaultSessionInWorkspacePath(path, row.cwd ?? ''))
        ) {
          continue
        }
      }
      if (needle && !row.text.toLowerCase().includes(needle)) {
        continue
      }
      out.push(row)
      if (out.length >= MAX_VISIBLE_PROMPTS) {
        break
      }
    }
    return out
  }, [rows, query, scope, workspaceScopePaths])

  const copyPrompt = (text: string): void => {
    void window.api.ui
      .writeClipboardText(text)
      .then(() => {
        toast.success(
          translate('auto.components.right.sidebar.PromptHistoryPanel.copied', 'Prompt copied')
        )
      })
      .catch(() => {
        toast.error(
          translate(
            'auto.components.right.sidebar.PromptHistoryPanel.copyFailed',
            'Could not copy the prompt'
          )
        )
      })
  }

  const isInitialLoading = loading && rows.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate(
              'auto.components.right.sidebar.PromptHistoryPanel.searchPlaceholder',
              'Search prompts…'
            )}
            className="h-7 pl-7 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          {(['workspace', 'all'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={scope === value ? 'secondary' : 'ghost'}
              onClick={() => setScope(value)}
            >
              {value === 'workspace'
                ? translate(
                    'auto.components.right.sidebar.PromptHistoryPanel.scopeWorkspace',
                    'This workspace'
                  )
                : translate('auto.components.right.sidebar.PromptHistoryPanel.scopeAll', 'All')}
            </Button>
          ))}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="ml-auto"
            aria-label={translate(
              'auto.components.right.sidebar.PromptHistoryPanel.refresh',
              'Refresh'
            )}
            onClick={() => void refresh({ force: true })}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {error ? (
          <p className="p-3 text-xs text-destructive">{error}</p>
        ) : isInitialLoading ? (
          <p className="p-3 text-xs text-muted-foreground">
            {translate('auto.components.right.sidebar.PromptHistoryPanel.loading', 'Loading…')}
          </p>
        ) : filtered.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.PromptHistoryPanel.empty',
              'No prompts found for this scope yet.'
            )}
          </p>
        ) : (
          <ul className="flex flex-col">
            {filtered.map((row) => (
              <li
                key={row.key}
                className="group flex flex-col gap-1 border-b border-border/60 px-3 py-2 hover:bg-accent/40"
              >
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium">{AI_VAULT_AGENT_LABELS[row.agent]}</span>
                  <span>·</span>
                  <SessionTime value={row.timestamp ?? ''} />
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="ml-auto opacity-0 group-hover:opacity-100"
                    aria-label={translate(
                      'auto.components.right.sidebar.PromptHistoryPanel.copy',
                      'Copy prompt'
                    )}
                    onClick={() => copyPrompt(row.text)}
                  >
                    <Copy className="size-3" />
                  </Button>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-foreground">
                  {row.text}
                </p>
                <span className="truncate text-[11px] text-muted-foreground">
                  {row.sessionTitle}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <MessageSquareText className="size-3" />
        <span>{filtered.length}</span>
      </div>
    </div>
  )
}
