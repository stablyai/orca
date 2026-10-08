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
vi.mock('sonner', () => ({ toast: vi.fn() }))

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
  // The reply already carries the remaining list.
  expect(calls().slice(2)).toEqual([])
})

// One primary action and one way out of it; the body copy carries the transparency.
it('offers exactly Dismiss all and the resume action', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  // Checkboxes and tree arrows are buttons too; the controls are what is left after them.
  const controls = document.querySelectorAll(
    '[role="dialog"] button:not([role="checkbox"]):not([aria-expanded])'
  )
  expect([...controls].map((entry) => entry.textContent?.trim())).toEqual([
    'Dismiss all',
    'Resume 2 chats',
    'Close'
  ])
})

// Rows the sidebar showed as working for different reasons must read differently.
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

// Closing is the only snooze, so it carries the whole of one: saves the preference like every
// other way out, and calls NOTHING — the offer is the host's and stays exactly where it was.
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

// Bookkeeping must never gate the user's own action: the dialog closes either way, and a dismissal
// Orca could not confirm shows as the offer still sitting in the status bar, not as a toast.
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
  // The host still holds the markers, so the status entry must keep saying so.
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

// Reopening must ask the host again, never replay the launch answer: the chats already resumed are
// gone from its list, and offering them back earns the user a refusal.
it('never re-offers a resumed chat when the status entry reopens the dialog', async () => {
  let remaining = offered
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: remaining }
    }
    // The host spends the claim it settled, so its next answer no longer names that chat.
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
  // The action closes the dialog itself; the status entry is the way back to what is left.
  expect(document.querySelector('[role="dialog"]')).toBeNull()

  await act(async () => button('1 chat to resume').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(offerIds()).toEqual(['b'])
  // The resumed chat is history, while only the offered chat remains selectable.
  expect(chatBoxes()).toHaveLength(1)
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
})

// The resume outlives the dialog, as a skill update does: the status bar carries it while in flight.
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
  // Counted once, as in flight, not also as still to resume.
  expect(document.body.textContent).not.toContain('chats to resume')

  // Reopening mid-run shows the run, without a re-read that could race the host's answer.
  const reads = rpc.mock.calls.length
  await act(async () => button('Resuming chats 0/2').click())
  expect(rpc.mock.calls.length).toBe(reads)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resuming 2 chats')
  expect(button('Resuming…').disabled).toBe(true)
  // Each chat being resumed shows a spinner where its checkbox was; tree nodes stay disabled.
  expect(runStatus('Prompt a')).toMatch(/^Prompt a: Waiting to start · \d+s$/)
  expect(runStatus('Prompt b')).toMatch(/^Prompt b: Waiting to start · \d+s$/)
  expect(chatBoxes()).toHaveLength(0)
  const status = document.querySelector('[role="img"][aria-label^="Prompt a: "]')
  expect(status?.parentElement?.classList.contains('w-7')).toBe(true)
  expect(status?.parentElement?.parentElement?.firstElementChild?.contains(status)).toBe(true)
  expect(status?.closest('[role="treeitem"]')?.getAttribute('aria-level')).toBe('2')
  expect(status?.closest('label')).toBeNull()

  // Each chat settles on its own answer, not when the slowest one does.
  await host.release('a')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(runStatus('Prompt b')).toMatch(/^Prompt b: Waiting to start/)
  expect(button('Resuming chats 1/2')).toBeTruthy()
  expect(toast).not.toHaveBeenCalled()

  await host.release('b')
  expect(document.body.textContent).not.toContain('Resuming chats')
  // The dialog the user reopened stays on the run it was following until they close it.
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resumed 2 of 2 chats')
  // The click is answered once, when the run settles, across chats that are off-screen.
  expect(toasts()).toEqual([['Resumed 2 chats']])
  await act(async () => button('Done').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  // Nothing is left to show, so the reopen request is retired rather than left to latch.
  expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
})

// A dialog the user reopened mid-run is theirs: the run's answer must not close it over a chat
// they left out of the resume and can now act on.
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
  // Mid-run the chats being resumed show where they stand; the chat left out reads as left out.
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
  // The run is over, so the chat left out is actionable again, and this opening ticks it afresh.
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

