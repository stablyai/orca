// @vitest-environment happy-dom

import { act, StrictMode } from 'react'
import { toast } from 'sonner'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import { TooltipProvider } from './ui/tooltip'
import { lastToastShow } from './native-chat-resume-toast.test-support'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import {
  _resetNativeChatRestartOffer,
  getNativeChatRestartOffer,
  refreshNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

const rpc = vi.hoisted(() => vi.fn())
const activate = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  // A failed row opens the status feed; these cases never drive it.
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: activate
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const offered: ResumeCandidate[] = ['a', 'b'].map((sessionId) => ({
  sessionId,
  workspaceId: 'workspace',
  agent: 'codex',
  trigger: 'quit',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1_800_000_000_000,
  executionHostId: 'local',
  workspaceKind: 'git-worktree'
}))

/** A chat the host acted on and could not carry on, as it reports it. */
function failure(sessionId: string, reason = 'agent_session_restart_work_superseded') {
  const candidate = offered.find((entry) => entry.sessionId === sessionId)!
  return { ...candidate, failedAt: candidate.recordedAt + 60_000, outcome: 'refused', reason }
}

/** Outcome rows carry tooltips, so every mount needs the provider the app shell supplies. */
async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === text || entry.getAttribute('aria-label') === text
  )
  if (!found) {
    throw new Error(`Missing button: ${text}`)
  }
  return found
}

function checkbox(index: number): HTMLElement {
  const found = document.querySelectorAll<HTMLElement>('[role="checkbox"]')[index]
  if (!found) {
    throw new Error(`Missing checkbox: ${index}`)
  }
  return found
}

function offerIds(): string[] {
  return getNativeChatRestartOffer().candidates.map((candidate) => candidate.sessionId)
}

/** What each toast said: its title, and its description when it has one. */
function toasts(): unknown[][] {
  return vi
    .mocked(toast)
    .mock.calls.map(([title, options]) =>
      options?.description === undefined ? [title] : [title, options.description]
    )
}

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  vi.mocked(toast).mockClear()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalStructuredNativeChat: true },
    updateSettings: async (changes) => {
      useAppStore.setState((state) => ({
        settings: { ...getDefaultSettings(''), ...state.settings, ...changes }
      }))
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
})

it('keeps next-launch preference out of the current resume action', async () => {
  const action = Promise.withResolvers<unknown>()
  rpc.mockImplementation(async (_target, calledMethod) => {
    if (calledMethod === 'agentSession.restartResumable') {
      return { sessions: offered }
    }
    return action.promise
  })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => checkbox(1).click())
  await act(async () => checkbox(2).click())
  await act(async () => button('Resume 1 chat').click())
  expect(useAppStore.getState().settings?.nativeChatResumeWorkOnRestart).toBe(true)
  expect(rpc.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', { sessionIds: ['a'] }]
  ])
  await act(async () =>
    action.resolve({
      resumed: [{ sessionId: 'a', outcome: 'resumed' }],
      continued: [{ sessionId: 'a', outcome: 'continued' }],
      sessions: []
    })
  )
  expect(rpc).toHaveBeenCalledTimes(2)
})

// One primary action and one way out of it; the body copy carries the transparency.
it('offers exactly Dismiss all and the resume action', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  // Row and preference checkboxes are buttons too; the controls are what is left after them.
  const controls = document.querySelectorAll('[role="dialog"] button:not([role="checkbox"])')
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
  await act(async () => checkbox(2).click())
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
  await act(async () => checkbox(2).click())
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
  await act(async () => checkbox(1).click())
  await act(async () => button('Resume 1 chat').click())
  expect(offerIds()).toEqual(['b'])
  // The action closes the dialog itself; the status entry is the way back to what is left.
  expect(document.querySelector('[role="dialog"]')).toBeNull()

  await act(async () => button('1 chat to resume').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(offerIds()).toEqual(['b'])
  // One offered row plus the preference box — never the resumed chat again.
  expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
})

