import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ClickUpList,
  ClickUpSpace,
  ClickUpStatus,
  ClickUpTaskScope,
  ClickUpWorkspaceSelection
} from '../../../shared/clickup-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { clickUpListLists, clickUpListSpaces } from '@/runtime/runtime-clickup-client'
import { resolveClickUpListSelection } from './clickup-list-picker-model'
import {
  detectClickUpSprints,
  findCurrentClickUpSprint,
  groupClickUpSprintFolders,
  pickDefaultClickUpSprintFolder,
  type ClickUpSprint,
  type ClickUpSprintFolder
} from './clickup-sprints'
import {
  collectClickUpStatusOptions,
  resolveClickUpStatusSelection
} from './clickup-status-options'
import {
  loadClickUpTaskViewPreferences,
  saveClickUpTaskViewPreferences,
  type ClickUpSprintSelection,
  type ClickUpTaskViewPreferences
} from './clickup-task-view-preferences'

export type ClickUpTaskScopeState = {
  preferences: ClickUpTaskViewPreferences
  updatePreferences: (patch: Partial<ClickUpTaskViewPreferences>) => void
  spaces: ClickUpSpace[]
  spaceId: string | null
  setSpaceId: (spaceId: string | null) => void
  // Every List in the selected Space, for the picker's Lists section.
  lists: ClickUpList[]
  sprintFolders: ClickUpSprintFolder[]
  sprintFolderId: string | null
  setSprintFolderId: (folderId: string) => void
  // Sprints of the selected sprint Folder only.
  sprints: ClickUpSprint[]
  currentSprint: ClickUpSprint | null
  sprintSelection: ClickUpSprintSelection
  setSprintSelection: (selection: ClickUpSprintSelection) => void
  statusOptions: ClickUpStatus[]
  selectedStatuses: string[]
  setSelectedStatuses: (statuses: string[]) => void
  taskScope: ClickUpTaskScope | undefined
  // False while the selected Space's Lists load, so the page does not fetch
  // tasks once without the Sprint/Status narrowing and again with it.
  ready: boolean
  error: string | null
}

