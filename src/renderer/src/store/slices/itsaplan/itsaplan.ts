import type { StateCreator } from 'zustand'
import { createRuntimeItsaplanClient } from '@/runtime/itsaplan/runtime-itsaplan-client'
import { defaultScopeSource } from '@/runtime/hosts/selection/default-creation-host'
import { getProviderRuntimeContextKey } from '@/runtime/hosts/observations/provider-runtime-context'
import type {
  ItsaplanConnectionStatus,
  ItsaplanIssue,
  ItsaplanIssueDetail
} from '../../../../../shared/itsaplan/itsaplan-types'
import type { AppState } from '../../types'
import { itsaplanIssueListCacheKey, type ItsaplanSlice } from './itsaplan-slice-contract'

const DISCONNECTED_STATUS: ItsaplanConnectionStatus = {
  connected: false,
  viewer: null,
  instance: null
}

// In-flight reads shared by concurrent callers; cleared on disconnect so stale results are dropped.
let inflight = new Map<string, Promise<unknown>>()

function dedupe<T>(key: string, start: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each dedupe key is always used with one result type.
    return existing as Promise<T>
  }
  const request = start().finally(() => {
    if (inflight.get(key) === request) {
      inflight.delete(key)
    }
  })
  inflight.set(key, request)
  return request
}

function replaceIssue(issues: ItsaplanIssue[], updated: ItsaplanIssue): ItsaplanIssue[] {
  return issues.some((item) => item.id === updated.id)
    ? issues.map((item) => (item.id === updated.id ? updated : item))
    : issues
}

