import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const groupsByWorktree: Record<string, { id: string; tabOrder: string[] }[]> = {}
  const noted: string[][] = []
  const flags: { frameDrawn: boolean; routed: boolean; supported: boolean | null } = {
    frameDrawn: true,
    routed: true,
    supported: true
  }
  return {
    state: { groupsByWorktree },
    ...flags,
    /** Tabs the server's frames hold, by desktop id → server id. */
    serverIds: new Map<string, string>(),
    noted
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  readCachedRuntimeEnvironmentCapability: () => mocks.supported
}))
vi.mock('@/runtime/web-session-tabs-sync/frame-drawn-server-workspaces', () => ({
  isFrameDrawnServerWorkspace: () => mocks.frameDrawn
}))
vi.mock('@/runtime/server-layout-apply-routes', () => ({
  serverLayoutApplyRoute: () =>
    mocks.routed ? { serverTabId: (id: string) => mocks.serverIds.get(id) ?? null } : null
}))
vi.mock('./desktop-created-server-tabs', () => ({
  noteDesktopCreatedServerTab: (...args: string[]) => mocks.noted.push(args)
}))

import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import {
  holdFrameDrawnProvisionalChatTab,
  withFrameDrawnChatTabPlacement
} from './frame-drawn-chat-tab-placement'

const TAB = 'structured-agent-session-claude_1'
const params: StructuredAgentSessionCreateParams = {
  envelope: {
    sessionId: 'claude_1',
    clientOperationId: 'op-1',
    expectedRuntimeFence: null,
    payloadFingerprint: 'fp'
  },
  worktree: 'id:wt',
  agent: 'claude'
}
const intent = {
  target: { kind: 'environment', environmentId: 'env-1' } as const,
  worktreeId: 'wt',
  sessionId: 'claude_1',
  params
}

describe('a chat opened in a frame-drawn server workspace (L270)', () => {
  beforeEach(() => {
    mocks.frameDrawn = true
    mocks.supported = true
    mocks.routed = true
    mocks.serverIds = new Map([
      ['web-terminal-pty-1', 'host-tab-1'],
      ['editor-1', 'editor-1'],
      ['editor-2', 'editor-2']
    ])
    mocks.noted = []
    mocks.state.groupsByWorktree = {
      wt: [
        { id: 'g-1', tabOrder: ['editor-0'] },
        { id: 'g-2', tabOrder: ['editor-1', 'sim-1', TAB, 'editor-2'] }
      ]
    }
  })

  it("names the tab's group and the server tab before it, skipping tabs the server lacks", () => {
    expect(withFrameDrawnChatTabPlacement(intent)).toEqual({
      ...params,
      tabPlacement: { groupId: 'g-2', afterTabId: 'editor-1' }
    })
  })

  it("names the server's id for a terminal tab before the chat", () => {
    mocks.state.groupsByWorktree.wt[1].tabOrder = ['web-terminal-pty-1', TAB]
    expect(withFrameDrawnChatTabPlacement(intent)).toEqual({
      ...params,
      tabPlacement: { groupId: 'g-2', afterTabId: 'host-tab-1' }
    })
  })

  it('names the group alone while the server takes no layout intents for the workspace', () => {
    mocks.routed = false
    expect(withFrameDrawnChatTabPlacement(intent)).toEqual({
      ...params,
      tabPlacement: { groupId: 'g-2' }
    })
  })

  it('names the group alone when no server tab comes before the chat', () => {
    mocks.state.groupsByWorktree.wt[1].tabOrder = [TAB, 'editor-2']
    expect(withFrameDrawnChatTabPlacement(intent)).toEqual({
      ...params,
      tabPlacement: { groupId: 'g-2' }
    })
  })

  it.each([false, null])(
    "sends no place when the host's cached capability reads %s",
    (supported) => {
      mocks.supported = supported
      expect(withFrameDrawnChatTabPlacement(intent)).toBe(intent.params)
    }
  )

  it('sends no place, and holds nothing, outside a frame-drawn workspace', () => {
    mocks.frameDrawn = false
    expect(withFrameDrawnChatTabPlacement(intent)).toBe(intent.params)
    holdFrameDrawnProvisionalChatTab(intent.target, 'wt', TAB)
    holdFrameDrawnProvisionalChatTab({ kind: 'local' }, 'wt', TAB)
    expect(mocks.noted).toEqual([])
  })

  it('holds the provisional tab for its server until the server lists it', () => {
    holdFrameDrawnProvisionalChatTab(intent.target, 'wt', TAB)
    expect(mocks.noted).toEqual([['env-1', 'wt', TAB]])
  })
})
