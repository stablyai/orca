import React, { useMemo } from 'react'
import { Check } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isFolderRepo } from '../../../../../shared/repo-kind'
import type { Worktree } from '../../../../../shared/worktree/types'

export type PickedWorktree = { repoId: string; worktreePath: string }

export function worktreeBranchLabel(worktree: Pick<Worktree, 'branch'>): string {
  return worktree.branch.replace(/^refs\/heads\//, '')
}

/** Every worktree the store knows, grouped by its git repository; folder projects have none. */
export function AddToTowerWorktreePicker({
  value,
  onChange
}: {
  value: PickedWorktree | null
  onChange: (picked: PickedWorktree) => void
}): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const groups = useMemo(
    () =>
      repos
        .filter((repo) => !isFolderRepo(repo))
        .map((repo) => ({ repo, worktrees: worktreesByRepo[repo.id] ?? [] }))
        .filter((group) => group.worktrees.length > 0),
    [repos, worktreesByRepo]
  )
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <Command>
        <CommandInput
          autoFocus
          placeholder={translate(
            'auto.components.rightSidebar.lineageMembers.addToTower.searchWorktrees',
            'Search worktrees…'
          )}
        />
        <CommandList className="max-h-56">
          <CommandEmpty>
            {translate(
              'auto.components.rightSidebar.lineageMembers.addToTower.noWorktrees',
              'No worktrees found'
            )}
          </CommandEmpty>
          {groups.map(({ repo, worktrees }) => (
            <CommandGroup key={repo.id} heading={repo.displayName}>
              {worktrees.map((worktree) => {
                const picked = value?.repoId === repo.id && value.worktreePath === worktree.path
                const branch = worktreeBranchLabel(worktree)
                return (
                  <CommandItem
                    key={worktree.id}
                    value={worktree.id}
                    keywords={[repo.displayName, worktree.displayName, branch]}
                    onSelect={() => onChange({ repoId: repo.id, worktreePath: worktree.path })}
                  >
                    {picked ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                    <span className="min-w-0 truncate">{worktree.displayName}</span>
                    {branch && branch !== worktree.displayName ? (
                      <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
                        {branch}
                      </span>
                    ) : null}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </div>
  )
}