// The resume outlives the dialog, as a skill update does: the status bar carries it while in flight.
it('closes on Resume and shows the resume in the status bar until the host answers', async () => {
  const continued = Promise.withResolvers<unknown>()
  rpc.mockImplementation((_target, method) =>
    method === 'agentSession.restartResumable'
      ? Promise.resolve({ sessions: offered })
      : continued.promise
  )
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => button('Resume 2 chats').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(button('Resuming 2 chats. Click to open details.').textContent).toBe('Resuming 2 chats')
  // Counted once, as in flight, not also as still to resume.
  expect(document.body.textContent).not.toContain('chats to resume')

  // Reopening mid-run shows the run, without a re-read that could race the host's answer.
  const reads = rpc.mock.calls.length
  await act(async () => button('Resuming 2 chats').click())
  expect(rpc.mock.calls.length).toBe(reads)
  expect(button('Resuming…').disabled).toBe(true)
  expect(toast).not.toHaveBeenCalled()

  await act(async () =>
    continued.resolve({
      resumed: offered.map(({ sessionId }) => ({ sessionId, outcome: 'resumed' })),
      continued: offered.map(({ sessionId }) => ({ sessionId, outcome: 'continued' })),
      sessions: []
    })
  )
  expect(document.body.textContent).not.toContain('Resuming')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  // Nothing is left to show, so the reopen request is retired rather than left to latch.
  expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
  // The click is answered once, when the run settles, across chats that are off-screen.
  expect(toasts()).toEqual([['Resumed 2 chats']])
})

// A dialog the user reopened mid-run is theirs: the run's answer must not close it over a chat
// they left out of the resume and can now act on.
it('keeps a dialog reopened mid-resume open over the chats still offered', async () => {
  const third = { ...offered[1]!, sessionId: 'c', latestPrompt: 'Prompt c' }
  const continued = Promise.withResolvers<unknown>()
  rpc.mockImplementation((_target, method) =>
    method === 'agentSession.restartResumable'
      ? Promise.resolve({ sessions: [...offered, third] })
      : continued.promise
  )
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => checkbox(2).click())
  await act(async () => button('Resume 2 chats').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => button('1 chat to resume').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  // Mid-run the ticks say what is running, so the chat left out reads as left out.
  const rowC = () => document.querySelector('[role="checkbox"][aria-label*="Prompt c"]')
  expect(checkbox(0).getAttribute('data-state')).toBe('checked')
  expect(checkbox(1).getAttribute('data-state')).toBe('checked')
  expect(rowC()?.getAttribute('data-state')).toBe('unchecked')

  await act(async () =>
    continued.resolve({
      resumed: offered.map(({ sessionId }) => ({ sessionId, outcome: 'resumed' })),
      continued: offered.map(({ sessionId }) => ({ sessionId, outcome: 'continued' })),
      sessions: [third]
    })
  )
  expect(rowC()?.getAttribute('data-state')).toBe('checked')
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('Prompt c')
  expect(dialog?.textContent).not.toContain('Prompt a')
  // The run is over, so the chat left out is actionable again, and this opening ticks it afresh.
  expect(button('Dismiss all').disabled).toBe(false)
  expect(checkbox(0).getAttribute('data-state')).toBe('checked')
  expect(button('Resume 1 chat').disabled).toBe(false)
})

it('starts each opening from the default ticks, not the ones left at the last close', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => checkbox(1).click())
  expect(button('Resume 1 chat')).toBeTruthy()
  await act(async () => button('Close').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()

  await act(async () => requestNativeChatResumeOnRestartDialog())
  expect(checkbox(1).getAttribute('data-state')).toBe('checked')
  expect(button('Resume 2 chats').disabled).toBe(false)
})

