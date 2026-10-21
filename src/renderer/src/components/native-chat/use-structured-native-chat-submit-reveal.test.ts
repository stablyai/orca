// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useNativeChatHostPermissionGate } from './use-native-chat-host-permission-gate'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
import { useStructuredNativeChatSubmitReveal } from './use-structured-native-chat-submit-reveal'

const permission = vi.hoisted(() => ({ capability: vi.fn(), settings: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: permission.capability,
  callRuntimeRpc: permission.settings
}))

it('reveals before launch Retry, but waits for a successful queue Resume', async () => {
  const order: string[] = []
  const controller = {
    respond: vi.fn(async () => null),
    queuedMessages: {
      queueCapable: true,
      clearCapable: true,
      cards: [],
      pause: null,
      clear: vi.fn(async () => true),
      queuePending: null,
      pending: () => null,
      resume: vi.fn(async () => {
        order.push('resume')
        return true
      }),
      steer: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      edit: vi.fn(async () => {}),
      editCapable: false,
      editor: undefined,
      steerNewest: vi.fn(() => false)
    }
  }
  const retryLaunch = (): number => order.push('launch')
  const { result } = renderHook(() => useStructuredNativeChatSubmitReveal(controller, retryLaunch))
  result.current.messageListRef.current = {
    revealLatest: () => order.push('reveal'),
    revealFindMatch: () => {},
    messageCopyText: () => null
  }

  act(() => result.current.retryLaunch())
  await act(() => result.current.queuedMessages.resume())

  expect(order).toEqual(['reveal', 'launch', 'resume', 'reveal'])
})

// STA-10671: an older host held for its permission mode would run a queued card unprompted.
it('sends no queued card and retries no start on a host held for its permission mode', async () => {
  const queuedMessages = {
    queueCapable: true,
    clearCapable: true,
    cards: [],
    pause: { reason: 'stopped' },
    queuePending: null,
    pending: () => null,
    clear: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    steer: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    editCapable: false,
    editor: undefined,
    steerNewest: vi.fn(() => true)
  }
  const controller = { respond: vi.fn(async () => null), queuedMessages }
  const retryLaunch = vi.fn()
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, nativeChatPermissionMode: 'ask' }
  })
  permission.capability.mockResolvedValue(false)
  permission.settings.mockRejectedValue(new Error('unreachable'))
  const { result } = renderHook(() => {
    const gate = useNativeChatHostPermissionGate(
      { kind: 'environment', environmentId: 'server' },
      'claude',
      'Claude'
    )
    const reveal = useStructuredNativeChatSubmitReveal(
      controller,
      retryLaunch,
      gate.sendBlockedReason !== null
    )
    return {
      ...reveal,
      publishedNotices: structuredSessionNotices({
        launch: { lifecycle: 'published', failure: null, retry: reveal.retryLaunch },
        agentLabel: 'Claude',
        sessionError: null,
        composerError: null,
        hostPermission: gate.notice
      }),
      notices: structuredSessionNotices({
        launch: { lifecycle: 'failed', failure: null, retry: reveal.retryLaunch },
        agentLabel: 'Claude',
        sessionError: null,
        composerError: null,
        hostPermission: gate.notice
      })
    }
  })
  await vi.waitFor(() => expect(result.current.notices[0]?.action?.label).toBe('Check again'))

  expect(result.current.publishedNotices[0]).toMatchObject({
    text: "Orca couldn't confirm the host's permissions for Claude.",
    action: { label: 'Check again' }
  })
  await act(() => result.current.queuedMessages.resume())
  await act(() => result.current.queuedMessages.steer('m1'))
  expect(result.current.queuedMessages.steerNewest()).toBe(false)
  expect(queuedMessages.resume).not.toHaveBeenCalled()
  expect(queuedMessages.steer).not.toHaveBeenCalled()
  expect(queuedMessages.steerNewest).not.toHaveBeenCalled()
  act(() => result.current.retryLaunch())
  expect(retryLaunch).not.toHaveBeenCalled()
  let allow!: (allowed: boolean) => void
  permission.capability.mockReturnValue(
    new Promise<boolean>((resolve) => {
      allow = resolve
    })
  )
  act(() => result.current.notices[0]?.action?.onClick())
  expect(result.current.notices[0]?.action?.label).toBe('Check again')
  expect(retryLaunch).not.toHaveBeenCalled()
  await act(async () => allow(true))
  expect(result.current.notices[0]?.action?.label).toBe('Retry')
  act(() => result.current.notices[0]?.action?.onClick())
  expect(retryLaunch).toHaveBeenCalledOnce()
})
