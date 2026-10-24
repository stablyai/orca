// @vitest-environment happy-dom
import {
  createResumeModalFixture,
  offered,
  failure,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { act, StrictMode } from 'react'
import { toast } from 'sonner'
import { expect, it, vi, type Mock } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import { lastToastShow } from './native-chat-resume-toast.test-support'
import {
  chatBox,
  chatBoxes,
  dontAskAgain
} from './native-chat-resume-on-restart-modal.test-support'
import {
  getNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import {
  getNativeChatRestartOffer,
  refreshNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({
  emit: (_event: Parameters<ResumeStatusStream['emit']>[0]) => {},
  snapshot: new Map()
}))
const activate: Mock<() => Promise<boolean>> = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: (event: Parameters<ResumeStatusStream['emit']>[0]) => void
  ) => {
    statusStream.emit = emit
    emit({ type: 'snapshot', sessions: [...statusStream.snapshot.values()] })
    return { unsubscribe: () => {} }
  }
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: activate
}))
vi.mock('sonner', async () =>
  (await import('./native-chat-resume-sonner-mock.test-support')).resumeSonnerMock()
)

const { mount, button, offerIds, toasts, fakeHost, runStatus, calls } = createResumeModalFixture(
  rpc,
  statusStream
)

it('keeps next-launch preference out of the current resume action', async () => {
  const host = fakeHost()
  host.hold('a')
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => chatBox('b').click())
  await act(async () => dontAskAgain().click())
  await act(async () => button('Resume 1 chat').click())
  expect(useAppStore.getState().settings?.nativeChatResumeWorkOnRestart).toBe(true)
  expect(calls()).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', { sessionIds: ['a'] }]
  ])
  await host.release('a')
  expect(calls().slice(2)).toEqual([])
})

it('offers exactly Dismiss all and the resume action', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  const controls = document.querySelectorAll(
    '[role="dialog"] button:not([role="checkbox"]):not([aria-expanded])'
  )
  expect([...controls].map((entry) => entry.textContent?.trim())).toEqual([
    'Dismiss all',
    'Resume 2 chats',
    'Close'
  ])
})

it('says under each chat what it was doing when Orca went away', async () => {
  rpc.mockResolvedValue({
    sessions: [
      { ...offered[0], activity: { state: 'working', prompts: [], tasks: [] } },
      {
        ...offered[1],
        activity: {
          state: 'done',
          prompts: [],
          tasks: [{ kind: 'command', label: 'Watch CI' }]
        }
      }
    ]
  })
  await mount(<NativeChatResumeOnRestartModal />)
  const text = document.querySelector('[role="dialog"]')?.textContent ?? ''
  expect(text).toContain('Was mid-reply')
  expect(text).toContain('Monitoring: Watch CI')
})

// Closing snoozes without mutating the host’s offer; still persist the preference.
it('snoozes to the status-bar offer when the dialog is closed', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => dontAskAgain().click())
  await act(async () => button('Close').click())
  expect(useAppStore.getState().settings?.nativeChatResumeWorkOnRestart).toBe(true)
  expect(rpc.mock.calls.map((call) => call[1])).toEqual(['agentSession.restartResumable'])
  expect(offerIds()).toEqual(['a', 'b'])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('fully dismisses the offer only through Dismiss all', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered }
      : { dismissed: 2, sessions: [] }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Dismiss all').click())
  expect(rpc.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartResumableDismiss', {}]
  ])
  expect(offerIds()).toEqual([])
})

// Dismissal bookkeeping must not trap the dialog or toast; unconfirmed offers remain in the status bar.
it('keeps a dismissal the host never confirmed in the status bar, without trapping the dialog', async () => {
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: offered }
    }
    throw new Error('response lost')
  })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Dismiss all').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(toast).not.toHaveBeenCalled()
  expect(offerIds()).toEqual(['a', 'b'])
})

it('saves Don’t ask again when the offer is dismissed outright', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable' ? { sessions: offered } : { dismissed: 2 }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => dontAskAgain().click())
  await act(async () => button('Dismiss all').click())
  expect(useAppStore.getState().settings?.nativeChatResumeWorkOnRestart).toBe(true)
})

