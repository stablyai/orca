// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi, type Mock } from 'vitest'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import {
  createResumeModalFixture,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { lastToastShow } from './native-chat-resume-toast.test-support'
import {
  _resetNativeChatRestartOffer,
  getNativeChatRestartRun,
  refreshNativeChatRestartOffer,
  releaseFinishedNativeChatRestartRun
} from './native-chat-resume-on-restart-store'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import { useAppStore } from '../store'
import { chatBox, namedBox } from './native-chat-resume-on-restart-modal.test-support'

const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({
  emit: (_event: Parameters<ResumeStatusStream['emit']>[0]) => {},
  snapshot: new Map()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: ResumeStatusStream['emit']
  ) => {
    statusStream.emit = emit
    emit({ type: 'snapshot', sessions: [...statusStream.snapshot.values()] })
    return { unsubscribe: () => {} }
  }
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

const { mount, button, fakeHost, runStatus, toasts } = createResumeModalFixture(rpc, statusStream)
const dialog = () => document.querySelector('[role="dialog"]')?.textContent

async function mountSurfaces(): Promise<void> {
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
}

it.each(['status entry', 'toast Show'] as const)(
  'opens every finished result from %s after Resume closed the dialog',
  async (source) => {
    fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'), 'unknown')
    await mountSurfaces()
    await act(async () => button('Resume 2 chats').click())
    expect(dialog()).toBeUndefined()
    await act(async () =>
      source === 'status entry' ? button('1 chat failed to resume').click() : lastToastShow()?.()
    )
    expect(dialog()).toContain('Resumed 1 of 2 chats')
    expect(dialog()).toContain('All2')
    expect(dialog()).toContain('Need you1')
    expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
    expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t resume')
    expect(button('Retry')).toBeTruthy()
    expect(button('Open chat')).toBeTruthy()
    expect(button('Dismiss "Prompt b" in workspace')).toBeTruthy()
    expect(toasts()).toEqual([['1 chat couldn’t be resumed', 'Resumed 1 chat']])
  }
)

it.each(['status entry', 'toast Show'] as const)(
  'returns to the host failure offer from %s after the finished view is closed',
  async (source) => {
    fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'))
    await mountSurfaces()
    await act(async () => button('Resume 2 chats').click())
    await act(async () => button('1 chat failed to resume').click())
    expect(dialog()).toContain('Resumed 1 of 2 chats')
    await act(async () => button('Close').click())
    await act(async () =>
      source === 'status entry' ? button('1 chat failed to resume').click() : lastToastShow()?.()
    )
    expect(dialog()).toContain('Resume interrupted chats?')
    expect(dialog()).toContain('Prompt b')
    expect(dialog()).not.toContain('Prompt a')
  }
)

it('keeps the unseen summary when a view was opened and closed only during the run', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'unknown'))
  host.hold('a', 'b')
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  expect(dialog()).toContain('Resuming 2 chats')
  await act(async () => button('Close').click())
  await host.release('a', 'b')
  await act(async () => button('1 chat to check').click())
  expect(dialog()).toContain('Resumed 1 of 2 chats')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t confirm the chat was resumed')
})

it('shows the all-success summary from its toast without a status entry', async () => {
  fakeHost()
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  expect(dialog()).toBeUndefined()
  expect(document.body.textContent).not.toContain('chat')
  expect(lastToastShow()).toBeDefined()
  await act(async () => lastToastShow()?.())
  expect(dialog()).toContain('Resumed 2 of 2 chats')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
  await act(async () => button('Done').click())
  await act(async () => lastToastShow()?.())
  expect(dialog()).toBeUndefined()
})

it('replaces the finished summary when Retry starts a new run', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'), 'unknown')
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('1 chat failed to resume').click())
  host.hold('b')
  await act(async () => button('Retry').click())
  expect(dialog()).toContain('Resuming 1 chat')
  expect(dialog()).not.toContain('Prompt a')
  await host.release('b')
  expect(dialog()).toContain('Resumed 0 of 1 chat')
})

it('selects only current offers from a workspace that also contains finished run history', async () => {
  const host = fakeHost()
  await mountSurfaces()
  await act(async () => chatBox('b').click())
  await act(async () => button('Resume 1 chat').click())
  await act(async () => lastToastShow()?.())
  const workspace = namedBox('Select all chats in workspace')
  expect(workspace.closest('label')?.textContent).toContain('1 of 1')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  await act(async () => workspace.click())
  expect(chatBox('b').getAttribute('aria-checked')).toBe('false')
  await act(async () => workspace.click())
  expect(button('Resume 1 chat').disabled).toBe(false)
  host.hold('b')
  await act(async () => button('Resume 1 chat').click())
  expect(rpc.mock.calls.at(-1)?.[2]).toEqual({ sessionIds: ['b'] })
  await host.release('b')
})

it('does not consume a finished run if its requested view never rendered', async () => {
  fakeHost()
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => {
    requestNativeChatResumeOnRestartDialog()
    consumeNativeChatResumeOnRestartDialogRequest()
    releaseFinishedNativeChatRestartRun()
  })
  expect(dialog()).toBeUndefined()
  await act(async () => lastToastShow()?.())
  expect(dialog()).toContain('Resumed 2 of 2 chats')
})

it('keeps the run out of settings and storage and loses it on a fresh renderer store', async () => {
  fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'))
  await mountSurfaces()
  const settings = useAppStore.getState().settings
  const saveSettings = vi.fn(async () => {})
  useAppStore.setState({ updateSettings: saveSettings })
  const storage = vi.spyOn(Storage.prototype, 'setItem')
  try {
    await act(async () => button('Resume 2 chats').click())
    expect(saveSettings).not.toHaveBeenCalled()
    expect(useAppStore.getState().settings).toBe(settings)
    expect(storage).not.toHaveBeenCalled()
    await mount(null)
    _resetNativeChatRestartOffer()
    expect(getNativeChatRestartRun()).toBeNull()
    await refreshNativeChatRestartOffer()
    await mountSurfaces()
    await act(async () => button('1 chat failed to resume').click())
    expect(dialog()).toContain('Resume interrupted chats?')
    expect(dialog()).not.toContain('Prompt a')
  } finally {
    storage.mockRestore()
  }
})
