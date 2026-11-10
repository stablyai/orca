// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi, type Mock } from 'vitest'
import { NativeChatResumeOnRestartModal } from '../NativeChatResumeRuntimeModal'
import { NativeChatResumeStatusSegment } from '../../status-bar/NativeChatResumeStatusSegment'
import {
  createResumeModalFixture,
  failure,
  offered,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { lastToastShow } from './native-chat-resume-toast.test-support'
import {
  getNativeChatRestartRun,
  refreshNativeChatRestartOffer,
  releaseFinishedNativeChatRestartRun
} from '../offers/native-chat-resume-on-restart-store'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from '../dialogs/native-chat-resume-on-restart-dialog'

import { chatBox, namedBox } from './native-chat-resume-on-restart-modal.test-support'

const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({
  emit: (_event: Parameters<ResumeStatusStream['emit']>[0]) => {},
  snapshot: new Map()
}))
vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: rpc
}))

vi.mock('../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: ResumeStatusStream['emit']
  ) => {
    statusStream.emit = emit
    emit({ type: 'snapshot', sessions: [...statusStream.snapshot.values()] })
    return { unsubscribe: () => {} }
  }
}))
vi.mock('sonner', async () =>
  (await import('./native-chat-resume-sonner-mock.test-support')).resumeSonnerMock()
)

const { mount, button, fakeHost, runStatus } = createResumeModalFixture(rpc, statusStream)
const dialog = () => document.querySelector('[role="dialog"]')?.textContent

async function mountSurfaces(): Promise<void> {
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
}

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

it('adds no resumed entry for a run watched to the end in the dialog', async () => {
  const host = fakeHost()
  host.hold('a', 'b')
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  await host.release('a', 'b')
  expect(dialog()).toContain('Resumed 2 of 2 chats')
  await act(async () => button('Done').click())
  expect(document.body.textContent).not.toContain('chat')
})

it('keeps a new successful run visible beside an older host failure', async () => {
  fakeHost({ sessions: [offered[0]!], failed: [failure('b')] })
  await mountSurfaces()
  await act(async () => button('Resume 1 chat').click())
  expect(button('1 chat failed to resume')).toBeTruthy()
  expect(button('1 chat resumed')).toBeTruthy()
  await act(async () => button('1 chat resumed').click())
  expect(dialog()).toContain('Resumed 1 of 1 chat')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
})

it('does not claim a mixed run succeeded when a host reread fails', async () => {
  fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  rpc.mockImplementationOnce(async () => {
    throw new Error('host unavailable')
  })
  await act(async () => refreshNativeChatRestartOffer())
  expect(getNativeChatRestartRun()?.entries).toHaveLength(2)
  expect(document.body.textContent).not.toContain('chat resumed')
  await act(async () => lastToastShow()?.())
  expect(dialog()).toContain('Resumed 1 of 2 chats')
})

it('shows finished rows after resetting an in-flight filter and keeps later filter actions', async () => {
  const host = fakeHost()
  host.hold('a', 'b')
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  await act(async () => button('In progress2').click())
  await host.release('a', 'b')
  expect(dialog()).toContain('Resumed 2 of 2 chats')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
  await act(async () => button('In progress0').click())
  expect(runStatus('Prompt a')).toBeNull()
  await act(async () => button('All2').click())
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  await act(async () => button('Done').click())
  expect(getNativeChatRestartRun()).toBeNull()
})

it('expands a group collapsed during a run before retiring the finished result', async () => {
  const host = fakeHost()
  host.hold('a', 'b')
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  await act(async () => button('Collapse workspace').click())
  expect(runStatus('Prompt a')).toBeNull()
  expect(runStatus('Prompt b')).toBeNull()
  await host.release('a', 'b')
  expect(dialog()).toContain('Resumed 2 of 2 chats')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
  await act(async () => button('Done').click())
  expect(getNativeChatRestartRun()).toBeNull()
  expect(document.body.textContent).not.toContain('chat resumed')
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
