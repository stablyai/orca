import {
  jiraConnect,
  jiraDisconnect,
  jiraReadStatus,
  jiraSelectSite,
  jiraStatus,
  jiraTestConnection
} from '@/runtime/runtime-jira-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import type { JiraSlice, JiraSliceGet, JiraSliceSet } from './jira-slice-contract'
import {
  beginJiraMutation,
  clearJiraInflightRequests,
  currentJiraMutationGeneration,
  EMPTY_JIRA_READ_CACHES,
  getSelectedJiraSiteId,
  isCurrentJiraMutation,
  isCurrentJiraRuntimeContext,
  isCurrentJiraStatusRead,
  jiraStatusUpdate,
  nextJiraStatusReadGeneration
} from './jira-read-coordination'

type JiraConnectionActions = Pick<
  JiraSlice,
  | 'checkJiraConnection'
  | 'readJiraStatus'
  | 'connectJira'
  | 'testJiraConnection'
  | 'selectJiraSite'
  | 'disconnectJira'
>

function hasJiraStatusChanged(
  previous: JiraSlice['jiraStatus'],
  next: JiraSlice['jiraStatus']
): boolean {
  return (
    previous.connected !== next.connected ||
    previous.credentialError !== next.credentialError ||
    previous.viewer?.email !== next.viewer?.email ||
    getSelectedJiraSiteId(previous) !== getSelectedJiraSiteId(next) ||
    (previous.sites?.length ?? 0) !== (next.sites?.length ?? 0)
  )
}

export function createJiraConnectionActions(
  set: JiraSliceSet,
  get: JiraSliceGet
): JiraConnectionActions {
  return {
    checkJiraConnection: async () => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const statusReadGeneration = nextJiraStatusReadGeneration()
      const mutationGeneration = currentJiraMutationGeneration()
      if (get().jiraStatusContextKey !== contextKey) {
        set({ jiraStatusChecked: false })
      }
      try {
        const status = await jiraStatus(get().settings)
        if (
          mutationGeneration !== currentJiraMutationGeneration() ||
          !isCurrentJiraStatusRead(statusReadGeneration) ||
          getProviderRuntimeContextKey(get().settings) !== contextKey
        ) {
          return
        }
        const previous = get().jiraStatus
        if (hasJiraStatusChanged(previous, status)) {
          set((state) => jiraStatusUpdate(state, contextKey, status))
        } else if (!get().jiraStatusChecked) {
          set({ jiraStatusChecked: true, jiraStatusContextKey: contextKey })
        } else if (get().jiraStatusContextKey !== contextKey) {
          set({ jiraStatusContextKey: contextKey })
        }
      } catch {
        if (
          mutationGeneration !== currentJiraMutationGeneration() ||
          !isCurrentJiraStatusRead(statusReadGeneration) ||
          getProviderRuntimeContextKey(get().settings) !== contextKey
        ) {
          return
        }
        if (get().jiraStatus.connected) {
          set((state) => jiraStatusUpdate(state, contextKey, { connected: false, viewer: null }))
        } else if (!get().jiraStatusChecked) {
          set({ jiraStatusChecked: true, jiraStatusContextKey: contextKey })
        } else if (get().jiraStatusContextKey !== contextKey) {
          set({ jiraStatusContextKey: contextKey })
        }
      }
    },

    readJiraStatus: async (sourceContext) => jiraReadStatus(sourceContext),

    connectJira: async (args) => {
      const requestGeneration = beginJiraMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await jiraConnect(get().settings, args)
        if (
          result.ok &&
          isCurrentJiraMutation(requestGeneration) &&
          isCurrentJiraRuntimeContext(contextKey, get().settings)
        ) {
          set((state) =>
            jiraStatusUpdate(state, contextKey, { connected: true, viewer: result.viewer })
          )
          void get().checkJiraConnection()
        } else if (result.ok) {
          return {
            ok: false as const,
            error: translate(
              'auto.store.slices.jira.856083302c',
              'Jira connection was superseded by a newer request.'
            )
          }
        }
        return result
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : 'Connection failed'
        }
      }
    },

    testJiraConnection: async (siteId) => {
      const requestGeneration = beginJiraMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await jiraTestConnection(get().settings, siteId)
        if (
          !isCurrentJiraMutation(requestGeneration) ||
          !isCurrentJiraRuntimeContext(contextKey, get().settings)
        ) {
          return result
        }
        const status = await jiraStatus(get().settings)
        if (
          isCurrentJiraMutation(requestGeneration) &&
          isCurrentJiraRuntimeContext(contextKey, get().settings)
        ) {
          set((state) => jiraStatusUpdate(state, contextKey, status))
        }
        return result
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : 'Test failed' }
      }
    },

    selectJiraSite: async (siteId) => {
      const requestGeneration = beginJiraMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const status = await jiraSelectSite(get().settings, siteId)
      if (
        !isCurrentJiraMutation(requestGeneration) ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      ) {
        return
      }
      clearJiraInflightRequests()
      set((state) => jiraStatusUpdate(state, contextKey, status, EMPTY_JIRA_READ_CACHES))
    },

    disconnectJira: async (siteId) => {
      const requestGeneration = beginJiraMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      await jiraDisconnect(get().settings, siteId)
      if (
        !isCurrentJiraMutation(requestGeneration) ||
        !isCurrentJiraRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      clearJiraInflightRequests()
      const status = await jiraStatus(get().settings)
      if (
        !isCurrentJiraMutation(requestGeneration) ||
        !isCurrentJiraRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      set((state) =>
        jiraStatusUpdate(
          state,
          contextKey,
          status.connected ? status : { connected: false, viewer: null },
          EMPTY_JIRA_READ_CACHES
        )
      )
    }
  }
}
