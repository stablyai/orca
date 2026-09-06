import { useDeferredValue, useMemo, useRef, useState } from 'react'
import type { WorktreePaletteRequestGuard } from '@/lib/worktree-palette-create-action'
import {
  buildPaletteFilterFromSidebarScope,
  type PaletteFilterState
} from '@/components/cmd-j/palette-filter'
import { useAppStore } from '@/store'
import { parseCmdJTaskSourceUrl } from '@/lib/worktree-palette-task-url-match'
import { getWorktreePaletteCreateActionState } from '@/lib/worktree-palette-create-action'
import type { CmdJActiveGroupSnapshot } from '@/components/cmd-j/quick-action-context'
import type { WorkspaceVisibleTabType } from '../../../shared/tab-types'
import type { PaletteItem } from './worktree-jump-palette-model'

export function useWorktreeJumpPaletteLocalState({
  createLookupGuard,
  visible
}: {
  createLookupGuard: WorktreePaletteRequestGuard
  visible: boolean
}) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const liveQueryRef = useRef(query)
  // Keyboard handlers must see the current query before effects flush.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  liveQueryRef.current = query
  const taskSourceUrl = useMemo(() => parseCmdJTaskSourceUrl(query), [query])
  const paletteSearchQuery = taskSourceUrl ? query.trim() : deferredQuery.trim()
  const deferredCreateAction = useMemo(
    () => getWorktreePaletteCreateActionState({ query: deferredQuery }),
    [deferredQuery]
  )
  const createWorktreeName = taskSourceUrl ? query.trim() : deferredCreateAction.createWorktreeName
  const showCreateAction = deferredCreateAction.showCreateAction || taskSourceUrl !== null
  const [selectedItemId, setSelectedItemId] = useState('')
  const latestQueryRef = useRef('')
  const autoSelectedItemIdRef = useRef<string | null>(null)
  // Create is armed by an explicit keyboard/pointer move, except for task URLs.
  const selectionMovedByUserRef = useRef(false)
  const digitShortcutItemsRef = useRef<readonly PaletteItem[]>([])
  const [filterState, setFilterState] = useState<PaletteFilterState>(() =>
    buildPaletteFilterFromSidebarScope(useAppStore.getState())
  )
  const [dialogElement, setDialogElement] = useState<HTMLElement | null>(null)
  const previousWorktreeIdRef = useRef<string | null>(null)
  const previousActiveTabTypeRef = useRef<WorkspaceVisibleTabType>('terminal')
  const previousBrowserPageIdRef = useRef<string | null>(null)
  const previousBrowserFocusTargetRef = useRef<'webview' | 'address-bar'>('webview')
  const previousFocusElementRef = useRef<HTMLElement | null>(null)
  const activeGroupSnapshotRef = useRef<CmdJActiveGroupSnapshot | null>(null)
  const wasVisibleRef = useRef(false)
  const skipRestoreFocusRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fallbackFocusOuterFrameRef = useRef<number | null>(null)
  const fallbackFocusInnerFrameRef = useRef<number | null>(null)
  const preserveCreateLookupOnCloseRef = useRef(false)
  const [expandedSectionCaps, setExpandedSectionCaps] = useState<Record<string, number>>({})

  // Reset query/open state during render so the palette never paints stale results.
  const [previousQuery, setPreviousQuery] = useState(query)
  const [previousVisible, setPreviousVisible] = useState(visible)
  const visibilityChanged = previousVisible !== visible
  if (previousQuery !== query || visibilityChanged) {
    setPreviousQuery(query)
    setPreviousVisible(visible)
    setExpandedSectionCaps({})
    if (visibilityChanged && visible) {
      setFilterState(buildPaletteFilterFromSidebarScope(useAppStore.getState()))
    }
  }

  return {
    query,
    setQuery,
    deferredQuery,
    liveQueryRef,
    taskSourceUrl,
    paletteSearchQuery,
    createWorktreeName,
    showCreateAction,
    selectedItemId,
    setSelectedItemId,
    latestQueryRef,
    autoSelectedItemIdRef,
    selectionMovedByUserRef,
    digitShortcutItemsRef,
    filterState,
    setFilterState,
    dialogElement,
    setDialogElement,
    previousWorktreeIdRef,
    previousActiveTabTypeRef,
    previousBrowserPageIdRef,
    previousBrowserFocusTargetRef,
    previousFocusElementRef,
    activeGroupSnapshotRef,
    wasVisibleRef,
    skipRestoreFocusRef,
    listRef,
    inputRef,
    fallbackFocusOuterFrameRef,
    fallbackFocusInnerFrameRef,
    createLookupGuard,
    preserveCreateLookupOnCloseRef,
    expandedSectionCaps,
    setExpandedSectionCaps,
    previousVisible
  }
}

export type WorktreeJumpPaletteLocalState = ReturnType<typeof useWorktreeJumpPaletteLocalState>
