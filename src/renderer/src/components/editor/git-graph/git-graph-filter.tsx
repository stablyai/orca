import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { getRuntimeGitRefs } from '@/runtime/runtime-git-status-client'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { GIT_HISTORY_REFS_CAPABILITY } from '../../../../../shared/source-control/runtime/git-graph-capabilities'
import { gitGraphScope } from '@/lib/git-graph-tab'
import { getConnectionId } from '@/lib/connection-context'
import { translate } from '@/i18n/i18n'
import type {
  GitHistoryItemRef,
  GitHistoryRefs
} from '../../../../../shared/git/history/git-history-types'

export function GitGraphFilter({
  worktreeId,
  filter,
  supported,
  onChange
}: {
  worktreeId: string
  filter: GitHistoryRefs
  supported: boolean | undefined
  onChange: (refs: GitHistoryRefs) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [refs, setRefs] = useState<GitHistoryItemRef[]>([])
  const [probe, setProbe] = useState<{ owner: string | undefined; capable: boolean | null }>()
  const [error, setError] = useState<string>()
  const owner = JSON.stringify(gitGraphScope(worktreeId)?.route)
  const capable = probe?.owner === owner ? probe?.capable : null
  useEffect(() => {
    let live = true
    setProbe({ owner, capable: null })
    const scope = gitGraphScope(worktreeId)
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
  }, [worktreeId, owner])
  useEffect(() => {
    if (!open || !capable) {
      return
    }
    let live = true
    const scope = gitGraphScope(worktreeId)
    if (scope) {
      void getRuntimeGitRefs(
        {
          target: scope.target,
          worktreeId,
          worktreePath: scope.worktree.path,
          connectionId: getConnectionId(worktreeId) ?? undefined
        },
        query
      )
        .then((rows) => {
          if (live) {
            setRefs(rows)
            setError(undefined)
          }
        })
        .catch((cause) => {
          if (live) {
            setError(String(cause))
          }
        })
    }
    return () => {
      live = false
    }
  }, [worktreeId, owner, query, open, capable])
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" disabled={!supported || capable !== true}>
            {supported === false || filter === 'head'
              ? translate('gitGraph.currentBranch', 'Current branch')
              : filter === 'all'
                ? translate('gitGraph.allBranches', 'All branches')
                : translate('gitGraph.chosenBranches', 'Chosen branches')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 space-y-2" align="start">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange('all')
                setOpen(false)
              }}
            >
              {translate('gitGraph.allBranches', 'All branches')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange('head')
                setOpen(false)
              }}
            >
              {translate('gitGraph.currentBranch', 'Current branch')}
            </Button>
          </div>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate('gitGraph.searchRefs', 'Search branches and tags')}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="max-h-72 overflow-auto scrollbar-sleek">
            {refs.map((ref) => (
              <label
                key={ref.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
              >
                <Checkbox
                  checked={Array.isArray(filter) && filter.includes(ref.id)}
                  onCheckedChange={(checked) => {
                    const chosen = Array.isArray(filter) ? filter : []
                    onChange(checked ? [...chosen, ref.id] : chosen.filter((id) => id !== ref.id))
                  }}
                />
                <span className="truncate">{ref.name}</span>
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {capable === false || (supported === false && capable === true) ? (
        <span className="text-xs text-muted-foreground">
          {translate(
            'gitGraph.oldServer',
            "This server's Orca version shows only the current branch"
          )}
        </span>
      ) : null}
    </div>
  )
}
