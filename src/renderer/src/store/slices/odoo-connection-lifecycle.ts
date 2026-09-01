// Connection lifecycle actions for the Odoo slice: status polling, connect,
// test, instance selection, and disconnect. Split from odoo.ts so each file
// owns one concern (reads vs. connection state).
import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import type { OdooConnectionStatus } from '../../../../shared/odoo-types'
// Type-only import: erased at compile time, so no runtime cycle with odoo.ts.
import type { OdooSlice } from './odoo'
import {
  odooConnect,
  odooDisconnect,
  odooSelectInstance,
  odooStatus,
  odooTestConnection
} from '@/runtime/runtime-odoo-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import {
  beginOdooMutation,
  beginOdooStatusRead,
  currentOdooMutationGeneration,
  getSelectedOdooInstanceId,
  isCurrentOdooMutation,
  isCurrentOdooRuntimeContext,
  isCurrentOdooStatusRead
} from './odoo-read-coordination'

type OdooLifecycleDeps = {
  set: StoreApi<AppState>['setState']
  get: StoreApi<AppState>['getState']
  clearInflight: () => void
}

type OdooConnectionLifecycle = Pick<
  OdooSlice,
  | 'checkOdooConnection'
  | 'connectOdoo'
  | 'testOdooConnection'
  | 'selectOdooInstance'
  | 'disconnectOdoo'
>

const disconnectedStatus = (): OdooConnectionStatus => ({ connected: false, viewer: null })

// Why: an instance rename, a moved server URL, or a re-auth leaves the row
// count untouched, so comparing lengths would keep Settings on stale rows.
const instanceSignature = (status: OdooConnectionStatus): string =>
  JSON.stringify(
    (status.instances ?? []).map((instance) => [
      instance.id,
      instance.serverUrl,
      instance.database,
      instance.login,
      instance.uid,
      instance.displayName
    ])
  )

export function createOdooConnectionLifecycle({
  set,
  get,
  clearInflight
}: OdooLifecycleDeps): OdooConnectionLifecycle {
  return {
    checkOdooConnection: async () => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const statusReadGeneration = beginOdooStatusRead()
      const mutationGeneration = currentOdooMutationGeneration()
      if (get().odooStatusContextKey !== contextKey) {
        set({ odooStatusChecked: false })
      }
      const isStale = (): boolean =>
        !isCurrentOdooMutation(mutationGeneration) ||
        !isCurrentOdooStatusRead(statusReadGeneration) ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      try {
        const status = await odooStatus(get().settings)
        if (isStale()) {
          return
        }
        const prev = get().odooStatus
        if (
          prev.connected !== status.connected ||
          prev.credentialError !== status.credentialError ||
          prev.viewer?.login !== status.viewer?.login ||
          getSelectedOdooInstanceId(prev) !== getSelectedOdooInstanceId(status) ||
          instanceSignature(prev) !== instanceSignature(status)
        ) {
          set({ odooStatus: status, odooStatusChecked: true, odooStatusContextKey: contextKey })
        } else if (!get().odooStatusChecked || get().odooStatusContextKey !== contextKey) {
          set({ odooStatusChecked: true, odooStatusContextKey: contextKey })
        }
      } catch {
        if (isStale()) {
          return
        }
        if (get().odooStatus.connected) {
          set({
            odooStatus: disconnectedStatus(),
            odooStatusChecked: true,
            odooStatusContextKey: contextKey
          })
        } else if (!get().odooStatusChecked || get().odooStatusContextKey !== contextKey) {
          set({ odooStatusChecked: true, odooStatusContextKey: contextKey })
        }
      }
    },

    connectOdoo: async (args) => {
      const requestGeneration = beginOdooMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await odooConnect(get().settings, args)
        if (
          result.ok &&
          isCurrentOdooMutation(requestGeneration) &&
          isCurrentOdooRuntimeContext(contextKey, get().settings)
        ) {
          set({
            odooStatus: { connected: true, viewer: result.viewer },
            odooStatusChecked: true,
            odooStatusContextKey: contextKey
          })
          void get().checkOdooConnection()
        } else if (result.ok) {
          return {
            ok: false as const,
            error: translate(
              'auto.store.slices.odoo.superseded',
              'Odoo connection was superseded by a newer request.'
            )
          }
        }
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection failed'
        return { ok: false as const, error: message }
      }
    },

    testOdooConnection: async (instanceId) => {
      const requestGeneration = beginOdooMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await odooTestConnection(get().settings, instanceId)
        if (
          !isCurrentOdooMutation(requestGeneration) ||
          !isCurrentOdooRuntimeContext(contextKey, get().settings)
        ) {
          return result
        }
        const status = await odooStatus(get().settings)
        if (
          isCurrentOdooMutation(requestGeneration) &&
          isCurrentOdooRuntimeContext(contextKey, get().settings)
        ) {
          set({ odooStatus: status, odooStatusChecked: true, odooStatusContextKey: contextKey })
        }
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Test failed'
        return { ok: false as const, error: message }
      }
    },

    selectOdooInstance: async (instanceId) => {
      const requestGeneration = beginOdooMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const status = await odooSelectInstance(get().settings, instanceId)
      if (
        !isCurrentOdooMutation(requestGeneration) ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      ) {
        return
      }
      clearInflight()
      set({
        odooStatus: status,
        odooTicketCache: {},
        odooTicketListCache: {},
        odooStatusChecked: true,
        odooStatusContextKey: contextKey
      })
    },

    disconnectOdoo: async (instanceId) => {
      const requestGeneration = beginOdooMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      await odooDisconnect(get().settings, instanceId)
      if (
        !isCurrentOdooMutation(requestGeneration) ||
        !isCurrentOdooRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      clearInflight()
      const status = await odooStatus(get().settings)
      if (
        !isCurrentOdooMutation(requestGeneration) ||
        !isCurrentOdooRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      set({
        odooStatus: status.connected ? status : disconnectedStatus(),
        odooTicketCache: {},
        odooTicketListCache: {},
        odooStatusChecked: true,
        odooStatusContextKey: contextKey
      })
    }
  }
}