// Resuming spends the host's claims, so the offer has to shrink with it. A count left standing over
// chats the host already handed back sends the user to a status entry that re-reads, finds nothing,
// and does nothing.
it('settles the offer for the chats a resume reattached', async () => {
  fakeHost()
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => chatBox('b').click())
  await act(async () => button('Resume 1 chat').click())
  expect(offerIds()).toEqual(['b'])
})

// The point of the preference. "Resume automatically" has to run the action the button runs —
// reattach AND ask each agent to carry on — or it recovers nothing that opening the chat would not.
it('resumes and continues once when the launch begins opted in', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalStructuredNativeChat: true,
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
  await act(async () =>
    useAppStore.getState().updateSettings({ experimentalStructuredNativeChat: false })
  )
  await act(async () =>
    useAppStore.getState().updateSettings({ experimentalStructuredNativeChat: true })
  )
  // One bulk action, with its remaining list in the reply.
  expect(calls()).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', { sessionIds: ['a', 'b'] }]
  ])
  // Answered once, as a click is, however often the settings above re-render the surfaces.
  expect(toasts()).toEqual([['Resumed 2 chats']])
  expect(offerIds()).toEqual([])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

// No dialog to watch, so the status bar is the only sign an automatic resume is running.
it('shows an opted-in launch resume in the status bar while it runs', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalStructuredNativeChat: true,
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

// An opted-in launch is answered as a click is: one toast with Show, and one status bar entry.
it('reports chats an opted-in launch could not carry on in one toast and the status bar', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalStructuredNativeChat: true,
      nativeChatResumeWorkOnRestart: true
    }
  })
  // The host carries neither chat on: it refuses one and never reaches the other.
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

// The click gets one toast; the host's failure list stays in the status bar. Both keep an unconfirmed
// chat apart, since its agent may well be working and "failed" would invite a second send.
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
    // One offer read and one bulk action.
    expect(rpc).toHaveBeenCalledTimes(2)
  }
)

// The response is not validated, so a payload this side cannot read is answered by what the host
// still lists: the offer must not shrink over chats nothing confirmed, and the message may have gone.
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

// A request that fails before the host reserved anything leaves it nothing to record, so the chats
// it named are reported here once, as failed with Retry, until a host answer or Retry ends it.
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
  // Nothing reached the chats, so the click's one toast counts both as not resumed.
  expect(toasts()).toEqual([['2 chats couldn’t be resumed']])
  // The re-read lists both chats, so the toast keeps Show.
  const show = lastToastShow()
  expect(show).toBeDefined()
  // A lost action response is followed by a read-only reconciliation, never a retry.
  expect(calls()).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', { sessionIds: ['a', 'b'] }],
    ['agentSession.restartResumable', undefined]
  ])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  // The row's reason is this side's own code, so the real error goes to the log.
  expect(warn).toHaveBeenCalledWith(expect.any(String), lost)
  warn.mockRestore()
  expect(offerIds()).toEqual([])
  expect(getNativeChatRestartOffer().failed.map((entry) => entry.sessionId)).toEqual(['a', 'b'])
  expect(button('2 chats failed to resume. Click for details.')).toBeTruthy()
  expect(document.body.textContent).not.toContain('chats to resume')

  // A host answer that no longer offers a chat ends its mark.
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

// One click, one toast across chats mostly off-screen; its Show opens the list behind it.
it('answers a mixed Resume with one toast whose Show opens the dialog', async () => {
  fakeHost({}, (sessionId) => (sessionId === 'b' ? 'refused' : 'continued'))
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(toasts()).toEqual([['1 chat couldn’t be resumed', 'Resumed 1 chat']])
  // Show opens the dialog the click closed, over a fresh read of the list.
  await act(async () => lastToastShow()?.())
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('Resumed 1 of 2 chats')
  expect(dialog?.textContent).toContain('Prompt b')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
})

