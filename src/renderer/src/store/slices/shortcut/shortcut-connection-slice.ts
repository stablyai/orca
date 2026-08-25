import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  ShortcutConnectionStatus,
  ShortcutViewer,
  ShortcutWorkspaceSelection
} from '../../../../../shared/shortcut-types'
import {
  shortcutConnect,
  shortcutDisconnect,
  shortcutReadStatus,
  shortcutSelectWorkspace,
  shortcutStatus,
  shortcutTestConnection
} from '@/runtime/runtime-shortcut-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import {
  beginShortcutMutation,
  clearShortcutInflight,
  currentShortcutMutationGeneration,
  currentShortcutStatusReadGeneration,
  getSelectedWorkspaceId,
  isCurrentShortcutMutation,
  isCurrentShortcutRuntimeContext,
  nextShortcutConnectionRevisions,
  nextShortcutStatusReadGeneration
} from './shortcut-read-scope'
import type { ShortcutStoryReadSlice } from './shortcut-story-slice'

export const EMPTY_SHORTCUT_READ_CACHES = {
  shortcutStoryCache: {},
  shortcutSearchCache: {}
} satisfies Partial<ShortcutStoryReadSlice>

/** Status write that also bumps the revision watchers use to re-read a lazily-loaded status. */
export function shortcutStatusUpdate(
  state: AppState,
  contextKey: string,
  status: ShortcutConnectionStatus,
  extra?: Partial<ShortcutConnectionSlice & ShortcutStoryReadSlice>
): Partial<ShortcutConnectionSlice & ShortcutStoryReadSlice> {
  return {
    shortcutStatus: status,
    shortcutStatusChecked: true,
    shortcutStatusContextKey: contextKey,
    shortcutConnectionRevisions: nextShortcutConnectionRevisions(
      state.shortcutConnectionRevisions,
      contextKey
    ),
    ...extra
  }
}

export type ShortcutConnectionSlice = {
  shortcutStatus: ShortcutConnectionStatus
  shortcutStatusChecked: boolean
  shortcutStatusContextKey: string | null
  shortcutConnectionRevisions: Record<string, number>

  checkShortcutConnection: () => Promise<void>
  readShortcutStatus: (sourceContext: TaskSourceContext) => Promise<ShortcutConnectionStatus>
  connectShortcut: (args: {
    apiToken: string
  }) => Promise<{ ok: true; viewer: ShortcutViewer } | { ok: false; error: string }>
  testShortcutConnection: (
    workspaceId?: string | null
  ) => Promise<{ ok: true; viewer: ShortcutViewer } | { ok: false; error: string }>
  selectShortcutWorkspace: (workspaceId: ShortcutWorkspaceSelection) => Promise<void>
  disconnectShortcut: (workspaceId?: string | null) => Promise<void>
}

export const createShortcutConnectionSlice: StateCreator<
  AppState,
  [],
  [],
  ShortcutConnectionSlice
