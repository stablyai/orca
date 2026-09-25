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
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
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

/** Sonner types a toast action as either a labelled action or arbitrary content; only the former
 *  can be pressed. */
function press(entry: unknown): void {
  if (
    typeof entry !== 'object' ||
    entry === null ||
    !('onClick' in entry) ||
    typeof entry.onClick !== 'function'
  ) {
    throw new Error('toast action is not clickable')
  }
  entry.onClick()
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

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  vi.mocked(toast).mockClear()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalNativeChat: true },
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

// Chat UI decides how new launches open; a chat that was working is still offered back.
it('offers the resume with Chat UI off when the host holds structured chats', async () => {
  const priorApi = window.api
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...priorApi,
      app: { ...priorApi?.app, hasLocalStructuredAgentSessions: async () => true }
    }
  })
  try {
    rpc.mockResolvedValue({ sessions: offered })
    useAppStore.setState({ settings: { ...getDefaultSettings(''), experimentalNativeChat: false } })
    await mount(<NativeChatResumeOnRestartModal />)

    expect(button('Resume 2 chats')).toBeTruthy()
  } finally {
    Object.defineProperty(window, 'api', { configurable: true, value: priorApi })
  }
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

// Bookkeeping must never gate the user's own action: the dismissal lands in the UI either way, and
// a write Orca could not confirm is reported instead of trapping the dialog open.
it('reports a dismissal the host never confirmed instead of trapping the dialog', async () => {
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: offered }
    }
    throw new Error('response lost')
  })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Dismiss all').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(toast).toHaveBeenCalledWith(expect.stringContaining('was not confirmed'))
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
      experimentalNativeChat: true,
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
  await act(async () => useAppStore.getState().updateSettings({ experimentalNativeChat: false }))
  await act(async () => useAppStore.getState().updateSettings({ experimentalNativeChat: true }))
  expect(rpc.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', {}]
  ])
  // Automatic is never silent, and the offer shrinks by what the host says it reattached.
  expect(toast).toHaveBeenCalledWith('Resumed 2 chats and asked them to continue')
  expect(offerIds()).toEqual([])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

// An opted-in launch reports the chats the host would not take, exactly as the button does.
it('reports refused and newly ineligible chats on an opted-in launch', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalNativeChat: true,
      nativeChatResumeWorkOnRestart: true
    }
  })
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered }
      : {
          resumed: [],
          continued: [{ sessionId: 'a', outcome: 'refused' }],
          sessions: offered
        }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  // One count, no names: the modal has the list. The host listed no failure, so there is nothing
  // the toast may forget — a chat that only dropped out of the answer is still an offer.
  expect(toast).toHaveBeenCalledWith(
    '2 chats couldn’t be resumed',
    expect.objectContaining({ action: expect.objectContaining({ label: 'Show' }) })
  )
  expect(vi.mocked(toast).mock.calls.at(-1)?.[1]).not.toHaveProperty('cancel')
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

it.each(['pending', 'unknown', 'refused', 'missing'])(
  'reports a %s continuation instead of silently closing',
  async (outcome) => {
    rpc.mockImplementation(async (_target, method) =>
      method === 'agentSession.restartResumable'
        ? { sessions: offered }
        : {
            continued:
              outcome === 'missing' ? [] : offered.map(({ sessionId }) => ({ sessionId, outcome })),
            sessions: offered
          }
    )
    await mount(<NativeChatResumeOnRestartModal />)
    await act(async () => button('Resume 2 chats').click())
    const notices = vi
      .mocked(toast)
      .mock.calls.map(([text]) => text)
      .join(' ')
    expect(notices).toContain(
      outcome === 'pending' || outcome === 'unknown'
        ? 'Couldn’t confirm 2 chats were resumed'
        : '2 chats couldn’t be resumed'
    )
    expect(notices).not.toContain('asked them to continue')
    expect(rpc).toHaveBeenCalledTimes(2)
  }
)

// The response is not validated, so a payload this side cannot read is treated like a lost one: the
// message may well have gone out, and the offer must not shrink over chats nothing confirmed.
it('reports an unreadable resume response as an unconfirmed delivery', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable' ? { sessions: offered } : { sessions: offered }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  expect(toast).toHaveBeenCalledWith(expect.stringContaining('unconfirmed'))
  expect(offerIds()).toEqual(['a', 'b'])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('reports a lost resume response without retrying the action', async () => {
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: offered }
    }
    throw new Error('response lost')
  })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  expect(toast).toHaveBeenCalledWith(expect.stringContaining('unconfirmed'))
  // A lost action response is followed by a read-only reconciliation, never a retry.
  expect(rpc.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', { sessionIds: ['a', 'b'] }],
    ['agentSession.restartResumable', undefined]
  ])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('counts an unconfirmed delivery apart from a refusal in one notice', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered }
      : {
          continued: [
            { sessionId: 'a', outcome: 'unknown' },
            { sessionId: 'b', outcome: 'refused' }
          ],
          sessions: offered
        }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  expect(vi.mocked(toast).mock.calls).toEqual([
    [
      '1 chat couldn’t be resumed',
      expect.objectContaining({ description: 'Couldn’t confirm 1 other chat was resumed' })
    ]
  ])
})

// The toast is gone in seconds; what it can do has to land somewhere durable: the list, or the
// host's records.
it('lets the failure notice open the list or forget the chats it counted', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered }
      : method === 'agentSession.restartContinue'
        ? // `b` was requested too but dropped out of the answer without the host failing it.
          {
            continued: [{ sessionId: 'a', outcome: 'refused' }],
            sessions: [offered[1]!],
            failed: [failure('a')]
          }
        : { dismissed: 1, sessions: [offered[1]!], failed: [] }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => button('Resume 2 chats').click())
  const options = vi.mocked(toast).mock.calls.at(-1)?.[1]
  consumeNativeChatResumeOnRestartDialogRequest()
  await act(async () => press(options?.action))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => press(options?.cancel))
  expect(rpc.mock.calls.at(-1)?.slice(1)).toEqual([
    'agentSession.restartResumableDismiss',
    { sessionIds: ['a'] }
  ])
})

/** Every button in the dialog, in order; row checkboxes are buttons too, so they are left out. */
function dialogControls(): (string | null)[] {
  return [...document.querySelectorAll('[role="dialog"] button:not([role="checkbox"])')].map(
    (entry) => entry.textContent?.trim() || entry.getAttribute('aria-label')
  )
}

// The old toast said "1 chat could not be continued" and vanished. The chat now stays in the same
// dialog — same title, checkboxes and footer — with its row saying what went wrong and what to do.
it('keeps a chat the resume could not carry on in the same dialog, with what to do', async () => {
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
      'Close it, then retry.'
    )
    // A retry can fix an ownership clash, so the row starts selected.
    expect(checkbox(0).getAttribute('data-state')).toBe('checked')

    await act(async () => button(from === 'footer' ? 'Resume 1 chat' : 'Retry').click())
    expect(rpc.mock.calls.at(-1)?.slice(1)).toEqual([
      'agentSession.restartContinue',
      { sessionIds: ['b'] }
    ])
    expect(toast).toHaveBeenCalledWith('Resumed 1 chat and asked it to continue')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  }
)

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
})