// A Dismiss the host never took leaves the chat shown as failed, not back as a plain offer.
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
  // A Dismiss is bookkeeping: whether the host took it raises no toast of its own.
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

// The finished summary keeps successful chats alongside current failures and their actions.
it('lists a chat the resume could not carry on when the dialog reopens, with what to do', async () => {
  fakeHost({}, (sessionId) => (sessionId === 'b' ? 'refused' : 'continued'))
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  // Resume hands off to the status bar; its failure entry reopens the list.
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => requestNativeChatResumeOnRestartDialog())
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog).not.toBeNull()
  expect(dialog?.textContent).toContain('Resumed 1 of 2 chats')
  expect(dialog?.textContent).toContain("Don't ask again (resume automatically)")
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
  // A retry cannot fix newer work in the chat, so it is not pre-selected for one.
  expect(chatBox('b').getAttribute('data-state')).toBe('unchecked')

  await act(async () => button('Open chat').click())
  expect(activate).toHaveBeenCalledWith({
    structuredSession: { workspaceId: 'workspace', sessionId: 'b' }
  })
  // Opening is read-only: the record stays with the host, the dialog just gets out of the way.
  expect(rpc.mock.calls.map((call) => call[1])).not.toContain(
    'agentSession.restartResumableDismiss'
  )
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

// Selecting a failed row and pressing Resume is the retry; the row's own Retry does the same.
it.each(['footer', 'row'] as const)(
  'retries a failed chat by name from the %s when a retry can succeed',
  async (from) => {
    fakeHost({ sessions: [], failed: [failure('b', 'agent_session_conflict')] })
    await mount(<NativeChatResumeOnRestartModal />)
    // Old failures never raise the launch dialog by themselves; the status entry does.
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => requestNativeChatResumeOnRestartDialog())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Close it there, then retry.'
    )
    // A retry can fix an ownership clash, so the row starts selected.
    expect(chatBox('b').getAttribute('data-state')).toBe('checked')

    await act(async () => button(from === 'footer' ? 'Resume 1 chat' : 'Retry').click())
    expect(calls()).toContainEqual(['agentSession.restartContinue', { sessionIds: ['b'] }])
    expect(toasts()).toEqual([['Resumed 1 chat']])
    if (from === 'footer') {
      // Resume hands the run to the status bar.
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } else {
      // A row action leaves the dialog open, where the retried chat shows how it went.
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        'Resumed 1 of 1 chat'
      )
      expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
    }
  }
)

// A row action acts on its row, as Dismiss does: a retry that clears the last failure must not close
// the dialog over a chat still offered.
it('keeps the dialog open over the chats still offered after a row Retry succeeds', async () => {
  fakeHost({ sessions: [offered[0]!], failed: [failure('b', 'agent_session_conflict')] })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Retry').click())
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('Prompt a')
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
  expect(document.querySelector('[role="checkbox"][aria-label*="Prompt a"]')).not.toBeNull()
})

// A dialog closed and reopened mid-retry is the user's again: the retry settling must not close it.
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
  // Only the retried row is running, so only it shows a spinner until the retry settles.
  const tick = (prompt: string) =>
    document.querySelector(`[role="checkbox"][aria-label*="${prompt}"]`)?.getAttribute('data-state')
  expect(tick('Prompt a')).toBe('unchecked')
  expect(runStatus('Prompt b')).toMatch(/Waiting to start/)

  await host.release('b')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Prompt a')
  expect(tick('Prompt a')).toBe('checked')
})

// The user's case: the only row is a failure the host says a retry cannot fix. Ticking it could
// only fail again, so the row's own action is the way on and the box cannot be ticked.
it('keeps a failure the host marks unretryable out of Resume, even after a tick', async () => {
  let failed: unknown[] = [failure('b')]
  rpc.mockImplementation(async () => ({ sessions: [], failed }))
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => requestNativeChatResumeOnRestartDialog())
  // An older host sends no flag, and the row stays selectable as it always was.
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
  // Dismissing is bookkeeping, not a resume: neither form raises a toast.
  expect(toast).not.toHaveBeenCalled()
})
