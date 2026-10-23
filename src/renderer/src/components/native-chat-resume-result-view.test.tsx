// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi, type Mock } from 'vitest'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import {
  createResumeModalFixture,
  failure,
  offered,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { lastToastShow } from './native-chat-resume-toast.test-support'
import { chatBox, dontAskAgain } from './native-chat-resume-on-restart-modal.test-support'
import { useAppStore } from '../store'

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
vi.mock('sonner', async () =>
  (await import('./native-chat-resume-sonner-mock.test-support')).resumeSonnerMock()
)

const { mount, button, fakeHost } = createResumeModalFixture(rpc, statusStream)
const dialog = () => document.querySelector('[role="dialog"]')
const tree = () => document.querySelector<HTMLElement>('[role="tree"]')

async function mountSurfaces(): Promise<void> {
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
}

it('shows a finished resume as a result, in the past tense, once nothing is left to choose', async () => {
  fakeHost()
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => lastToastShow()?.())
  expect(dialog()?.textContent).toContain('Resumed 2 of 2 chats')
  expect(dialog()?.textContent).toContain(
    'Orca restored each one where it stopped, with its full context'
  )
  expect(dialog()?.textContent).not.toContain('Resuming restores')
  expect(tree()?.querySelectorAll('[role="checkbox"]')).toHaveLength(0)
  expect(tree()?.textContent).not.toContain('Select all')
  // Auto-resume is still off, so the box stays after Resume.
  expect(dialog()?.textContent).toContain("Don't ask again")
  // The user pressed Resume, so nothing says it happened on its own.
  expect(dialog()?.textContent).not.toContain('Resumed automatically')
})

it('saves "Don\'t ask again" ticked on a finished resume the user started', async () => {
  fakeHost()
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => lastToastShow()?.())
  expect(dialog()?.textContent).toContain('Resumed 2 of 2 chats')
  await act(async () => dontAskAgain().click())
  await act(async () => button('Done').click())
  expect(useAppStore.getState().settings?.nativeChatResumeWorkOnRestart).toBe(true)
})

it('does not restore a hidden picker preference when closing a run', async () => {
  const host = fakeHost()
  host.hold('a', 'b')
  await mountSurfaces()
  await act(async () => dontAskAgain().click())
  await act(async () => button('Resume 2 chats').click())
  expect(useAppStore.getState().settings?.nativeChatResumeWorkOnRestart).toBe(true)

  await act(async () => button('Resuming chats 0/2').click())
  expect(dialog()?.textContent).not.toContain("Don't ask again")
  await act(async () =>
    useAppStore.getState().updateSettings({ nativeChatResumeWorkOnRestart: false })
  )
  await act(async () => button('Close').click())
  const afterInFlightClose = useAppStore.getState().settings?.nativeChatResumeWorkOnRestart

  await host.release('a', 'b')
  await act(async () => lastToastShow()?.())
  expect(dialog()?.textContent).toContain('Resumed 2 of 2 chats')
  // Turned off elsewhere, the box is back, unticked: the earlier tick was consumed.
  expect(dontAskAgain().getAttribute('data-state')).toBe('unchecked')
  await act(async () =>
    useAppStore.getState().updateSettings({ nativeChatResumeWorkOnRestart: false })
  )
  await act(async () => button('Done').click())
  expect([
    afterInFlightClose,
    useAppStore.getState().settings?.nativeChatResumeWorkOnRestart
  ]).toEqual([false, false])
})

it('starts a remaining-offer picker without the preference consumed by the previous resume', async () => {
  fakeHost()
  await mountSurfaces()
  await act(async () => chatBox('b').click())
  await act(async () => dontAskAgain().click())
  await act(async () => button('Resume 1 chat').click())
  expect(useAppStore.getState().settings?.nativeChatResumeWorkOnRestart).toBe(true)

  await act(async () => button('1 chat to resume').click())
  expect(dialog()?.textContent).toContain('Resumed 1 of 1 chat')
  await act(async () => button('Close').click())
  await act(async () =>
    useAppStore.getState().updateSettings({ nativeChatResumeWorkOnRestart: false })
  )

  await act(async () => button('1 chat to resume').click())
  const pickerCheckbox = dontAskAgain().getAttribute('data-state')
  await act(async () => button('Close').click())
  expect([pickerCheckbox, useAppStore.getState().settings?.nativeChatResumeWorkOnRestart]).toEqual([
    'unchecked',
    false
  ])
})

