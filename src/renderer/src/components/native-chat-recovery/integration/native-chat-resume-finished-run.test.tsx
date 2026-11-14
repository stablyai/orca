// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi, type Mock } from 'vitest'
import { NativeChatResumeOnRestartModal } from '../NativeChatResumeRuntimeModal'
import { NativeChatResumeStatusSegment } from '../../status-bar/NativeChatResumeStatusSegment'
import {
  createResumeModalFixture,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { lastToastShow } from './native-chat-resume-toast.test-support'
import { releaseFinishedNativeChatRestartRun } from '../offers/native-chat-resume-on-restart-store'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from '../dialogs/native-chat-resume-on-restart-dialog'

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

const { mount, button, fakeHost } = createResumeModalFixture(rpc, statusStream)
const dialog = () => document.querySelector('[role="dialog"]')?.textContent

async function mountSurfaces(): Promise<void> {
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
}

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
