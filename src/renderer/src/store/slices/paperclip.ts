import type { StateCreator } from 'zustand'
import type {
  PaperclipConnectArgs,
  PaperclipConnectionStatus,
  PaperclipIssue,
  PaperclipLaunchAdmission,
  PaperclipLaunchAdmissionRequest
} from '../../../../shared/paperclip-types'
import type { AppState } from '../types'

export type PaperclipSlice = {
  paperclipStatus: PaperclipConnectionStatus
  paperclipStatusChecked: boolean
  paperclipIssues: PaperclipIssue[]
  paperclipIssuesLoading: boolean
  paperclipError: string | null
  checkPaperclipConnection: () => Promise<void>
  connectLocalPaperclip: (
    args: Pick<PaperclipConnectArgs, 'origin' | 'companyId' | 'projectId'>
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  disconnectPaperclip: () => Promise<void>
  testPaperclipConnection: () => Promise<{ ok: true } | { ok: false; error: string }>
  loadPaperclipIssues: (query?: string) => Promise<void>
  getPaperclipLaunchAdmission: (
    request: PaperclipLaunchAdmissionRequest
  ) => Promise<PaperclipLaunchAdmission>
}

export const createPaperclipSlice: StateCreator<AppState, [], [], PaperclipSlice> = (set) => ({
  paperclipStatus: { connected: false, connection: null },
  paperclipStatusChecked: false,
  paperclipIssues: [],
  paperclipIssuesLoading: false,
  paperclipError: null,
  checkPaperclipConnection: async () => {
    try {
      const status = await window.api.paperclip.status()
      set({ paperclipStatus: status, paperclipStatusChecked: true, paperclipError: null })
    } catch (error) {
      set({
        paperclipStatus: { connected: false, connection: null },
        paperclipStatusChecked: true,
        paperclipError: error instanceof Error ? error.message : 'Paperclip status failed.'
      })
    }
  },
  connectLocalPaperclip: async (args) => {
    const result = await window.api.paperclip.connectLocalTrusted(args)
    if (!result.ok) {
      return result
    }
    set({
      paperclipStatus: { connected: true, connection: result.connection },
      paperclipStatusChecked: true,
      paperclipError: null
    })
    return { ok: true }
  },
  disconnectPaperclip: async () => {
    await window.api.paperclip.disconnect()
    set({
      paperclipStatus: { connected: false, connection: null },
      paperclipStatusChecked: true,
      paperclipIssues: [],
      paperclipError: null
    })
  },
  testPaperclipConnection: () => window.api.paperclip.testConnection(),
  loadPaperclipIssues: async (query) => {
    set({ paperclipIssuesLoading: true, paperclipError: null })
    try {
      const issues = await window.api.paperclip.listIssues(query ? { query } : undefined)
      set({ paperclipIssues: issues, paperclipIssuesLoading: false })
    } catch (error) {
      set({
        paperclipIssuesLoading: false,
        paperclipError: error instanceof Error ? error.message : 'Paperclip issue loading failed.'
      })
    }
  },
  getPaperclipLaunchAdmission: (request) => window.api.paperclip.getLaunchAdmission(request)
})