// Reopening rereads the host; already resumed claims must never be re-offered.
it('never re-offers a resumed chat when the status entry reopens the dialog', async () => {
  let remaining = offered
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: remaining }
    }
    remaining = remaining.filter((candidate) => candidate.sessionId !== 'a')
    return {
      resumed: [{ sessionId: 'a', outcome: 'resumed' }],
      continued: [{ sessionId: 'a', outcome: 'continued' }],
      sessions: remaining
    }
  })
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => chatBox('b').click())
  await act(async () => button('Resume 1 chat').click())
  expect(offerIds()).toEqual(['b'])
  expect(document.querySelector('[role="dialog"]')).toBeNull()

  await act(async () => button('1 chat to resume').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(offerIds()).toEqual(['b'])
  expect(chatBoxes()).toHaveLength(1)
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
})

it('closes on Resume and shows the resume in the status bar until the host answers', async () => {
  const host = fakeHost()
  host.hold('a', 'b')
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => button('Resume 2 chats').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(button('Resuming chats, 0 of 2 done. Click to open details.').textContent).toBe(
    'Resuming chats 0/2'
  )
  expect(document.body.textContent).not.toContain('chats to resume')

  // Mid-run reopen uses the current run, avoiding a read that could race its answer.
  const reads = rpc.mock.calls.length
  await act(async () => button('Resuming chats 0/2').click())
  expect(rpc.mock.calls.length).toBe(reads)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resuming 2 chats')
  expect(button('Resuming…').disabled).toBe(true)
  expect(runStatus('Prompt a')).toMatch(/^Prompt a: Waiting to start · \d+s$/)
  expect(runStatus('Prompt b')).toMatch(/^Prompt b: Waiting to start · \d+s$/)
  expect(chatBoxes()).toHaveLength(0)
  const status = document.querySelector('[role="img"][aria-label^="Prompt a: "]')
  expect(document.querySelector('[role="tree"] .w-7')).toBeNull()
  expect(status?.parentElement?.classList.contains('size-4.5')).toBe(true)
  expect(status?.closest('[role="treeitem"]')?.getAttribute('aria-level')).toBe('2')
  expect(status?.closest('label')).toBeNull()

  await host.release('a')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(runStatus('Prompt b')).toMatch(/^Prompt b: Waiting to start/)
  expect(button('Resuming chats 1/2')).toBeTruthy()
  expect(toast).not.toHaveBeenCalled()

  await host.release('b')
  expect(document.body.textContent).not.toContain('Resuming chats')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resumed 2 of 2 chats')
  expect(toasts()).toEqual([['Resumed 2 chats']])
  await act(async () => button('Done').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
})

// Run settlement cannot close a user-reopened dialog over unselected chats.
it('keeps a dialog reopened mid-resume open over the chats still offered', async () => {
  const third = { ...offered[1]!, sessionId: 'c', latestPrompt: 'Prompt c' }
  const host = fakeHost({ sessions: [...offered, third] })
  host.hold('a', 'b')
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => chatBox('c').click())
  await act(async () => button('Resume 2 chats').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => button('1 chat to resume').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  const rowC = () => document.querySelector('[role="checkbox"][aria-label*="Prompt c"]')
  expect(runStatus('Prompt a')).toMatch(/Waiting to start/)
  expect(runStatus('Prompt b')).toMatch(/Waiting to start/)
  expect(rowC()?.getAttribute('data-state')).toBe('unchecked')

  await host.release('a', 'b')
  expect(rowC()?.getAttribute('data-state')).toBe('checked')
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('Prompt c')
  expect(dialog?.textContent).toContain('Resumed 2 of 2 chats')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(button('Dismiss all').disabled).toBe(false)
  expect(chatBox('c').getAttribute('data-state')).toBe('checked')
  expect(button('Resume 1 chat').disabled).toBe(false)
})

it('starts each opening from the default ticks, not the ones left at the last close', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => chatBox('b').click())
  expect(button('Resume 1 chat')).toBeTruthy()
  await act(async () => button('Close').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()

  await act(async () => requestNativeChatResumeOnRestartDialog())
  expect(chatBox('b').getAttribute('data-state')).toBe('checked')
  expect(button('Resume 2 chats').disabled).toBe(false)
})

// Shrink spent host claims or the status entry can promise chats that no longer exist.
it('settles the offer for the chats a resume reattached', async () => {
  fakeHost()
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => chatBox('b').click())
  await act(async () => button('Resume 1 chat').click())
  expect(offerIds()).toEqual(['b'])
})

