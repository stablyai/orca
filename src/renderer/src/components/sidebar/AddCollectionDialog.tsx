import React, { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { useAppStore } from '@/store'
import { assignCollectionMembership } from '../../../../shared/collections'
import type { Collection } from '../../../../shared/collection-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { translate } from '@/i18n/i18n'

type AddCollectionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, adds to this existing collection instead of creating one. */
  collection?: Collection | null
}

type RepoGroup = { repo: Repo; worktrees: Worktree[] }

/** Branch/folder seed for worktrees started from the collection dialog. */
function collectionWorktreeName(collectionName: string): string {
  // Why: git refs reject '..', '.lock' endings, and leading/trailing dots.
  const slug = collectionName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .slice(0, 40)
    .replace(/(\.lock)+$/, '')
    .replace(/^[.-]+|[.-]+$/g, '')
  return slug || 'workstream'
}

export function AddCollectionDialog({
  open,
  onOpenChange,
  collection = null
}: AddCollectionDialogProps): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const createCollection = useAppStore((s) => s.createCollection)
  const createWorktree = useAppStore((s) => s.createWorktree)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const [name, setName] = useState('')
  const [selectedWorktreeIds, setSelectedWorktreeIds] = useState<ReadonlySet<string>>(new Set())
  const [newWorktreeRepoIds, setNewWorktreeRepoIds] = useState<ReadonlySet<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  const mountedRef = useRef(true)

  // Why: reseed per open without an Effect so the first frame is already clean.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName('')
      setSelectedWorktreeIds(new Set())
      setNewWorktreeRepoIds(new Set())
      setSubmitting(false)
    }
  }

  const handleDialogContentRef = useCallback((node: HTMLDivElement | null): void => {
    mountedRef.current = node !== null
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Why: closing mid-submit re-arms the form while the first batch is still filing.
      if (!next && submitting) {
        return
      }
      onOpenChange(next)
    },
    [submitting, onOpenChange]
  )

  // Why: every repo lists — empty and master-only repos are exactly the ones
  // you start a fresh worktree in.
  const repoGroups: RepoGroup[] = useMemo(
    () =>
      repos.map((repo) => ({
        repo,
        worktrees: (worktreesByRepo?.[repo.id] ?? []).filter(
          (worktree) =>
            !worktree.isArchived && !(collection && worktree.collectionIds?.includes(collection.id))
        )
      })),
    [repos, worktreesByRepo, collection]
  )

  const trimmedName = name.trim()
  const isAddMode = collection !== null
  const selectionCount = selectedWorktreeIds.size + newWorktreeRepoIds.size
  const canSubmit = !submitting && (isAddMode ? selectionCount > 0 : trimmedName.length > 0)

  const toggleWorktree = useCallback((worktreeId: string) => {
    setSelectedWorktreeIds((current) => {
      const next = new Set(current)
      if (next.has(worktreeId)) {
        next.delete(worktreeId)
      } else {
        next.add(worktreeId)
      }
      return next
    })
  }, [])

  const toggleNewWorktreeRepo = useCallback((repoId: string) => {
    setNewWorktreeRepoIds((current) => {
      const next = new Set(current)
      if (next.has(repoId)) {
        next.delete(repoId)
      } else {
        next.add(repoId)
      }
      return next
    })
  }, [])

  const fileMembership = useCallback(
    async (collectionId: string, collectionName: string) => {
      for (const repoId of newWorktreeRepoIds) {
        try {
          const created = await createWorktree(
            repoId,
            collectionWorktreeName(collectionName),
            undefined,
            'inherit'
          )
          await updateWorktreeMeta(created.worktree.id, { collectionIds: [collectionId] })
        } catch (error) {
          const repoName = repos.find((repo) => repo.id === repoId)?.displayName ?? repoId
          console.error('Failed to create worktree for collection:', error)
          toast.error(
            translate(
              'auto.components.sidebar.AddCollectionDialog.createWorktreeFailed',
              'Could not create a worktree in {{value0}}',
              { value0: repoName }
            )
          )
        }
      }
      const selected = repoGroups
        .flatMap((group) => group.worktrees)
        .filter((worktree) => selectedWorktreeIds.has(worktree.id))
      for (const worktree of selected) {
        try {
          await updateWorktreeMeta(worktree.id, {
            collectionIds: assignCollectionMembership(worktree.collectionIds, collectionId, {
              exclusive: !worktree.isMainWorktree
            })
          })
        } catch (error) {
          // Why: keep filing the rest of the batch; per-worktree toasts show what failed.
          console.error('Failed to add worktree to collection:', error)
          toast.error(
            translate(
              'auto.components.sidebar.AddCollectionDialog.addWorktreeFailed',
              'Could not add {{value0}} to the collection',
              { value0: worktree.displayName }
            )
          )
        }
      }
    },
    [newWorktreeRepoIds, createWorktree, updateWorktreeMeta, repos, repoGroups, selectedWorktreeIds]
  )

  const handleSubmit = useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault()
      if (!canSubmit) {
        return
      }
      setSubmitting(true)
      try {
        if (isAddMode && collection) {
          await fileMembership(collection.id, collection.name)
        } else {
          const created = await createCollection(trimmedName)
          if (!created) {
            // Why: the store returns null on transport failure; closing here
            // would swallow the error with no collection and no feedback.
            toast.error(
              translate(
                'auto.components.sidebar.AddCollectionDialog.createFailed',
                'Could not create the collection'
              )
            )
            return
          }
          await fileMembership(created.id, created.name)
        }
        if (mountedRef.current) {
          onOpenChange(false)
        }
      } finally {
        if (mountedRef.current) {
          setSubmitting(false)
        }
      }
    },
    [canSubmit, isAddMode, collection, fileMembership, createCollection, trimmedName, onOpenChange]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={handleDialogContentRef}
        // Why: the grid's min-content tracks otherwise blow out past max-width on
        // long unbreakable worktree names (same guard as AddRepoDialogChrome).
        className="min-w-0 max-w-md overflow-hidden sm:max-w-md [&>*]:min-w-0"
      >
        <DialogHeader>
          <DialogTitle>
            {isAddMode
              ? translate(
                  'auto.components.sidebar.AddCollectionDialog.addTitle',
                  'Add worktrees to “{{value0}}”',
                  { value0: collection?.name ?? '' }
                )
              : translate('auto.components.sidebar.AddCollectionDialog.title', 'Add Collection')}
          </DialogTitle>
          <DialogDescription>
            {isAddMode
              ? translate(
                  'auto.components.sidebar.AddCollectionDialog.addDescription',
                  'Start new worktrees or pick existing ones.'
                )
              : translate(
                  'auto.components.sidebar.AddCollectionDialog.description',
                  'Pick the projects this workstream spans — start a fresh worktree in each, or pick existing ones.'
                )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {!isAddMode ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {translate('auto.components.sidebar.AddCollectionDialog.nameLabel', 'Name')}
              </p>
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={translate(
                  'auto.components.sidebar.AddCollectionDialog.namePlaceholder',
                  'Collection name'
                )}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {translate('auto.components.sidebar.AddCollectionDialog.projectsLabel', 'Projects')}
            </p>
            <div className="scrollbar-sleek max-h-80 overflow-y-auto overflow-x-hidden rounded-md border border-input bg-background">
              {repoGroups.length === 0 ? (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.AddCollectionDialog.noProjects',
                    'No projects yet — add one first.'
                  )}
                </div>
              ) : (
                repoGroups.map((group, index) => (
                  <div
                    key={group.repo.id}
                    className={index > 0 ? 'border-t border-border/70' : undefined}
                  >
                    <div className="flex h-8 items-center gap-2 px-3">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: group.repo.badgeColor }}
                      />
                      <span className="min-w-0 truncate text-[13px] font-semibold">
                        {group.repo.displayName}
                      </span>
                    </div>
                    <label className="flex h-8 cursor-pointer items-center gap-2.5 pl-8 pr-3 transition-colors hover:bg-accent/50">
                      <Checkbox
                        checked={newWorktreeRepoIds.has(group.repo.id)}
                        onCheckedChange={() => toggleNewWorktreeRepo(group.repo.id)}
                      />
                      <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <Plus className="size-3.5" />
                        {translate(
                          'auto.components.sidebar.AddCollectionDialog.newWorktree',
                          'New worktree'
                        )}
                      </span>
                    </label>
                    {group.worktrees.map((worktree) => (
                      <label
                        key={worktree.id}
                        className="flex h-8 cursor-pointer items-center gap-2.5 pl-8 pr-3 transition-colors hover:bg-accent/50"
                      >
                        <Checkbox
                          checked={selectedWorktreeIds.has(worktree.id)}
                          onCheckedChange={() => toggleWorktree(worktree.id)}
                        />
                        <span className="min-w-0 truncate text-[13px]">{worktree.displayName}</span>
                        {worktree.isMainWorktree ? (
                          <span className="shrink-0 rounded border border-border/80 px-1 text-[10px] leading-4 text-muted-foreground">
                            {translate(
                              'auto.components.sidebar.AddCollectionDialog.primaryBadge',
                              'primary'
                            )}
                          </span>
                        ) : null}
                      </label>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => handleOpenChange(false)}
            >
              {translate('auto.components.sidebar.AddCollectionDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting && newWorktreeRepoIds.size > 0
                ? translate(
                    'auto.components.sidebar.AddCollectionDialog.creating',
                    'Creating worktrees…'
                  )
                : isAddMode
                  ? translate('auto.components.sidebar.AddCollectionDialog.add', 'Add')
                  : translate('auto.components.sidebar.AddCollectionDialog.create', 'Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