export const createItsaplanSlice: StateCreator<AppState, [], [], ItsaplanSlice> = (set, get) => {
  const client = () => createRuntimeItsaplanClient(defaultScopeSource(get().settings))
  const runtimeContextKey = () => getProviderRuntimeContextKey(get().settings)
  // Bumped on disconnect/reconnect so reads and writes started for the old account never land.
  let generation = 0
  const setIfCurrent = (
    gen: number,
    update: Partial<ItsaplanSlice> | ((state: AppState) => Partial<ItsaplanSlice>)
  ): void => {
    if (gen === generation) {
      set(update)
    }
  }
  const resetConnectionScope = (): void => {
    generation += 1
    inflight = new Map()
    set({
      itsaplanProjects: null,
      itsaplanProjectMetadata: {},
      itsaplanIssueLists: {},
      itsaplanIssueDetails: {}
    })
  }

  return {
    itsaplanStatus: null,
    itsaplanStatusContextKey: null,
    itsaplanProjects: null,
    itsaplanProjectMetadata: {},
    itsaplanIssueLists: {},
    itsaplanIssueDetails: {},

    refreshItsaplanStatus: () => {
      const contextKey = runtimeContextKey()
      const previousKey = get().itsaplanStatusContextKey
      if (previousKey !== null && previousKey !== contextKey) {
        // Another runtime owns a different account, so drop everything read under the old one.
        resetConnectionScope()
        set({ itsaplanStatus: null, itsaplanStatusContextKey: null })
      }
      return dedupe(`status:${contextKey}`, async () => {
        const gen = generation
        let status: ItsaplanConnectionStatus
        try {
          status = await client().status()
        } catch {
          // Settle out of the null "checking" state so setup UI does not spin forever.
          status = DISCONNECTED_STATUS
        }
        if (runtimeContextKey() === contextKey) {
          setIfCurrent(gen, { itsaplanStatus: status, itsaplanStatusContextKey: contextKey })
        }
        return status
      })
    },

    connectItsaplan: async (args) => {
      const result = await client().connect(args)
      if (result.ok) {
        resetConnectionScope()
        await get().refreshItsaplanStatus()
      }
      return result
    },

    detectItsaplanApiUrl: (appUrl) => client().detectApiUrl({ appUrl }),

    disconnectItsaplan: async () => {
      // Reset before and after so reads racing the credential removal are dropped too.
      resetConnectionScope()
      await client().disconnect()
      resetConnectionScope()
      set({
        itsaplanStatus: DISCONNECTED_STATUS,
        itsaplanStatusContextKey: runtimeContextKey()
      })
    },

    loadItsaplanProjects: async (opts) => {
      const cached = get().itsaplanProjects
      if (cached && !opts?.force) {
        return cached
      }
      return dedupe('projects', async () => {
        const gen = generation
        const projects = await client().listProjects()
        setIfCurrent(gen, { itsaplanProjects: projects })
        return projects
      })
    },

    loadItsaplanProjectMetadata: async (projectRef, opts) => {
      const cached = get().itsaplanProjectMetadata[projectRef]
      if (cached && !opts?.force) {
        return cached
      }
      return dedupe(`metadata:${projectRef}`, async () => {
        const gen = generation
        const metadata = await client().getProjectMetadata({ projectRef })
        setIfCurrent(gen, (state) => ({
          itsaplanProjectMetadata: { ...state.itsaplanProjectMetadata, [projectRef]: metadata }
        }))
        return metadata
      })
    },

    loadItsaplanIssues: async (query, opts) => {
      const key = itsaplanIssueListCacheKey(query)
      const cached = get().itsaplanIssueLists[key]
      // fetchedAt 0 marks an entry invalidated by a create, so it refetches.
      if (cached && cached.fetchedAt > 0 && !cached.error && !opts?.force) {
        return cached.issues
      }
      return dedupe(`issues:${key}`, async () => {
        const gen = generation
        const previous = get().itsaplanIssueLists[key]
        setIfCurrent(gen, (state) => ({
          itsaplanIssueLists: {
            ...state.itsaplanIssueLists,
            [key]: {
              issues: previous?.issues ?? [],
              fetchedAt: previous?.fetchedAt ?? 0,
              error: null,
              loading: true
            }
          }
        }))
        try {
          const issues = await client().listIssues(query)
          setIfCurrent(gen, (state) => ({
            itsaplanIssueLists: {
              ...state.itsaplanIssueLists,
              [key]: { issues, fetchedAt: Date.now(), error: null, loading: false }
            }
          }))
          return issues
        } catch (error) {
          const entry = get().itsaplanIssueLists[key]
          const message = error instanceof Error ? error.message : String(error)
          setIfCurrent(gen, (state) => ({
            itsaplanIssueLists: {
              ...state.itsaplanIssueLists,
              [key]: {
                issues: entry?.issues ?? [],
                fetchedAt: entry?.fetchedAt ?? 0,
                error: message,
                loading: false
              }
            }
          }))
          return entry?.issues ?? []
        }
      })
    },

    loadItsaplanIssueDetail: async (issueId, opts) => {
      const cached = get().itsaplanIssueDetails[issueId]
      if (cached && !opts?.force) {
        return cached
      }
      return dedupe(`detail:${issueId}`, async () => {
        const gen = generation
        const detail = await client().getIssue({ issueId, projectRef: opts?.projectRef })
        if (detail) {
          setIfCurrent(gen, (state) => ({
            itsaplanIssueDetails: { ...state.itsaplanIssueDetails, [issueId]: detail }
          }))
        }
        return detail
      })
    },

    createItsaplanIssue: async (args) => {
      const gen = generation
      const result = await client().createIssue(args)
      if (result.ok) {
        // New issue belongs in lists we cannot filter locally, so mark them for refetch.
        setIfCurrent(gen, (state) => ({
          itsaplanIssueLists: Object.fromEntries(
            Object.entries(state.itsaplanIssueLists).map(([key, entry]) => [
              key,
              { ...entry, fetchedAt: 0 }
            ])
          )
        }))
      }
      return result
    },

    updateItsaplanIssue: async (issueId, updates, projectRef) => {
      const gen = generation
      const result = await client().updateIssue({ issueId, projectRef, updates })
      if (result.ok) {
        const updated = result.issue
        setIfCurrent(gen, (state) => {
          const detail = state.itsaplanIssueDetails[issueId]
          const nextDetail: ItsaplanIssueDetail | undefined = detail && { ...detail, ...updated }
          return {
            itsaplanIssueDetails: nextDetail
              ? { ...state.itsaplanIssueDetails, [issueId]: nextDetail }
              : state.itsaplanIssueDetails,
            itsaplanIssueLists: Object.fromEntries(
              Object.entries(state.itsaplanIssueLists).map(([key, entry]) => [
                key,
                { ...entry, issues: replaceIssue(entry.issues, updated) }
              ])
            )
          }
        })
      }
      return result
    },

    addItsaplanComment: async (issueId, body) => {
      const gen = generation
      const result = await client().addComment({ issueId, body })
      if (result.ok) {
        setIfCurrent(gen, (state) => {
          const detail = state.itsaplanIssueDetails[issueId]
          return detail
            ? {
                itsaplanIssueDetails: {
                  ...state.itsaplanIssueDetails,
                  [issueId]: { ...detail, comments: [...detail.comments, result.comment] }
                }
              }
            : {}
        })
      }
      return result
    }
  }
}