// Resuming spends the host's claims, so the offer has to shrink with it. A count left standing over
// chats the host already handed back sends the user to a status entry that re-reads, finds nothing,
// and does nothing.
it('settles the offer for the chats a resume reattached', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered }
      : {
          resumed: [{ sessionId: 'a', outcome: 'resumed' }],
          continued: [{ sessionId: 'a', outcome: 'continued' }],
          sessions: [offered[1]!]
        }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => checkbox(1).click())
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
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered }
      : {
          resumed: offered.map(({ sessionId }) => ({ sessionId, outcome: 'resumed' })),
          continued: offered.map(({ sessionId }) => ({ sessionId, outcome: 'continued' })),
          sessions: []
        }
  )
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
  expect(rpc.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', {}]
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
  const continued = Promise.withResolvers<unknown>()
  rpc.mockImplementation((_target, method) =>
    method === 'agentSession.restartResumable'
      ? Promise.resolve({ sessions: offered })
      : continued.promise
  )
  await mount(<NativeChatResumeStatusSegment iconOnly={false} />)
  expect(button('Resuming 2 chats').getAttribute('aria-label')).toBe(
    'Resuming 2 chats. Click to open details.'
  )
  await act(async () =>
    continued.resolve({
      resumed: offered.map(({ sessionId }) => ({ sessionId, outcome: 'resumed' })),
      continued: offered.map(({ sessionId }) => ({ sessionId, outcome: 'continued' })),
      sessions: []
    })
  )
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
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered }
      : {
          resumed: [],
          continued: [{ sessionId: 'a', outcome: 'refused' }],
          sessions: [offered[1]!],
          failed: [failure('a')]
        }
  )
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
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered }
      : {
          resumed: [{ sessionId: 'a', outcome: 'resumed' }],
          continued: [{ sessionId: 'a', outcome: 'continued' }],
          sessions: []
        }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => checkbox(1).click())
  await act(async () => checkbox(2).click())
  await act(async () => button('Resume 1 chat').click())
  expect(rpc.mock.calls.at(-1)?.slice(1)).toEqual([
    'agentSession.restartContinue',
    { sessionIds: ['a'] }
  ])
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
    rpc.mockImplementation(async (_target, method) =>
      method === 'agentSession.restartResumable'
        ? { sessions: offered }
        : {
            continued: offered.map(({ sessionId }) => ({
              sessionId,
              outcome: outcome === 'refused' ? 'refused' : 'unknown'
            })),
            sessions: [],
            failed: offered.map(({ sessionId }) => ({ ...failure(sessionId), outcome }))
          }
    )
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
  expect(rpc.mock.calls.map((call) => [call[1], call[2]])).toEqual([
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
  expect(rpc.mock.calls.at(-1)?.slice(1)).toEqual([
    'agentSession.restartContinue',
    { sessionIds: ['b'] }
  ])
  expect(getNativeChatRestartOffer()).toMatchObject({ candidates: [], failed: [] })
  expect(toasts().at(-1)).toEqual(['Resumed 1 chat'])
})

// One click, one toast across chats mostly off-screen; its Show opens the list behind it.
it('answers a mixed Resume with one toast whose Show opens the dialog', async () => {
  let sessions: ResumeCandidate[] = offered
  let failed: unknown[] = []
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions, failed }
    }
    sessions = []
    failed = [failure('b')]
    return {
      resumed: offered.map(({ sessionId }) => ({ sessionId, outcome: 'resumed' })),
      continued: [
        { sessionId: 'a', outcome: 'continued' },
        { sessionId: 'b', outcome: 'refused', reason: 'agent_session_restart_work_superseded' }
      ],
      sessions,
      failed
    }
  })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(toasts()).toEqual([['1 chat couldn’t be resumed', 'Resumed 1 chat']])
  // Show opens the dialog the click closed, over a fresh read of the list.
  await act(async () => lastToastShow()?.())
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('Prompt b')
  expect(dialog?.textContent).not.toContain('Prompt a')
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
  return [...document.querySelectorAll('[role="dialog"] button:not([role="checkbox"])')].map(
    (entry) => entry.textContent?.trim() || entry.getAttribute('aria-label')
  )
}

