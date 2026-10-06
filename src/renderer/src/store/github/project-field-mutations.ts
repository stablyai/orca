import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type {
  GitHubProjectFieldMutationValue,
  GitHubProjectFieldValue,
  GitHubProjectView
} from '../../../../shared/github/project-types'
import type { GitHubProjectMutationResult } from '../../../../shared/github/project-result-types'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { projectViewSourceScope, settingsForProjectViewCacheKey } from './cache-identity'
import { applyRowPatch, optimisticFieldValueFromMutation } from './project-cache'
import { githubProjectHost } from '../../../../shared/github/project-identity'

export function createProjectFieldActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'updateProjectFieldValue' | 'clearProjectFieldValue'> {
  // Serialize each field so rapid board moves reach GitHub in user order.
  type FieldWrite = {
    tail: Promise<GitHubProjectMutationResult> | null
    confirmed: GitHubProjectFieldValue | undefined
    revisionsByCache: Map<string, number>
    baselineViewsByCache: Map<string, GitHubProjectView | undefined>
  }
  const pending = new Map<string, FieldWrite>()

  const mutate = async (
    cacheKey: string,
    rowId: string,
    fieldId: string,
    value: GitHubProjectFieldMutationValue | null,
    write: FieldWrite
  ): Promise<GitHubProjectMutationResult> => {
    const revision = (write.revisionsByCache.get(cacheKey) ?? 0) + 1
    write.revisionsByCache.set(cacheKey, revision)
    const table = get().projectViewCache[cacheKey]?.data
    const row = table?.rows.find((candidate) => candidate.id === rowId)
    if (!table || !row) {
      await write.tail?.catch(() => undefined)
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: table
            ? translate('auto.store.slices.github.f963485d37', 'Row not found')
            : translate('auto.store.slices.github.a967f23983', 'Project view not loaded')
        }
      }
    }
    const next = value ? optimisticFieldValueFromMutation(table, fieldId, value) : null
    const fields = { ...row.fieldValuesByFieldId }
    if (next) {
      fields[fieldId] = next
    } else {
      delete fields[fieldId]
    }
    applyRowPatch(set, cacheKey, rowId, { ...row, fieldValuesByFieldId: fields })
    const target = getActiveRuntimeTarget(settingsForProjectViewCacheKey(get().settings, cacheKey))
    const args = { projectId: table.project.id, host: table.project.host, itemId: rowId, fieldId }
    let result: GitHubProjectMutationResult
    try {
      await write.tail?.catch(() => undefined)
      result = value
        ? target.kind === 'environment'
          ? await callRuntimeRpc<GitHubProjectMutationResult>(
              target,
              'github.project.updateItemField',
              { ...args, value },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.updateProjectItemField({ ...args, value })
        : target.kind === 'environment'
          ? await callRuntimeRpc<GitHubProjectMutationResult>(
              target,
              'github.project.clearItemField',
              args,
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.clearProjectItemField(args)
    } catch (error) {
      result = {
        ok: false,
        error: {
          type: 'unknown',
          message:
            error instanceof Error
              ? error.message
              : translate('projectField.updateFailed', 'Failed to update project field')
        }
      }
    }
    if (result.ok) {
      write.confirmed = next ?? undefined
    } else {
      const currentTable = get().projectViewCache[cacheKey]?.data
      const current = currentTable?.rows.find((item) => item.id === rowId)
      // A refresh owns its new value; rollback only our field and preserve concurrent content edits.
      if (
        current &&
        write.revisionsByCache.get(cacheKey) === revision &&
        currentTable?.selectedView === table.selectedView &&
        current.fieldValuesByFieldId[fieldId] === (next ?? undefined)
      ) {
        const restored = { ...current.fieldValuesByFieldId }
        if (write.confirmed) {
          restored[fieldId] = write.confirmed
        } else {
          delete restored[fieldId]
        }
        applyRowPatch(set, cacheKey, rowId, { ...current, fieldValuesByFieldId: restored })
      }
    }
    return result
  }

  const enqueue = (
    cacheKey: string,
    rowId: string,
    fieldId: string,
    value: GitHubProjectFieldMutationValue | null
  ): Promise<GitHubProjectMutationResult> => {
    const table = get().projectViewCache[cacheKey]?.data
    const key = JSON.stringify([
      projectViewSourceScope(settingsForProjectViewCacheKey(get().settings, cacheKey)),
      githubProjectHost(table?.project.host).toLowerCase(),
      table?.project.id ?? cacheKey,
      rowId,
      fieldId
    ])
    const current = table?.rows.find((row) => row.id === rowId)?.fieldValuesByFieldId[fieldId]
    const write = pending.get(key) ?? {
      tail: null,
      revisionsByCache: new Map<string, number>(),
      confirmed: current,
      baselineViewsByCache: new Map([[cacheKey, table?.selectedView]])
    }
    if (
      table &&
      write.baselineViewsByCache.has(cacheKey) &&
      write.baselineViewsByCache.get(cacheKey) !== table.selectedView
    ) {
      write.confirmed = current
    }
    write.baselineViewsByCache.set(cacheKey, table?.selectedView)
    const request = mutate(cacheKey, rowId, fieldId, value, write)
    write.tail = request
    pending.set(key, write)
    const cleanup = (): void => {
      if (pending.get(key)?.tail === request) {
        pending.delete(key)
      }
    }
    void request.then(cleanup, cleanup)
    return request
  }
  return {
    updateProjectFieldValue: (cacheKey, rowId, fieldId, value) =>
      enqueue(cacheKey, rowId, fieldId, value),
    clearProjectFieldValue: (cacheKey, rowId, fieldId) => enqueue(cacheKey, rowId, fieldId, null)
  }
}
