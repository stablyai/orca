import React, { useCallback, useMemo } from 'react'
import { CheckCircle2, FolderTree } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useRepoMap, useWorktreeMap } from '@/store/selectors'
import { useWorktreeLineageTreeStore } from '@/store/worktree-lineage-tree-store'
import { buildWorktreeLineageTreeGraph } from './worktree-lineage-tree-model'
import { WorktreeLineageTreeNode } from './WorktreeLineageTreeNode'

export function WorktreeLineageTreeDialog(): React.JSX.Element | null {
  const request = useWorktreeLineageTreeStore((s) => s.request)
  const closeLineageTree = useWorktreeLineageTreeStore((s) => s.closeLineageTree)
  const lineageById = useAppStore((s) => s.worktreeLineageById)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const updateWorktreeLineage = useAppStore((s) => s.updateWorktreeLineage)
  const worktreeMap = useWorktreeMap()
  const repoMap = useRepoMap()

  const isOpen = Boolean(request)

  const graph = useMemo(() => {
    if (!request?.worktreeId) {
      return null
    }
    return buildWorktreeLineageTreeGraph({
      targetWorktreeId: request.worktreeId,
      newlyLinkedId: request.newlyLinkedId,
      lineageById,
      worktreeMap,
      repoMap
    })
  }, [lineageById, repoMap, request?.newlyLinkedId, request?.worktreeId, worktreeMap])

  const handleSelectWorktree = useCallback(
    (worktreeId: string) => {
      setActiveWorktree(worktreeId)
      closeLineageTree()
    },
    [closeLineageTree, setActiveWorktree]
  )

  const handleUnlinkWorktree = useCallback(
    (worktreeId: string) => {
      void updateWorktreeLineage(worktreeId, { noParent: true })
    },
    [updateWorktreeLineage]
  )

  if (!isOpen || !graph?.rootNode) {
    return null
  }

  const isNewlyLinked = Boolean(request?.newlyLinkedId)

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeLineageTree()}>
      <DialogContent className="max-w-xl max-h-[85vh] flex flex-col p-6">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <FolderTree className="size-5 text-primary" />
            <DialogTitle className="text-base font-semibold">
              {translate('auto.components.sidebar.lineageTree.title', 'Worktree Hierarchy')}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.lineageTree.description',
              'Hierarchical visualization of linked parent and child worktrees.'
            )}
          </DialogDescription>
        </DialogHeader>

        {isNewlyLinked ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-4 shrink-0" />
            <span>
              {translate(
                'auto.components.sidebar.lineageTree.successBanner',
                'Worktree successfully linked! The updated tree hierarchy is shown below.'
              )}
            </span>
          </div>
        ) : null}

        <ScrollArea className="max-h-[55vh] flex-1 overflow-y-auto scrollbar-sleek pr-3 py-1">
          <WorktreeLineageTreeNode
            node={graph.rootNode}
            activeWorktreeId={activeWorktreeId}
            onSelectWorktree={handleSelectWorktree}
            onUnlinkWorktree={handleUnlinkWorktree}
          />
        </ScrollArea>

        <DialogFooter className="mt-2 pt-2 border-t border-border flex justify-between sm:justify-between items-center">
          <div className="text-xs text-muted-foreground">
            {graph.totalNodes}{' '}
            {graph.totalNodes === 1
              ? translate('auto.components.sidebar.lineageTree.worktreeCountOne', 'worktree')
              : translate('auto.components.sidebar.lineageTree.worktreeCountMany', 'worktrees')}
          </div>
          <Button variant="outline" size="sm" onClick={closeLineageTree}>
            {translate('auto.components.sidebar.lineageTree.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default WorktreeLineageTreeDialog