// A chat the resume could not carry on stays in the same dialog — same title, checkboxes and
// footer — with its row saying what went wrong and what to do.
it('lists a chat the resume could not carry on when the dialog reopens, with what to do', async () => {
  let remaining: unknown[] = []
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered, failed: remaining }
      : ((remaining = [failure('b')]),
        {
          resumed: offered.map(({ sessionId }) => ({ sessionId, outcome: 'resumed' })),
          continued: [
            { sessionId: 'a', outcome: 'continued' },
            { sessionId: 'b', outcome: 'refused', reason: 'agent_session_restart_work_superseded' }
          ],
          sessions: [],
          failed: remaining
        })
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  // Resume hands off to the status bar; its failure entry reopens the list.
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => requestNativeChatResumeOnRestartDialog())
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog).not.toBeNull()
  // Unchanged chrome: the title, the preference box, and the two footer actions.
  expect(dialog?.textContent).toContain('Resume interrupted chats?')
  expect(dialog?.textContent).toContain("Don't ask again (resume automatically)")
  expect(dialog?.textContent).not.toContain('Dismiss failed')
  // The resumed chat left the list as it always did; the failed one is a row with a checkbox.
  expect(dialog?.textContent).not.toContain('Prompt a')
  expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
  expect(document.querySelector('[aria-label="Prompt b: Couldn’t resume"]')).not.toBeNull()
  expect(dialog?.textContent).toContain('To resume:')
  expect(dialog?.textContent).toContain('Open the chat and reply.')
  expect(dialogControls()).toEqual([
    'Dismiss "Prompt b" in workspace',
    'Open chat',
    'Dismiss all',
    'Resume 0 chats',
    'Close'
  ])
  // A retry cannot fix newer work in the chat, so it is not pre-selected for one.
  expect(checkbox(0).getAttribute('data-state')).toBe('unchecked')

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
    let failed = [failure('b', 'agent_session_conflict')]
    rpc.mockImplementation(async (_target, method) =>
      method === 'agentSession.restartResumable'
        ? { sessions: [], failed }
        : ((failed = []),
          {
            resumed: [{ sessionId: 'b', outcome: 'resumed' }],
            continued: [{ sessionId: 'b', outcome: 'continued' }],
            sessions: [],
            failed
          })
    )
    await mount(<NativeChatResumeOnRestartModal />)
    // Old failures never raise the launch dialog by themselves; the status entry does.
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => requestNativeChatResumeOnRestartDialog())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Close it there, then retry.'
    )
    // A retry can fix an ownership clash, so the row starts selected.
    expect(checkbox(0).getAttribute('data-state')).toBe('checked')

    await act(async () => button(from === 'footer' ? 'Resume 1 chat' : 'Retry').click())
    expect(rpc.mock.calls.at(-1)?.slice(1)).toEqual([
      'agentSession.restartContinue',
      { sessionIds: ['b'] }
    ])
    expect(toasts()).toEqual([['Resumed 1 chat']])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  }
)

// A row action acts on its row, as Dismiss does: a retry that clears the last failure must not close
// the dialog over a chat still offered.
it('keeps the dialog open over the chats still offered after a row Retry succeeds', async () => {
  let failed = [failure('b', 'agent_session_conflict')]
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: [offered[0]], failed }
      : ((failed = []),
        {
          resumed: [{ sessionId: 'b', outcome: 'resumed' }],
          continued: [{ sessionId: 'b', outcome: 'continued' }],
          sessions: [offered[0]],
          failed
        })
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Retry').click())
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('Prompt a')
  expect(dialog?.textContent).not.toContain('Prompt b')
})

// A dialog closed and reopened mid-retry is the user's again: the retry settling must not close it.
it('keeps a dialog reopened mid-retry open when the retry settles', async () => {
  const continued = Promise.withResolvers<unknown>()
  rpc.mockImplementation((_target, method) =>
    method === 'agentSession.restartResumable'
      ? Promise.resolve({
          sessions: [offered[0]],
          failed: [failure('b', 'agent_session_conflict')]
        })
      : continued.promise
  )
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
  // Only the retried row is running, so only it reads as ticked until the retry settles.
  const tick = (prompt: string) =>
    document.querySelector(`[role="checkbox"][aria-label*="${prompt}"]`)?.getAttribute('data-state')
  expect(tick('Prompt a')).toBe('unchecked')
  expect(tick('Prompt b')).toBe('checked')

  await act(async () =>
    continued.resolve({
      resumed: [{ sessionId: 'b', outcome: 'resumed' }],
      continued: [{ sessionId: 'b', outcome: 'continued' }],
      sessions: [offered[0]],
      failed: []
    })
  )
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
  expect(checkbox(0).hasAttribute('disabled')).toBe(false)
  await act(async () => checkbox(0).click())
  expect(button('Resume 1 chat').disabled).toBe(false)

  failed = [{ ...failure('b'), retryable: false }]
  await act(async () => void (await refreshNativeChatRestartOffer()))
  expect(checkbox(0).hasAttribute('disabled')).toBe(true)
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
  expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(3)
  await act(async () => button('Dismiss "Prompt a" in workspace').click())
  expect(rpc.mock.calls.at(-1)?.slice(1)).toEqual([
    'agentSession.restartResumableDismiss',
    { sessionIds: ['a'] }
  ])
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Prompt a')
  expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
  await act(async () => button('Dismiss all').click())
  expect(rpc.mock.calls.at(-1)?.slice(1)).toEqual(['agentSession.restartResumableDismiss', {}])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  // Dismissing is bookkeeping, not a resume: neither form raises a toast.
  expect(toast).not.toHaveBeenCalled()
})
