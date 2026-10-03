import { create } from 'zustand'
import { translate } from '@/i18n/i18n'
import { clearYouTrackProjectFieldsCache } from './use-youtrack-project-fields'
import type {
  YouTrackConnectionStatus,
  YouTrackConnectResult,
  YouTrackIssue,
  YouTrackIssuePreset
} from '../../../../shared/youtrack-types'

const DISCONNECTED: YouTrackConnectionStatus = { connected: false, baseUrl: null, viewer: null }

type YouTrackStore = {
  status: YouTrackConnectionStatus
  statusChecked: boolean
  preset: YouTrackIssuePreset
  /** Committed custom query; empty means the preset drives the list. */
  query: string
  issues: YouTrackIssue[]
  issuesLoading: boolean
  issuesError: string | null
  /** Key of the request whose result `issues` holds, so tab switches reuse it. */
  issuesKey: string | null
  selectedIssueId: string | null
  checkStatus: () => Promise<YouTrackConnectionStatus>
  connect: (
    baseUrl: string,
    token: string,
    allowInsecureTls: boolean
  ) => Promise<YouTrackConnectResult>
  disconnect: () => Promise<void>
  setPreset: (preset: YouTrackIssuePreset) => void
  setQuery: (query: string) => void
  loadIssues: (options?: { force?: boolean }) => Promise<void>
  selectIssue: (idReadable: string | null) => void
  replaceIssue: (issue: YouTrackIssue) => void
  /** Shows a just-created issue at the top until the next refresh. */
  addIssue: (issue: YouTrackIssue) => void
}

function youtrackApi() {
  return window.api?.youtrack ?? null
}

let latestLoadToken = 0

export const useYouTrackStore = create<YouTrackStore>((set, get) => ({
  status: DISCONNECTED,
  statusChecked: false,
  preset: 'assigned',
  query: '',
  issues: [],
  issuesLoading: false,
  issuesError: null,
  issuesKey: null,
  selectedIssueId: null,

  checkStatus: async () => {
    const api = youtrackApi()
    const status = api ? await api.status().catch(() => DISCONNECTED) : DISCONNECTED
    set({ status, statusChecked: true })
    return status
  },

  connect: async (baseUrl, token, allowInsecureTls) => {
    const api = youtrackApi()
    if (!api) {
      return {
        ok: false,
        error: translate(
          'youtrack.store.desktopOnly',
          'YouTrack is only available in the desktop app.'
        )
      }
    }
    const result = await api.connect({ baseUrl, token, allowInsecureTls })
    if (result.ok) {
      // Why: project ids like "0-12" repeat across instances, so schemas can't outlive the site.
      clearYouTrackProjectFieldsCache()
      // Why: an in-flight load belongs to the previous connection; its token must go stale.
      latestLoadToken += 1
      set({ issues: [], issuesKey: null, issuesError: null, issuesLoading: false })
      await get().checkStatus()
    }
    return result
  },

  disconnect: async () => {
    await youtrackApi()?.disconnect()
    clearYouTrackProjectFieldsCache()
    latestLoadToken += 1
    set({
      status: DISCONNECTED,
      issues: [],
      issuesKey: null,
      issuesError: null,
      selectedIssueId: null
    })
  },

  setPreset: (preset) => set({ preset, query: '' }),

  setQuery: (query) => set({ query: query.trim() }),

  loadIssues: async (options) => {
    const api = youtrackApi()
    const { preset, query, issuesKey, status } = get()
    if (!api || !status.connected) {
      return
    }
    const key = `${status.baseUrl}|${preset}|${query}`
    if (!options?.force && issuesKey === key) {
      return
    }
    const token = ++latestLoadToken
    set({ issuesLoading: true, issuesError: null })
    const result = await api
      .listIssues({ preset, query: query || undefined, limit: 100 })
      .catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : 'Failed to load YouTrack issues.'
      }))
    // Why: a slower earlier request must not overwrite results for the current filter.
    if (token !== latestLoadToken) {
      return
    }
    set(
      result.ok
        ? { issues: result.issues, issuesKey: key, issuesLoading: false }
        : { issuesError: result.error, issuesKey: key, issuesLoading: false }
    )
  },

  selectIssue: (idReadable) => set({ selectedIssueId: idReadable }),

  replaceIssue: (issue) =>
    set((state) => ({
      issues: state.issues.map((entry) => (entry.idReadable === issue.idReadable ? issue : entry))
    })),

  addIssue: (issue) =>
    set((state) => ({
      issues: [issue, ...state.issues.filter((entry) => entry.idReadable !== issue.idReadable)]
    }))
}))