> = (set, get) => ({
  shortcutStatus: { connected: false, viewer: null },
  shortcutStatusChecked: false,
  shortcutStatusContextKey: null,
  shortcutConnectionRevisions: {},

  checkShortcutConnection: async () => {
    const contextKey = getProviderRuntimeContextKey(get().settings)
    const statusReadGeneration = nextShortcutStatusReadGeneration()
    const mutationGeneration = currentShortcutMutationGeneration()
    if (get().shortcutStatusContextKey !== contextKey) {
      set({ shortcutStatusChecked: false })
    }
    const isStale = (): boolean =>
      mutationGeneration !== currentShortcutMutationGeneration() ||
      statusReadGeneration !== currentShortcutStatusReadGeneration() ||
      getProviderRuntimeContextKey(get().settings) !== contextKey
    try {
      const status = await shortcutStatus(get().settings)
      if (isStale()) {
        return
      }
      const prev = get().shortcutStatus
      if (
        prev.connected !== status.connected ||
        prev.credentialError !== status.credentialError ||
        prev.viewer?.id !== status.viewer?.id ||
        getSelectedWorkspaceId(prev) !== getSelectedWorkspaceId(status) ||
        (prev.workspaces?.length ?? 0) !== (status.workspaces?.length ?? 0)
      ) {
        set((state) => shortcutStatusUpdate(state, contextKey, status))
      } else if (!get().shortcutStatusChecked) {
        set({ shortcutStatusChecked: true, shortcutStatusContextKey: contextKey })
      } else if (get().shortcutStatusContextKey !== contextKey) {
        set({ shortcutStatusContextKey: contextKey })
      }
    } catch {
      if (isStale()) {
        return
      }
      if (get().shortcutStatus.connected) {
        set((state) => shortcutStatusUpdate(state, contextKey, { connected: false, viewer: null }))
      } else if (!get().shortcutStatusChecked) {
        set({ shortcutStatusChecked: true, shortcutStatusContextKey: contextKey })
      } else if (get().shortcutStatusContextKey !== contextKey) {
        set({ shortcutStatusContextKey: contextKey })
      }
    }
  },

  readShortcutStatus: async (sourceContext) => shortcutReadStatus(sourceContext),

  connectShortcut: async (args) => {
    const requestGeneration = beginShortcutMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    try {
      const result = await shortcutConnect(get().settings, args)
      if (
        result.ok &&
        isCurrentShortcutMutation(requestGeneration) &&
        isCurrentShortcutRuntimeContext(contextKey, get().settings)
      ) {
        set((state) =>
          shortcutStatusUpdate(state, contextKey, { connected: true, viewer: result.viewer })
        )
        void get().checkShortcutConnection()
      } else if (result.ok) {
        return {
          ok: false as const,
          error: translate(
            'auto.store.slices.shortcut.superseded',
            'Shortcut connection was superseded by a newer request.'
          )
        }
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false as const, error: message }
    }
  },

  testShortcutConnection: async (workspaceId) => {
    const requestGeneration = beginShortcutMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    try {
      const result = await shortcutTestConnection(get().settings, workspaceId)
      if (
        !isCurrentShortcutMutation(requestGeneration) ||
        !isCurrentShortcutRuntimeContext(contextKey, get().settings)
      ) {
        return result
      }
      const status = await shortcutStatus(get().settings)
      if (
        isCurrentShortcutMutation(requestGeneration) &&
        isCurrentShortcutRuntimeContext(contextKey, get().settings)
      ) {
        set((state) => shortcutStatusUpdate(state, contextKey, status))
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed'
      return { ok: false as const, error: message }
    }
  },

  selectShortcutWorkspace: async (workspaceId) => {
    const requestGeneration = beginShortcutMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    const status = await shortcutSelectWorkspace(get().settings, workspaceId)
    if (
      !isCurrentShortcutMutation(requestGeneration) ||
      getProviderRuntimeContextKey(get().settings) !== contextKey
    ) {
      return
    }
    clearShortcutInflight()
    set((state) => shortcutStatusUpdate(state, contextKey, status, EMPTY_SHORTCUT_READ_CACHES))
  },

  disconnectShortcut: async (workspaceId) => {
    const requestGeneration = beginShortcutMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    await shortcutDisconnect(get().settings, workspaceId)
    if (
      !isCurrentShortcutMutation(requestGeneration) ||
      !isCurrentShortcutRuntimeContext(contextKey, get().settings)
    ) {
      return
    }
    clearShortcutInflight()
    const status = await shortcutStatus(get().settings)
    if (
      !isCurrentShortcutMutation(requestGeneration) ||
      !isCurrentShortcutRuntimeContext(contextKey, get().settings)
    ) {
      return
    }
    set((state) =>
      shortcutStatusUpdate(
        state,
        contextKey,
        status.connected ? status : { connected: false, viewer: null },
        EMPTY_SHORTCUT_READ_CACHES
      )
    )
  }
})
