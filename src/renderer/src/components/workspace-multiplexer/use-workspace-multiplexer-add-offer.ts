import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { requestWorkspaceMultiplexerAdd } from './workspace-multiplexer-add-request'
import {
  workspaceMultiplexerSlotIdentity,
  type WorkspaceMultiplexerCatalogItem
} from './workspace-multiplexer-model'

export function useWorkspaceMultiplexerAddOffer(
  catalog: readonly WorkspaceMultiplexerCatalogItem[]
): void {
  const lineage = useAppStore((state) => state.worktreeLineageById)
  const slots = useAppStore((state) => state.workspaceMultiplexer.slots)
  const openedAt = useRef<number | null>(null)
  const offered = useRef(new Set<string>())
  const pending = useRef(new Map<string, WorkspaceMultiplexerCatalogItem>())
  const toastId = useRef<string | number | undefined>(undefined)

  useEffect(() => {
    openedAt.current ??= Date.now()
    const represented = new Set(slots.map(workspaceMultiplexerSlotIdentity))
    for (const item of catalog) {
      const entry = lineage[item.worktreeId]
      const worktree = useAppStore
        .getState()
        .getKnownWorktreeById(item.worktreeId, item.executionHostId)
      if (represented.has(item.identity)) {
        pending.current.delete(item.identity)
      }
      if (
        entry?.origin === 'manual' ||
        (worktree?.createdAt ?? entry?.createdAt ?? 0) < openedAt.current ||
        !worktree?.instanceId ||
        (entry && entry.worktreeInstanceId !== worktree.instanceId) ||
        represented.has(item.identity) ||
        offered.current.has(item.identity)
      ) {
        continue
      }
      offered.current.add(item.identity)
      pending.current.set(item.identity, item)
    }
    const available = new Set(catalog.map((item) => item.identity))
    for (const identity of pending.current.keys()) {
      if (!available.has(identity)) {
        pending.current.delete(identity)
      }
    }
    if (pending.current.size === 0) {
      if (toastId.current !== undefined) {
        toast.dismiss(toastId.current)
      }
      return
    }
    const clear = (): void => {
      pending.current.clear()
    }
    toastId.current = toast(
      translate(
        'workspaceMultiplexer.addOffer.title',
        'Add new workspaces to Workspace Multiplexer?'
      ),
      {
        id: toastId.current,
        duration: Infinity,
        description: [...pending.current.values()].map((item) => item.workspaceName).join(', '),
        action: {
          label: translate('workspaceMultiplexer.addOffer.add', 'Add to multiplexer'),
          onClick: () => {
            if (useAppStore.getState().activeView === 'multiplexer') {
              for (const item of pending.current.values()) {
                requestWorkspaceMultiplexerAdd({
                  worktreeId: item.worktreeId,
                  executionHostId: item.executionHostId
                })
              }
            }
            clear()
          }
        },
        cancel: {
          label: translate('workspaceMultiplexer.addOffer.later', 'Later'),
          onClick: clear
        },
        onDismiss: clear
      }
    )
  }, [catalog, lineage, slots])

  useEffect(
    () => () => {
      if (toastId.current !== undefined) {
        toast.dismiss(toastId.current)
      }
    },
    []
  )
}
