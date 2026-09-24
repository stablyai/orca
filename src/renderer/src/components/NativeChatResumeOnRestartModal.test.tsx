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
import { consumeNativeChatResumeOnRestartDialogRequest } from './native-chat-resume-on-restart-dialog'
import {
  _resetNativeChatRestartOffer,
  getNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc
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

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === text
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
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
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
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
  // Row and preference checkboxes are buttons too; the controls are what is left after them.
  const controls = document.querySelectorAll('[role="dialog"] button:not([role="checkbox"])')
  expect([...controls].map((entry) => entry.textContent?.trim())).toEqual([
    'Dismiss all',
    'Resume 2 chats',
    'Close'
  ])
})

// Closing is the only snooze, so it carries the whole of one: saves the preference like every
// other way out, and calls NOTHING — the offer is the host's and stays exactly where it was.
it('snoozes to the status-bar offer when the dialog is closed', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
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
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
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
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
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
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
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
  await act(async () =>
    root.render(
      <TooltipProvider>
        <NativeChatResumeOnRestartModal />
        <NativeChatResumeStatusSegment iconOnly={false} />
      </TooltipProvider>
    )
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
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
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
  await act(async () =>
    root.render(
      <StrictMode>
        <NativeChatResumeOnRestartModal />
      </StrictMode>
    )
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
          sessions: offered
        }
  )
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
  expect(toast).toHaveBeenCalledWith(
    '2 chats could not be continued. Open them to continue manually.'
  )
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
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
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
    await act(async () => root.render(<NativeChatResumeOnRestartModal />))
    await act(async () => button('Resume 2 chats').click())
    const notices = vi
      .mocked(toast)
      .mock.calls.map(([text]) => text)
      .join(' ')
    expect(notices).toContain(
      outcome === 'pending' || outcome === 'unknown' ? 'unconfirmed' : 'could not be continued'
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
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
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
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
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

it('keeps an unconfirmed delivery visible when another chat was refused', async () => {
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
  await act(async () => root.render(<NativeChatResumeOnRestartModal />))
  await act(async () => button('Resume 2 chats').click())
  expect(toast).toHaveBeenCalledWith('1 chat could not be continued. Open it to continue manually.')
  expect(vi.mocked(toast).mock.calls.at(-1)?.[0]).toBe(
    'Continuation delivery is unconfirmed for 1 chat. Open it to check before sending another message.'
  )
})