// Space → Sprint → Status narrowing for the ClickUp task page. Spaces load once
// per Workspace and Lists only for the selected Space; the main process caches
// both, so switching back and forth spends no extra ClickUp requests.
export function useClickUpTaskScope({
  sourceContext,
  workspaceId,
  enabled
}: {
  sourceContext: TaskSourceContext | null
  workspaceId: ClickUpWorkspaceSelection | null
  enabled: boolean
}): ClickUpTaskScopeState {
  const [preferences, setPreferences] = useState(loadClickUpTaskViewPreferences)
  const [spaces, setSpaces] = useState<ClickUpSpace[]>([])
  const [lists, setLists] = useState<ClickUpList[]>([])
  const [listsSpaceId, setListsSpaceId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Why: Spaces belong to one Workspace; "All Workspaces" has no single Space list.
  const scopedWorkspaceId = enabled && workspaceId && workspaceId !== 'all' ? workspaceId : null

  const updatePreferences = useCallback((patch: Partial<ClickUpTaskViewPreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }))
  }, [])

  // Why an effect: persisting inside the state updater would run twice under
  // StrictMode; storage only needs the settled value.
  useEffect(() => {
    saveClickUpTaskViewPreferences(preferences)
  }, [preferences])

  useEffect(() => {
    setSpaces([])
    if (!scopedWorkspaceId) {
      return
    }
    let cancelled = false
    void clickUpListSpaces(sourceContext, scopedWorkspaceId)
      .then((next) => {
        if (!cancelled) {
          setSpaces(next)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load ClickUp Spaces.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [scopedWorkspaceId, sourceContext])

  const savedSpaceId = scopedWorkspaceId
    ? (preferences.spaceByWorkspace[scopedWorkspaceId] ?? null)
    : null
  // A saved Space that no longer exists falls back to all Spaces once Spaces load.
  const spaceId =
    savedSpaceId && (spaces.length === 0 || spaces.some((space) => space.id === savedSpaceId))
      ? savedSpaceId
      : null

  useEffect(() => {
    if (!scopedWorkspaceId || !spaceId) {
      setLists([])
      setListsSpaceId(null)
      return
    }
    let cancelled = false
    setError(null)
    void clickUpListLists(sourceContext, scopedWorkspaceId, null, spaceId)
      .then((next) => {
        if (!cancelled) {
          setLists(next)
          setListsSpaceId(spaceId)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load ClickUp Lists.')
          // Still unblock the page; it falls back to Space-only narrowing.
          setLists([])
          setListsSpaceId(spaceId)
        }
      })
    return () => {
      cancelled = true
    }
  }, [scopedWorkspaceId, sourceContext, spaceId])

  const space = spaces.find((item) => item.id === spaceId) ?? null
  const sprintFolders = useMemo(
    () => groupClickUpSprintFolders(detectClickUpSprints(lists)),
    [lists]
  )
  const savedFolderId = spaceId ? preferences.sprintFolderBySpace[spaceId] : undefined
  const sprintFolder =
    sprintFolders.find((folder) => folder.id === savedFolderId) ??
    pickDefaultClickUpSprintFolder(sprintFolders)
  const sprints = useMemo(() => sprintFolder?.sprints ?? [], [sprintFolder])
  const currentSprint = useMemo(() => findCurrentClickUpSprint(sprints), [sprints])
  const statusOptions = useMemo(() => collectClickUpStatusOptions(space, lists), [space, lists])
  const savedStatuses = spaceId ? preferences.statusesBySpace[spaceId] : undefined
  const selectedStatuses = useMemo(
    () => resolveClickUpStatusSelection(statusOptions, savedStatuses),
    [savedStatuses, statusOptions]
  )
  const sprintSelection: ClickUpSprintSelection =
    (spaceId ? preferences.sprintBySpace[spaceId] : undefined) ?? 'current'

  const taskScope = useMemo((): ClickUpTaskScope | undefined => {
    if (!spaceId) {
      return undefined
    }
    const sprintListId = resolveClickUpListSelection(sprintSelection, lists, currentSprint)
    return {
      spaceId,
      ...(sprintListId ? { listIds: [sprintListId] } : {}),
      ...(selectedStatuses.length > 0 ? { statuses: selectedStatuses } : {})
    }
  }, [currentSprint, lists, selectedStatuses, spaceId, sprintSelection])

  return {
    preferences,
    updatePreferences,
    spaces,
    spaceId,
    setSpaceId: (next) => {
      if (scopedWorkspaceId) {
        const spaceByWorkspace = { ...preferences.spaceByWorkspace }
        if (next) {
          spaceByWorkspace[scopedWorkspaceId] = next
        } else {
          delete spaceByWorkspace[scopedWorkspaceId]
        }
        updatePreferences({ spaceByWorkspace })
      }
    },
    lists,
    sprintFolders,
    sprintFolderId: sprintFolder?.id ?? null,
    setSprintFolderId: (folderId) => {
      if (spaceId) {
        // A new Folder starts on its own current Sprint.
        updatePreferences({
          sprintFolderBySpace: { ...preferences.sprintFolderBySpace, [spaceId]: folderId },
          sprintBySpace: { ...preferences.sprintBySpace, [spaceId]: 'current' }
        })
      }
    },
    sprints,
    currentSprint,
    sprintSelection,
    setSprintSelection: (selection) => {
      if (spaceId) {
        updatePreferences({ sprintBySpace: { ...preferences.sprintBySpace, [spaceId]: selection } })
      }
    },
    statusOptions,
    selectedStatuses,
    setSelectedStatuses: (statuses) => {
      if (spaceId) {
        updatePreferences({
          statusesBySpace: { ...preferences.statusesBySpace, [spaceId]: statuses }
        })
      }
    },
    taskScope,
    ready: !spaceId || listsSpaceId === spaceId,
    error
  }
}
