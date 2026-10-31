// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests
} from '@/lib/workspace-switch-user-act'

const transport = vi.hoisted(() => ({
  readSession: vi.fn(),
  subscribe: vi.fn()
}))

vi.mock('./native-chat-session-transport', () => ({
  getNativeChatSessionTransport: () => transport
}))

import {
  useNativeChatLiveSession,
  type UseNativeChatLiveSessionArgs
} from './use-native-chat-live-session'

const ARGS: UseNativeChatLiveSessionArgs = {
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  agent: 'claude',
  sessionId: 'sess-1',
  transcriptPath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\-repo\\sess-1.jsonl'
}

function Probe(props: UseNativeChatLiveSessionArgs): null {
  useNativeChatLiveSession(props)
  return null
}

const roots: Root[] = []

async function mount(args: UseNativeChatLiveSessionArgs = ARGS): Promise<void> {
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => {
    root.render(createElement(Probe, args))
  })
}

function lastWakes(): { read: unknown; subscribe: unknown } {
  return {
    read: transport.readSession.mock.calls.at(-1)?.[4],
    subscribe: transport.subscribe.mock.calls.at(-1)?.[0]?.wakeWslDistro
  }
}

// stack audit E9-2: only the user's own open of a chat may start its stopped WSL distro.
describe('useNativeChatLiveSession: WSL distro wake', () => {
  beforeEach(() => {
    resetWorkspaceSwitchUserActsForTests()
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      agentStatusByPaneKey: {},
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wake only reads each tab's id.
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }], 'wt-2': [{ id: 'tab-2' }] } as never
    })
    transport.readSession.mockReset().mockResolvedValue({ messages: [] })
    transport.subscribe.mockReset().mockReturnValue(() => {})
  })

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount())
    }
  })

  it('never asks to start the distro for a launch restore or remount', async () => {
    await mount()

    expect(lastWakes()).toEqual({ read: { wakeWslDistro: false }, subscribe: false })
  })

  it("asks once for the mount the user's switch caused, and not again on a remount", async () => {
    noteUserWorkspaceSwitch('wt-1')
    await mount()
    expect(lastWakes()).toEqual({ read: { wakeWslDistro: true }, subscribe: true })

    act(() => roots.splice(0).forEach((root) => root.unmount()))
    await mount()
    expect(lastWakes()).toEqual({ read: { wakeWslDistro: false }, subscribe: false })
  })

  it("a chat in another workspace mounting in the switch window doesn't ask", async () => {
    noteUserWorkspaceSwitch('wt-1')
    await mount({ ...ARGS, paneKey: 'tab-2:11111111-1111-4111-8111-111111111111' })
    expect(lastWakes()).toEqual({ read: { wakeWslDistro: false }, subscribe: false })
  })
})