// Automatic resume must reattach and continue through the button’s same action; attachment alone is ordinary chat open.
it('resumes and continues once when the launch begins opted in', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalNativeChat: true,
      nativeChatResumeWorkOnRestart: true
    }
  })
  fakeHost()
  await mount(
    <StrictMode>
      <NativeChatResumeOnRestartModal />
    </StrictMode>
  )
  await act(async () =>
    useAppStore.getState().updateSettings({ nativeChatResumeWorkOnRestart: false })
  )
  await act(async () =>
    useAppStore.getState().updateSettings({ nativeChatResumeWorkOnRestart: true })
  )
  await act(async () => useAppStore.getState().updateSettings({ experimentalNativeChat: false }))
  await act(async () => useAppStore.getState().updateSettings({ experimentalNativeChat: true }))
  expect(calls()).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', { sessionIds: ['a', 'b'] }]
  ])
  expect(toasts()).toEqual([['Resumed 2 chats']])
  expect(offerIds()).toEqual([])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('shows an opted-in launch resume in the status bar while it runs', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalNativeChat: true,
      nativeChatResumeWorkOnRestart: true
    }
  })
  const host = fakeHost()
  host.hold('a', 'b')
  await mount(<NativeChatResumeStatusSegment iconOnly={false} />)
  expect(button('Resuming chats 0/2').getAttribute('aria-label')).toBe(
    'Resuming chats, 0 of 2 done. Click to open details.'
  )
  await host.release('b')
  expect(button('Resuming chats 1/2')).toBeTruthy()
  await host.release('a')
  expect(document.body.textContent).not.toContain('Resuming')
})

it('reports chats an opted-in launch could not carry on in one toast and the status bar', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalNativeChat: true,
      nativeChatResumeWorkOnRestart: true
    }
  })
  fakeHost({}, (sessionId) => (sessionId === 'a' ? 'refused' : 'skipped'))
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  expect(button('1 chat failed to resume. Click for details.')).toBeTruthy()
  expect(document.body.textContent).toContain('1 chat to resume')
  expect(toasts()).toEqual([['1 chat couldn’t be resumed']])
  await act(async () => lastToastShow()?.())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Prompt a')
})

it('dispatches the selected action while a future preference save is still pending', async () => {
  const saved = Promise.withResolvers<void>()
  useAppStore.setState({ updateSettings: () => saved.promise })
  fakeHost()
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => chatBox('b').click())
  await act(async () => dontAskAgain().click())
  await act(async () => button('Resume 1 chat').click())
  expect(calls()).toContainEqual(['agentSession.restartContinue', { sessionIds: ['a'] }])
  await act(async () => saved.reject(new Error('settings write failed')))
  expect(rpc).toHaveBeenCalledTimes(2)
})

// Unconfirmed delivery may already be running; calling it failed could invite a duplicate send.
it.each([
  ['refused', '2 chats failed to resume', '2 chats couldn’t be resumed'],
  ['unconfirmed', '2 chats to check', 'Couldn’t confirm 2 chats were resumed']
] as const)(
  'reports a %s continuation once in a toast and in the status bar',
  async (outcome, label, said) => {
    fakeHost({}, () => (outcome === 'refused' ? 'refused' : 'unknown'))
    await mount(
      <>
        <NativeChatResumeOnRestartModal />
        <NativeChatResumeStatusSegment iconOnly={false} />
      </>
    )
    await act(async () => button('Resume 2 chats').click())
    expect(button(label)).toBeTruthy()
    expect(toasts()).toEqual([[said]])
    expect(rpc).toHaveBeenCalledTimes(2)
  }
)

