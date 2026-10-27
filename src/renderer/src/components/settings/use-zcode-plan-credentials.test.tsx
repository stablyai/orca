// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZcodePlanCredentialsStatus } from '../../../../shared/zcode-plan-sites'
import { createZcodePlanCredentialsApi } from '../../web/preload-api/web-agent-accounts-api'
import { useZcodePlanCredentials } from './use-zcode-plan-credentials'

const mocks = vi.hoisted(() => ({ interaction: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../store', () => ({
  useAppStore: (select: (s: { recordFeatureInteraction: typeof mocks.interaction }) => unknown) =>
    select({ recordFeatureInteraction: mocks.interaction })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))
const unlinked: ZcodePlanCredentialsStatus = {
  apiKeyConfigured: false,
  zcodeCliConfigured: false,
  apiKeyProtection: null
}
const linked: ZcodePlanCredentialsStatus = {
  ...unlinked,
  apiKeyConfigured: true,
  apiKeyProtection: 'sealed'
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('GLM credential mutation refresh races', () => {
  it.each(['save', 'clear', 'failed-save', 'failed-clear'] as const)(
    'applies %s while quota changes and rereads after settling',
    async (action) => {
      let complete: ((status: ZcodePlanCredentialsStatus) => void) | undefined
      let reject: ((error: Error) => void) | undefined
      const pending = new Promise<ZcodePlanCredentialsStatus>((resolve, fail) => {
        complete = resolve
        reject = fail
      })
      const initial = action.endsWith('clear') ? linked : unlinked
      const final = action === 'save' ? linked : action === 'clear' ? unlinked : initial
      let stored = initial
      const api = {
        getStatus: vi.fn(async () => stored),
        saveApiKey: vi.fn(() => pending),
        clearApiKey: vi.fn(() => pending)
      }
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { zcodePlanCredentials: api }
      })
      const { result, rerender } = renderHook(({ time }) => useZcodePlanCredentials(time), {
        initialProps: { time: 1 }
      })
      await waitFor(() => expect(result.current.status).toEqual(initial))
      act(() => result.current.setApiKeyDraft('synthetic-key'))
      let mutation: Promise<void> | undefined
      act(() => {
        mutation = action.endsWith('clear')
          ? result.current.clearApiKey()
          : result.current.saveApiKey()
      })
      rerender({ time: 2 })
      expect(api.getStatus).toHaveBeenCalledTimes(1)
      await act(async () => {
        stored = final
        if (action.startsWith('failed')) {
          reject?.(new Error('Synthetic failure'))
        } else {
          complete?.(final)
        }
        await mutation
      })
      await waitFor(() => expect(result.current.status).toEqual(final))
      expect(api.getStatus).toHaveBeenCalledTimes(2)
      expect(result.current.credentialBusy).toBe(false)
      if (action.startsWith('failed')) {
        expect(result.current.apiKeyDraft).toBe('synthetic-key')
        expect(mocks.error).toHaveBeenCalledTimes(1)
        expect(mocks.success).not.toHaveBeenCalled()
      } else {
        expect(result.current.apiKeyDraft).toBe('')
      }
    }
  )
  it('does not claim a web save succeeded or discard the key draft', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { zcodePlanCredentials: createZcodePlanCredentialsApi() }
    })
    const { result } = renderHook(() => useZcodePlanCredentials(1))
    await waitFor(() =>
      expect(result.current.status).toEqual({ ...unlinked, detailsUnavailable: true })
    )
    act(() => result.current.setApiKeyDraft('synthetic-web-key'))
    await act(() => result.current.saveApiKey())
    expect(result.current.apiKeyDraft).toBe('synthetic-web-key')
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalled()
  })
})
