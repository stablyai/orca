import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { getRuntimeGitRefs } from '@/runtime/source-control/git/runtime-git-status-client'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { GIT_HISTORY_REFS_CAPABILITY } from '../../../../../shared/source-control/runtime/git-graph-capabilities'
import { gitGraphScope, useGitGraphScope } from '@/lib/git-graph-tab'
import { useTranslate } from '@/i18n/use-translate'
import type {
  GitHistoryItemRef,
  GitHistoryRefs
} from '../../../../../shared/git/history/git-history-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'

type GitGraphFilterProps = {
  worktreeId: string
  executionHostId?: ExecutionHostId
  filter: GitHistoryRefs
  supported: boolean | undefined
  onChange: (refs: GitHistoryRefs) => void
}
type RefRequests = { running: boolean; pending?: () => Promise<void> }

export function GitGraphFilter(props: GitGraphFilterProps) {
  const requests = useRef<RefRequests>({ running: false })
  const scope = useGitGraphScope(props.worktreeId, props.executionHostId)
  const owner = JSON.stringify([props.worktreeId, scope?.route, scope?.worktree.path])
  return <GitGraphFilterForOwner key={owner} {...props} owner={owner} requests={requests} />
}

function GitGraphFilterForOwner({
  worktreeId,
  executionHostId,
  filter,
  supported,
  onChange,
  owner,
  requests
}: GitGraphFilterProps & { owner: string; requests: RefObject<RefRequests> }) {
  const t = useTranslate()
  const [draft, setDraft] = useState<GitHistoryRefs>()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<{
    owner: string
    query: string
    refs?: GitHistoryItemRef[]
    error?: string
  }>()
  const [probe, setProbe] = useState<{ owner: string | undefined; capable: boolean | null }>()
  const pickerOpen = draft !== undefined
  const draftRefs = draft ?? filter
  const refs =
    pickerOpen && search?.owner === owner && search.query === query ? (search.refs ?? []) : []
  const error =
    pickerOpen && search?.owner === owner && search.query === query ? search.error : undefined
  const chosen = useMemo(() => new Set(Array.isArray(draftRefs) ? draftRefs : []), [draftRefs])
  const capable = probe?.owner === owner ? probe?.capable : null
  useEffect(() => {
    let live = true
    setProbe({ owner, capable: null })
    const scope = gitGraphScope(worktreeId, undefined, executionHostId)
    if (scope) {
      void (
        scope.target.kind === 'local'
          ? Promise.resolve(true)
          : runtimeEnvironmentSupportsCapability(
              scope.target.environmentId,
              GIT_HISTORY_REFS_CAPABILITY
            )
      )
        .then((value) => {
          if (live) {
            setProbe({ owner, capable: value })
          }
        })
        .catch(() => {})
    }
    return () => {
      live = false
    }
  }, [worktreeId, owner, executionHostId])
  useEffect(() => {
    if (!pickerOpen || !capable) {
      return
    }
    let live = true
    const queue = requests.current
    const drain = async () => {
      if (queue.running) {
        return
      }
      queue.running = true
      try {
        while (queue.pending) {
          const next = queue.pending
          queue.pending = undefined
          await next()
        }
      } finally {
        queue.running = false
      }
    }
    const timeout = setTimeout(() => {
      queue.pending = async () => {
        const scope = gitGraphScope(worktreeId, undefined, executionHostId)
        if (!live || !scope) {
          return
        }
        try {
          const rows = await getRuntimeGitRefs(
            {
              target: scope.target,
              worktreeId,
              worktreePath: scope.worktree.path,
              connectionId: scope.connectionId ?? undefined
            },
            query
          )
          if (live) {
            setSearch({ owner, query, refs: rows })
          }
        } catch (cause) {
          if (live) {
            setSearch({ owner, query, error: String(cause) })
          }
        }
      }
      void drain()
    }, 150)
    return () => {
      live = false
      queue.pending = undefined
      clearTimeout(timeout)
    }
  }, [worktreeId, owner, query, pickerOpen, capable, executionHostId, requests])
  const apply = (refs = draftRefs) => {
    const next = Array.isArray(refs) && !refs.length ? 'all' : refs
    if (draft !== undefined && JSON.stringify(next) !== JSON.stringify(filter)) {
      onChange(next)
    }
    setDraft(undefined)
    setSearch(undefined)
  }
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Popover
        open={pickerOpen}
        onOpenChange={(next) => {
          if (next) {
            setDraft(filter)
          } else {
            apply()
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" disabled={!supported || capable !== true}>
            {supported === false || filter === 'head'
              ? t('gitGraph.currentBranch', 'Current branch')
              : filter === 'all'
                ? t('gitGraph.allBranches', 'All branches')
                : t('gitGraph.chosenBranches', 'Chosen branches')}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-80"
          align="start"
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            setDraft(undefined)
            setSearch(undefined)
          }}
        >
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => apply('all')}>
                {t('gitGraph.allBranches', 'All branches')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => apply('head')}>
                {t('gitGraph.currentBranch', 'Current branch')}
              </Button>
            </div>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('gitGraph.searchRefs', 'Search branches and tags')}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="max-h-72 overflow-auto scrollbar-sleek">
              {refs.map((ref) => (
                <label
                  key={ref.id}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
                >
                  <Checkbox
                    checked={chosen.has(ref.id)}
                    onCheckedChange={(checked) => {
                      const next = new Set(chosen)
                      if (checked) {
                        next.add(ref.id)
                      } else {
                        next.delete(ref.id)
                      }
                      setDraft([...next].sort())
                    }}
                  />
                  <span className="truncate">{ref.name}</span>
                </label>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {capable === false || (supported === false && capable === true) ? (
        <span className="text-xs text-muted-foreground">
          {t('gitGraph.oldServer', "This server's Orca version shows only the current branch")}
        </span>
      ) : null}
    </div>
  )
}