// Reconcile unreadable replies with a read-only host listing; absence of confirmation cannot consume an offer.
it('keeps the offer listed after an unreadable resume response', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable' ? { sessions: offered } : { sessions: offered }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  expect(toasts()).toEqual([['Couldn’t confirm 2 chats were resumed']])
  expect(offerIds()).toEqual(['a', 'b'])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

// A request lost before reservation has no host failure record; retain a local Retry marker until reconciliation or retry settles it.
it('reports the chats a lost resume request named once, as failed, until it is retried', async () => {
  let sessions = offered
  let continueFails = true
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const lost = new Error('response lost')
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions, failed: [] }
    }
    if (continueFails) {
      throw lost
    }
    sessions = []
    return {
      resumed: [{ sessionId: 'b', outcome: 'resumed' }],
      continued: [{ sessionId: 'b', outcome: 'continued' }],
      sessions,
      failed: []
    }
  })
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => button('Resume 2 chats').click())
  expect(toasts()).toEqual([['2 chats couldn’t be resumed']])
  const show = lastToastShow()
  expect(show).toBeDefined()
  // Reconcile a lost response read-only; never automatically repeat the action.
  expect(calls()).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', { sessionIds: ['a', 'b'] }],
    ['agentSession.restartResumable', undefined]
  ])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(warn).toHaveBeenCalledWith(expect.any(String), lost)
  warn.mockRestore()
  expect(offerIds()).toEqual([])
  expect(getNativeChatRestartOffer().failed.map((entry) => entry.sessionId)).toEqual(['a', 'b'])
  expect(button('2 chats failed to resume. Click for details.')).toBeTruthy()
  expect(document.body.textContent).not.toContain('chats to resume')

  sessions = [offered[1]!]
  await act(async () => {
    await refreshNativeChatRestartOffer()
  })
  expect(getNativeChatRestartOffer().failed.map((entry) => entry.sessionId)).toEqual(['b'])

  continueFails = false
  await act(async () => show?.())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Orca couldn’t resume this chat. Open it to continue manually.'
  )
  await act(async () => button('Retry').click())
  expect(calls().at(-1)).toEqual(['agentSession.restartContinue', { sessionIds: ['b'] }])
  expect(getNativeChatRestartOffer()).toMatchObject({ candidates: [], failed: [] })
  expect(toasts().at(-1)).toEqual(['Resumed 1 chat'])
})

it('answers a mixed Resume with one toast whose Show opens the dialog', async () => {
  fakeHost({}, (sessionId) => (sessionId === 'b' ? 'refused' : 'continued'))
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(toasts()).toEqual([['1 chat couldn’t be resumed', 'Resumed 1 chat']])
  await act(async () => lastToastShow()?.())
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('Resumed 1 of 2 chats')
  expect(dialog?.textContent).toContain('Prompt b')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
})

// An unconfirmed Dismiss cannot erase a failed-resume marker.
it('keeps a lost resume request marked failed when its Dismiss fails', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: [offered[0]!], failed: [] }
    }
    throw new Error('host unreachable')
  })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 1 chat').click())
  expect(getNativeChatRestartOffer().failed.map((entry) => entry.sessionId)).toEqual(['a'])
  expect(toasts()).toEqual([['1 chat couldn’t be resumed']])

  await act(async () => requestNativeChatResumeOnRestartDialog())
  await act(async () => button('Dismiss "Prompt a" in workspace').click())
  expect(rpc.mock.calls.at(-2)?.slice(1)).toEqual([
    'agentSession.restartResumableDismiss',
    { sessionIds: ['a'] }
  ])
  expect(offerIds()).toEqual([])
  expect(getNativeChatRestartOffer().failed.map((entry) => entry.sessionId)).toEqual(['a'])
  expect(toast).toHaveBeenCalledTimes(1)
  vi.mocked(console.warn).mockRestore()
})

/** Every button in the dialog, in order; row checkboxes are buttons too, so they are left out. */
function dialogControls(): (string | null)[] {
  return [
    ...document.querySelectorAll(
      '[role="dialog"] button:not([role="checkbox"]):not([aria-expanded])'
    )
  ].map((entry) => entry.textContent?.trim() || entry.getAttribute('aria-label'))
}

it('lists a chat the resume could not carry on when the dialog reopens, with what to do', async () => {
  fakeHost({}, (sessionId) => (sessionId === 'b' ? 'refused' : 'continued'))
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => requestNativeChatResumeOnRestartDialog())
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog).not.toBeNull()
  expect(dialog?.textContent).toContain('Resumed 1 of 2 chats')
  expect(dialog?.textContent).toContain("Don't ask again")
  expect(dialog?.textContent).not.toContain('Resumed automatically')
  expect(dialog?.textContent).not.toContain('Dismiss failed')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(chatBoxes()).toHaveLength(1)
  expect(document.querySelector('[aria-label="Prompt b: Couldn’t resume"]')).not.toBeNull()
  expect(dialog?.textContent).toContain('To resume:')
  expect(dialog?.textContent).toContain('Open the chat and reply.')
  expect(dialogControls()).toEqual([
    'All2',
    'In progress0',
    'Resumed1',
    'Need you1',
    'Dismiss "Prompt b" in workspace',
    'Open chat',
    'Dismiss all',
    'Resume 0 chats',
    'Close'
  ])
  expect(chatBox('b').getAttribute('data-state')).toBe('unchecked')

  await act(async () => button('Open chat').click())
  expect(activate).toHaveBeenCalledWith({
    structuredSession: { workspaceId: 'workspace', sessionId: 'b' }
  })
  // Opening is read-only; only the user’s send settles the host record.
  expect(rpc.mock.calls.map((call) => call[1])).not.toContain(
    'agentSession.restartResumableDismiss'
  )
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it.each(['footer', 'row'] as const)(
  'retries a failed chat by name from the %s when a retry can succeed',
  async (from) => {
    fakeHost({ sessions: [], failed: [failure('b', 'agent_session_conflict')] })
    await mount(<NativeChatResumeOnRestartModal />)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => requestNativeChatResumeOnRestartDialog())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Close it there, then retry.'
    )
    expect(chatBox('b').getAttribute('data-state')).toBe('checked')

    await act(async () => button(from === 'footer' ? 'Resume 1 chat' : 'Retry').click())
    expect(calls()).toContainEqual(['agentSession.restartContinue', { sessionIds: ['b'] }])
    expect(toasts()).toEqual([['Resumed 1 chat']])
    if (from === 'footer') {
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } else {
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        'Resumed 1 of 1 chat'
      )
      expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
    }
  }
)