it('reopens a collapsed result group with tree keys', async () => {
  fakeHost()
  await mountSurfaces()
  expect(button('Collapse workspace').tabIndex).toBe(-1)
  await act(async () => button('Resume 2 chats').click())
  await act(async () => lastToastShow()?.())
  const disclosure = button('Collapse workspace')
  const press = async (key: string) =>
    act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  expect(disclosure.tabIndex).toBe(0)
  tree()?.focus()
  await press('ArrowDown')
  expect(document.activeElement).toBe(disclosure)
  await press('ArrowLeft')
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(disclosure)
  await press('ArrowRight')
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(disclosure)
})

it('shows a settled nonretryable failure as a result with a Done action', async () => {
  const failed = { ...failure('a'), outcome: 'unconfirmed' as const, retryable: false }
  let acted = false
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: acted ? [] : [offered[0]], failed: acted ? [failed] : [] }
    }
    acted = true
    return {
      sessions: [],
      failed: [failed],
      continued: [{ sessionId: 'a', outcome: 'unknown' }]
    }
  })
  await mountSurfaces()
  await act(async () => button('Resume 1 chat').click())
  await act(async () => lastToastShow()?.())
  expect(dialog()?.textContent).toContain('Resumed 0 of 1 chat')
  expect(tree()?.textContent).not.toContain('Select all')
  expect(tree()?.querySelectorAll('[role="checkbox"]')).toHaveLength(0)
  expect(button('Open chat')).toBeTruthy()
  expect(button('Dismiss "Prompt a" in workspace')).toBeTruthy()
  expect(button('Done').disabled).toBe(false)
  expect(dialog()?.textContent).not.toContain('Resume 0 chats')
})

it('does not place an untouched offer in the Need you filter', async () => {
  fakeHost()
  await mountSurfaces()
  const secondChat = document.querySelector<HTMLElement>(
    '[role="checkbox"][aria-label*="Prompt b"]'
  )
  await act(async () => secondChat?.click())
  await act(async () => button('Resume 1 chat').click())
  await act(async () => lastToastShow()?.())
  expect(dialog()?.textContent).toContain('Check the list for chats that still need attention')
  expect(dialog()?.textContent).not.toContain('Chats that need you are at the top')
  expect(button('Need you0')).toBeTruthy()
  expect(button('Resume 1 chat')).toBeTruthy()
})

it('says a launch resumed on its own and links to the setting', async () => {
  const openSettingsPage = vi.fn()
  const openSettingsTarget = vi.fn()
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, nativeChatResumeWorkOnRestart: true },
    openSettingsPage,
    openSettingsTarget
  }))
  fakeHost()
  await mountSurfaces()
  expect(dialog()).toBeNull()
  await act(async () => lastToastShow()?.())
  expect(dialog()?.textContent).toContain('Resumed automatically after the restart.')
  expect(dialog()?.textContent).not.toContain("Don't ask again")

  await act(async () => button('Change in Settings').click())
  expect(openSettingsPage).toHaveBeenCalledOnce()
  expect(openSettingsTarget).toHaveBeenCalledWith({
    pane: 'chat',
    repoId: null,
    sectionId: 'chat-resume-on-restart'
  })
  // The dialog gets out of the way of the page it opened.
  expect(dialog()).toBeNull()
})

it('keeps the checkboxes while a chat can still be chosen, whichever tab is shown', async () => {
  fakeHost({}, (sessionId) => (sessionId === 'b' ? 'refused' : 'continued'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('1 chat failed to resume').click())
  expect(dialog()?.textContent).toContain('The ones Orca resumed were restored')
  expect(tree()?.textContent).toContain('Select all')
  await act(async () => button('Resumed1').click())
  // Filtering to rows that all show a status must not drop the column under the user.
  expect(tree()?.textContent).toContain('Select all')
})
