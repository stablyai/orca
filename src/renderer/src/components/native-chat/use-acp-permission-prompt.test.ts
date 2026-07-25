// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAcpPermissionPrompt, type AcpPermissionApi } from './use-acp-permission-prompt'
import type { NativeChatAcpPermissionPrompt } from '@/../../preload/api-types'

function createApi() {
  let listener: ((prompt: NativeChatAcpPermissionPrompt) => void) | undefined
  const respondAcpPermission = vi.fn().mockResolvedValue(true)
  const unsubscribe = vi.fn()
  const api: AcpPermissionApi = {
    onAcpPermissionRequested: (fn) => {
      listener = fn
      return unsubscribe
    },
    respondAcpPermission
  }
  return {
    api,
    respondAcpPermission,
    unsubscribe,
    emit: (prompt: NativeChatAcpPermissionPrompt) => act(() => listener?.(prompt))
  }
}

const PROMPT: NativeChatAcpPermissionPrompt = {
  requestId: 'req-1',
  subscriptionId: 'sub-1',
  title: 'Run shell command',
  detail: 'rm -rf build',
  options: [
    { label: 'Allow once', send: 'once' },
    { label: 'Reject', send: 'rej' }
  ]
}

describe('useAcpPermissionPrompt', () => {
  it('exposes the prompt as an approval for the card', () => {
    const { api, emit } = createApi()
    const { result } = renderHook(() => useAcpPermissionPrompt('sub-1', api))
    expect(result.current.approval).toBeNull()

    emit(PROMPT)
    expect(result.current.approval).toEqual({
      title: 'Run shell command',
      detail: 'rm -rf build',
      options: PROMPT.options
    })
  })

  it('answers with the chosen ACP optionId and clears the card', () => {
    const { api, emit, respondAcpPermission } = createApi()
    const { result } = renderHook(() => useAcpPermissionPrompt('sub-1', api))
    emit(PROMPT)

    act(() => result.current.choose('once'))
    expect(respondAcpPermission).toHaveBeenCalledWith('req-1', 'once')
    expect(result.current.approval).toBeNull()
  })

  it('treats dismissal as an explicit cancel', () => {
    const { api, emit, respondAcpPermission } = createApi()
    const { result } = renderHook(() => useAcpPermissionPrompt('sub-1', api))
    emit(PROMPT)

    act(() => result.current.dismiss())
    expect(respondAcpPermission).toHaveBeenCalledWith('req-1', null)
  })

  it('ignores prompts belonging to another subscription', () => {
    const { api, emit } = createApi()
    const { result } = renderHook(() => useAcpPermissionPrompt('sub-1', api))
    emit({ ...PROMPT, subscriptionId: 'other' })
    expect(result.current.approval).toBeNull()
  })

  it('answers a request only once even on a double click', () => {
    const { api, emit, respondAcpPermission } = createApi()
    const { result } = renderHook(() => useAcpPermissionPrompt('sub-1', api))
    emit(PROMPT)

    act(() => {
      result.current.choose('once')
      result.current.choose('rej')
    })
    expect(respondAcpPermission).toHaveBeenCalledTimes(1)
    expect(respondAcpPermission).toHaveBeenCalledWith('req-1', 'once')
  })

  it('cancels an open prompt on unmount so the agent is never stranded', () => {
    const { api, emit, respondAcpPermission } = createApi()
    const { result, unmount } = renderHook(() => useAcpPermissionPrompt('sub-1', api))
    emit(PROMPT)
    expect(result.current.approval).not.toBeNull()

    unmount()
    expect(respondAcpPermission).toHaveBeenCalledWith('req-1', null)
  })

  it('does not answer on unmount when nothing is pending', () => {
    const { api, respondAcpPermission } = createApi()
    const { unmount } = renderHook(() => useAcpPermissionPrompt('sub-1', api))
    unmount()
    expect(respondAcpPermission).not.toHaveBeenCalled()
  })

  it('unsubscribes from the push channel on unmount', () => {
    const { api, unsubscribe } = createApi()
    const { unmount } = renderHook(() => useAcpPermissionPrompt('sub-1', api))
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('is inert without an api or a subscription', () => {
    const { api } = createApi()
    expect(renderHook(() => useAcpPermissionPrompt(null, api)).result.current.approval).toBeNull()
    expect(renderHook(() => useAcpPermissionPrompt('sub-1', null)).result.current.approval).toBeNull()
  })

  it('replaces an earlier prompt when a second arrives', () => {
    const { api, emit } = createApi()
    const { result } = renderHook(() => useAcpPermissionPrompt('sub-1', api))
    emit(PROMPT)
    emit({ ...PROMPT, requestId: 'req-2', title: 'Edit file' })
    expect(result.current.approval?.title).toBe('Edit file')
  })
})
