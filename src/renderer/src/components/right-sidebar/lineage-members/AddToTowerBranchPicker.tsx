import React, { useEffect, useMemo, useState } from 'react'
import { Check, FolderGit2, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isFolderRepo } from '../../../../../shared/repo-kind'

export type PickedBranch = { repoId: string; branch: string }

const SEARCH_LIMIT = 50
const SEARCH_DELAY_MS = 150

type BranchResults = { query: string; branches: string[] }

function RepoList({ onPick }: { onPick: (repoId: string) => void }): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const gitRepos = useMemo(() => repos.filter((repo) => !isFolderRepo(repo)), [repos])
  return (
    <Command>
      <CommandInput
        autoFocus
        placeholder={translate(
          'auto.components.rightSidebar.lineageMembers.addToTower.searchRepositories',
          'Search repositories…'
        )}
      />
      <CommandList className="max-h-56">
        <CommandEmpty>
          {translate(
            'auto.components.rightSidebar.lineageMembers.addToTower.noRepositories',
            'No repositories found'
          )}
        </CommandEmpty>
        {gitRepos.map((repo) => (
          <CommandItem
            key={repo.id}
            value={repo.id}
            keywords={[repo.displayName]}
            onSelect={() => onPick(repo.id)}
          >
            <FolderGit2 className="size-3.5" />
            <span className="min-w-0 truncate">{repo.displayName}</span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}

function BranchList({
  repoId,
  value,
  onChange
}: {
  repoId: string
  value: string | null
  onChange: (branch: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<BranchResults | null>(null)

  useEffect(() => {
    let stale = false
    const timer = setTimeout(() => {
      // why: the same host that owns lineage IPC lists the branches, so main can match them to worktrees
      void window.api.repos
        .searchBaseRefDetails({ repoId, query, limit: SEARCH_LIMIT })
        .then((refs) => {
          if (!stale) {
            const branches = [...new Set(refs.map((ref) => ref.localBranchName).filter(Boolean))]
            setResults({ query, branches })
          }
        })
        .catch(() => {
          if (!stale) {
            setResults({ query, branches: [] })
          }
        })
    }, SEARCH_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, repoId])

  const searching = results?.query !== query
  return (
    <Command shouldFilter={false}>
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder={translate(
          'auto.components.rightSidebar.lineageMembers.addToTower.searchBranches',
          'Search branches…'
        )}
      />
      <CommandList className="max-h-56">
        {results && results.branches.length === 0 && !searching ? (
          <CommandEmpty>
            {translate(
              'auto.components.rightSidebar.lineageMembers.addToTower.noBranches',
              'No branches found'
            )}
          </CommandEmpty>
        ) : null}
        {(results?.branches ?? []).map((branch) => (
          <CommandItem key={branch} value={branch} onSelect={() => onChange(branch)}>
            {value === branch ? <Check className="size-3.5" /> : <GitBranch className="size-3.5" />}
            <span className="min-w-0 truncate">{branch}</span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}

/** Repository first, then one of its branches as the host lists them; no free-typed names. */
export function AddToTowerBranchPicker({
  value,
  onChange
}: {
  value: PickedBranch | null
  onChange: (picked: PickedBranch | null) => void
}): React.JSX.Element {
  const [repoId, setRepoId] = useState<string | null>(value?.repoId ?? null)
  const repoName = useAppStore((s) => s.repos.find((repo) => repo.id === repoId)?.displayName)
  return (
    <div className="overflow-hidden rounded-md border border-border">
      {repoId ? (
        <>
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs">
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium">{repoName ?? repoId}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setRepoId(null)
                onChange(null)
              }}
            >
              {translate(
                'auto.components.rightSidebar.lineageMembers.addToTower.changeRepository',
                'Change repository'
              )}
            </Button>
          </div>
          <BranchList
            key={repoId}
            repoId={repoId}
            value={value?.repoId === repoId ? value.branch : null}
            onChange={(branch) => onChange({ repoId, branch })}
          />
        </>
      ) : (
        <RepoList onPick={setRepoId} />
      )}
    </div>
  )
}
