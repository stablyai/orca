import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  TodoistConnectResult,
  TodoistConnectionStatus
} from '../../../../../shared/todoist/todoist-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export type TodoistSlice = {
  todoistStatus: TodoistConnectionStatus
  todoistStatusChecked: boolean
  checkTodoistConnection: () => Promise<void>
  connectTodoist: (args: { apiToken: string }) => Promise<TodoistConnectResult>
  disconnectTodoist: () => Promise<void>
}

const DISCONNECTED: TodoistConnectionStatus = { connected: false, viewer: null }

// Why: a status read started before connect/disconnect settles must not overwrite its result.
let mutationGeneration = 0

// Why: Todoist runs only through the local main process, so its status does not follow runtime focus.
export const createTodoistSlice: StateCreator<AppState, [], [], TodoistSlice> = (set, get) => ({
  todoistStatus: DISCONNECTED,
  todoistStatusChecked: false,

  checkTodoistConnection: async () => {
    const generation = mutationGeneration
    let status = DISCONNECTED
    try {
      status = await window.api.todoist.status()
    } catch {
      // Why: a failed status read must still settle readiness as disconnected.
    }
    if (generation !== mutationGeneration) {
      return
    }
    set({ todoistStatus: status, todoistStatusChecked: true })
  },

  connectTodoist: async (args) => {
    try {
      const result = await window.api.todoist.connect(args)
      if (result.ok) {
        // Why: only a successful connect changes disk state; a failed one must not orphan a pending read.
        mutationGeneration += 1
        set({
          todoistStatus: { connected: true, viewer: result.viewer },
          todoistStatusChecked: true
        })
      }
      return result
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Connection failed' }
    }
  },

  disconnectTodoist: async () => {
    // Why: a failed delete leaves the token on disk; re-reading status keeps the UI truthful.
    await window.api.todoist.disconnect().catch((error: unknown) => {
      toast.error(
        translate('auto.store.slices.todoist.disconnectFailed', 'Couldn’t disconnect Todoist'),
        { description: error instanceof Error ? error.message : String(error) }
      )
    })
    mutationGeneration += 1
    await get().checkTodoistConnection()
  }
})
