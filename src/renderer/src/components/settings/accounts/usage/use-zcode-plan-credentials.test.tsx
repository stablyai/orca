// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZcodePlanCredentialsStatus } from '../../../../../../shared/zcode-plan-sites'
import { createZcodePlanCredentialsApi } from '../../../../web/preload-api/web-agent-accounts-api'
import { useZcodePlanCredentials } from './use-zcode-plan-credentials'

const mocks = vi.hoisted(() => ({ interaction: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../../../store/index', () => ({
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('GLM credential mutation refresh races', () => {
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