// Row retry completion cannot close the dialog over other offered chats.
it('keeps the dialog open over the chats still offered after a row Retry succeeds', async () => {
  fakeHost({ sessions: [offered[0]!], failed: [failure('b', 'agent_session_conflict')] })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Retry').click())
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('Prompt a')
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
  expect(document.querySelector('[role="checkbox"][aria-label*="Prompt a"]')).not.toBeNull()
})

it('keeps a dialog reopened mid-retry open when the retry settles', async () => {
  const host = fakeHost({
    sessions: [offered[0]!],
    failed: [failure('b', 'agent_session_conflict')]
  })
  host.hold('b')
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => button('Retry').click())
  await act(async () => button('Close').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => button('1 chat to resume').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  const tick = (prompt: string) =>
    document.querySelector(`[role="checkbox"][aria-label*="${prompt}"]`)?.getAttribute('data-state')
  expect(tick('Prompt a')).toBe('unchecked')
  expect(runStatus('Prompt b')).toMatch(/Waiting to start/)

  await host.release('b')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Prompt a')
  expect(tick('Prompt a')).toBe('checked')
})

// Unretryable rows cannot join Resume even after a stale tick; their explicit guidance is the remaining action.
it('keeps a failure the host marks unretryable out of Resume, even after a tick', async () => {
  let failed: unknown[] = [failure('b')]
  rpc.mockImplementation(async () => ({ sessions: [], failed }))
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => requestNativeChatResumeOnRestartDialog())
  // Missing retryability flags preserve older hosts’ selectable behavior.
  expect(chatBox('b').hasAttribute('disabled')).toBe(false)
  await act(async () => chatBox('b').click())
  expect(button('Resume 1 chat').disabled).toBe(false)

  failed = [{ ...failure('b'), retryable: false }]
  await act(async () => void (await refreshNativeChatRestartOffer()))
  expect(chatBox('b').hasAttribute('disabled')).toBe(true)
  expect(button('Resume 0 chats').disabled).toBe(true)
  expect(button('Open chat').disabled).toBe(false)
})

it('dismisses one failed chat by name, and every record through Dismiss all', async () => {
  rpc.mockImplementation(async (_target, method, params: { sessionIds?: string[] } | undefined) =>
    method === 'agentSession.restartResumable'
      ? { sessions: [], failed: [failure('a'), failure('b')] }
      : {
          dismissed: 1,
          sessions: [],
          failed: params?.sessionIds
            ? [failure('a'), failure('b')].filter(
                (entry) => !params.sessionIds?.includes(entry.sessionId)
              )
            : []
        }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => requestNativeChatResumeOnRestartDialog())
  expect(chatBoxes()).toHaveLength(2)
  await act(async () => button('Dismiss "Prompt a" in workspace').click())
  expect(rpc.mock.calls.at(-1)?.slice(1)).toEqual([
    'agentSession.restartResumableDismiss',
    { sessionIds: ['a'] }
  ])
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Prompt a')
  expect(chatBoxes()).toHaveLength(1)
  await act(async () => button('Dismiss all').click())
  expect(rpc.mock.calls.at(-1)?.slice(1)).toEqual(['agentSession.restartResumableDismiss', {}])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(toast).not.toHaveBeenCalled()
})
