import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { findIndexedProjectGroupOwner } from '@/lib/worktree-runtime-owner-index'
import { getProjectGroupingModelFromState } from '@/store/project-host-setup-selector'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'
import { persistedUIValuesEqual } from '../../../../shared/persisted-ui-equality'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { AppState } from '@/store/types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  currentProjectGroupMember,
  projectGroupCatalog,
  projectGroupOperationValues,
  resolveProjectGroupOperation,
  type ProjectGroupEntrance,
  type ProjectGroupOperation
} from './project-group-operation'

export function reportProjectGroupOperationFailure(): void {
  toast.error(
    translate('auto.store.slices.repos.moveToGroupOtherHost', 'Could not move project to group')
  )
}

export type ProjectGroupAttempt = {
  operation: ProjectGroupOperation
  createdGroup?: ProjectGroup
  creation?: Promise<ProjectGroup | null>
  pending?: Promise<boolean>
}

function destinationExists(
  state: AppState,
  operation: ProjectGroupOperation,
  group: ProjectGroup
): boolean {
  const current = findIndexedProjectGroupOwner(
    state.projectGroups,
    group.id,
    getProjectGroupHostId(group)
  )
  return Boolean(
    current && projectGroupCatalog(getProjectGroupHostId(current)) === operation.catalogHostId
  )
}

function sourcesExist(state: AppState, operation: ProjectGroupOperation): boolean {
  return (
    operation.complete &&
    operation.members.every((member) => {
      const current = currentProjectGroupMember(state, member)
      return (
        current && projectGroupCatalog(getRepoExecutionHostId(current)) === operation.catalogHostId
      )
    })
  )
}

function useOwnedProjectGroupOperation() {
  const current = useRef<ProjectGroupAttempt | null>(null)
  useEffect(
    () => () => {
      current.current = null
    },
    []
  )
  return useMemo(() => {
    const cancel = (attempt?: ProjectGroupAttempt) => {
      if (!attempt || current.current === attempt) {
        current.current = null
      }
    }
    const capture = (operation: ProjectGroupOperation): ProjectGroupAttempt | null => {
      current.current = null
      if (!sourcesExist(useAppStore.getState(), operation)) {
        reportProjectGroupOperationFailure()
        return null
      }
      const attempt: ProjectGroupAttempt = {
        operation: { ...operation, members: operation.members.map((member) => ({ ...member })) }
      }
      current.current = attempt
      return attempt
    }
    const run = async (
      attempt: ProjectGroupAttempt,
      group: ProjectGroup | null
    ): Promise<boolean> => {
      if (current.current !== attempt) {
        return false
      }
      const { operation } = attempt
      const state = useAppStore.getState()
      if (
        !sourcesExist(state, operation) ||
        (group && !destinationExists(state, operation, group))
      ) {
        reportProjectGroupOperationFailure()
        return false
      }
      for (const member of operation.members) {
        if (current.current !== attempt) {
          return false
        }
        const latest = useAppStore.getState()
        const source = currentProjectGroupMember(latest, member)
        if (!source || (group && !destinationExists(latest, operation, group))) {
          reportProjectGroupOperationFailure()
          return false
        }
        if ((source.projectGroupId ?? null) === (group?.id ?? null)) {
          continue
        }
        // The singleton owner reconciles the dispatched result, including a historical normalization.
        const confirmed = await latest.moveProjectToGroup(source, group?.id ?? null)
        if (!confirmed || current.current !== attempt) {
          return false
        }
      }
      return current.current === attempt
    }
    return {
      cancel,
      capture,
      move: async (operation: ProjectGroupOperation, groupId: string | null): Promise<boolean> => {
        const attempt = capture(operation)
        if (!attempt) {
          return false
        }
        const group = groupId
          ? operation.destinations.find((candidate) => candidate.id === groupId)
          : null
        if (groupId && !group) {
          reportProjectGroupOperationFailure()
          return false
        }
        return run(attempt, group ?? null)
      },
      submitNew: (attempt: ProjectGroupAttempt, name: string): Promise<boolean> => {
        if (attempt.pending) {
          return attempt.pending
        }
        const submit = async () => {
          if (current.current !== attempt) {
            return false
          }
          if (!sourcesExist(useAppStore.getState(), attempt.operation)) {
            reportProjectGroupOperationFailure()
            return false
          }
          if (!attempt.createdGroup) {
            attempt.creation ??= useAppStore
              .getState()
              .createProjectGroup(name, attempt.operation.catalogHostId)
            const group = await attempt.creation
            if (!group) {
              if (current.current === attempt) {
                reportProjectGroupOperationFailure()
              }
              return false
            }
            attempt.createdGroup = group
          }
          return run(attempt, attempt.createdGroup)
        }
        const pending = submit().finally(() => {
          attempt.pending = undefined
        })
        attempt.pending = pending
        return pending
      }
    }
  }, [])
}

export type ProjectGroupOperationOwner = ReturnType<typeof useOwnedProjectGroupOperation>
export const ProjectGroupOperationContext = createContext<ProjectGroupOperationOwner | null>(null)

export function useProjectGroupOperationOwner(): ProjectGroupOperationOwner {
  const inherited = useContext(ProjectGroupOperationContext)
  const owned = useOwnedProjectGroupOperation()
  return inherited ?? owned
}

export function useProjectGroupOperation(open: boolean, entrance: ProjectGroupEntrance | null) {
  const select = useMemo(() => {
    let inputs: readonly unknown[] = []
    let result: ProjectGroupOperation | null = null
    let values: unknown = null
    return (state: AppState) => {
      if (!open || !entrance) {
        return null
      }
      const model = getProjectGroupingModelFromState(state)
      const nextInputs = [state.repos, state.projectGroups, model]
      if (nextInputs.every((value, index) => value === inputs[index])) {
        return result
      }
      inputs = nextInputs
      const next = resolveProjectGroupOperation(state, entrance)
      const nextValues = projectGroupOperationValues(next)
      if (!persistedUIValuesEqual(values, nextValues)) {
        result = next
        values = nextValues
      }
      return result
    }
  }, [open, entrance])
  return useAppStore(select)
}
