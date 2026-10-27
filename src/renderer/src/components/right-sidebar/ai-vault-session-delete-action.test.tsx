// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/ai-vault-runtime-capabilities'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useAiVaultSessionDeleteHost } from './ai-vault-session-delete-action'

const initialState = useAppStore.getState()

function publishStatus(capabilities: string[]): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only status.capabilities.
  const entry = { status: { capabilities } } as unknown as NonNullable<
    ReturnType<AppState['runtimeStatusByEnvironmentId']['get']>
  >
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['gpu-box', entry]]) })
}

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('useAiVaultSessionDeleteHost', () => {
  it('re-enables Delete on a mounted row once its host is updated in place', () => {
    publishStatus([])
    const { result } = renderHook(() =>
      useAiVaultSessionDeleteHost({ executionHostId: 'runtime:gpu-box' })
    )
    expect(result.current.deleteSupported).toBe(false)

    act(() => publishStatus([AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY]))

    expect(result.current.deleteSupported).toBe(true)
  })

  it('leaves an unprobed host to the click-time check', () => {
    const { result } = renderHook(() =>
      useAiVaultSessionDeleteHost({ executionHostId: 'runtime:gpu-box' })
    )
    expect(result.current.deleteSupported).toBeNull()
  })
})
