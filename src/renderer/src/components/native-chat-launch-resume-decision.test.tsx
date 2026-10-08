// @vitest-environment happy-dom
// Until the launch decides whether it resumes this machine's chats itself, nothing else offers to
// carry one on; from its decision on, the chats it resumes are named, with no moment in between.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import {
  _resetNativeChatRestartOffer,
  useNativeChatRestartOffer,
  useNativeChatRestartResuming
} from './native-chat-resume-on-restart-store'
import {
  _resetNativeChatLaunchResumeDecision,
  useNativeChatLaunchResumePending
} from './native-chat-launch-resume-decision'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
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

/** What Continue reads, rendered each time it changes. */
const seen: { pending: boolean; resuming: readonly string[] }[] = []
function Probe({ launch }: { launch: boolean }): null {
  useNativeChatRestartOffer(launch)
  seen.push({
    pending: useNativeChatLaunchResumePending(),
    resuming: useNativeChatRestartResuming()
  })
  return null
}

function settings(autoResume: boolean | undefined): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalStructuredNativeChat: true,
      ...(autoResume === undefined ? {} : { nativeChatResumeWorkOnRestart: autoResume })
    }
  })
}

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  _resetNativeChatLaunchResumeDecision()
  useAppStore.setState(useAppStore.getInitialState(), true)
  seen.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('holds Continue back from the settings wait until the opted-in launch names its chats', async () => {
  const read = Promise.withResolvers<unknown>()
  rpc.mockImplementation((_target, method) =>
    method === 'agentSession.restartResumable' ? read.promise : new Promise(() => {})
  )
  // Settings not loaded yet: the launch may still resume.
  await act(async () => root.render(<Probe launch={false} />))
  expect(seen.at(-1)).toEqual({ pending: true, resuming: [] })

  settings(true)
  await act(async () => root.render(<Probe launch />))
  expect(seen.at(-1)).toEqual({ pending: true, resuming: [] })

  await act(async () => read.resolve({ sessions: offered }))

  expect(seen.at(-1)).toEqual({ pending: false, resuming: ['a', 'b'] })
  // Never a render where the launch had decided and its chats were not yet named.
  expect(seen.some((entry) => !entry.pending && entry.resuming.length === 0)).toBe(false)
})

it('holds nothing back once the launch found nothing to resume', async () => {
  settings(true)
  rpc.mockResolvedValue({ sessions: [] })
  await act(async () => root.render(<Probe launch />))
  expect(seen.at(-1)).toEqual({ pending: false, resuming: [] })
})

it('holds nothing back when the launch asks instead of resuming', () => {
  settings(false)
  act(() => root.render(<Probe launch={false} />))
  expect(seen.at(-1)).toEqual({ pending: false, resuming: [] })
})
