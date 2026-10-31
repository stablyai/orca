import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeEnvironmentStatus } from '@/store/slices/runtime-status-types'
import { WORKTREE_ID, makeState } from './tab-session-history-fixtures.test-fixture'
import { makeTerminalTab } from '../worktree-jump-palette-test-fixtures'
import { resolveCliChatResumeSource } from './cli-chat-resume-source'
import { captureSourceTerminal } from './cli-chat-resume-terminal-capture'
import { buildMirroredStoppedSwitchSourcePatch } from '@/runtime/web-session-tabs-sync/stopped-switch-source-patch'
import { readMirroredStoppedSwitchSource } from '../terminal-pane/stopped-switch-sources'
import { remountStoppedSwitchSource } from '../terminal-pane/pty-connection/stopped-switch-source-exit'
import type { ConnectPanePtySession } from '../terminal-pane/pty-connection/connect-pane-pty-session'
import type { TerminalSurface } from '@/runtime/web-session-tabs-sync/state'
import type { StoppedSwitchSourceFact } from '../../../../shared/stopped-switch-source'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import * as protocol from '../../../../shared/protocol-version'
import { POST_REPLAY_MODE_RESET } from '../../../../shared/terminal-mode-reset-profiles'

// A paired client (B) viewing a terminal whose agent a switch stopped on the host: main's fact on
// the frame's row gives B's pane its conversation, so the header offers the in-place retry, routed
// to the surface's own host and its retained exact source.

const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: rpc.call
}))

const HOST = 'runtime:server-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const TAB = toWebTerminalSurfaceTabId('host-tab-1')
const PANE = `${TAB}:${LEAF}`
const BOUND = 'remote:server-1@@handle-1'

function surface(fact?: StoppedSwitchSourceFact, handle = 'handle-1'): TerminalSurface {
  return {
    type: 'terminal',
    id: `host-tab-1::${LEAF}`,
    parentTabId: 'host-tab-1',
    leafId: LEAF,
    title: 'Terminal',
    isActive: true,
    status: 'ready',
    terminal: handle,
    ...(fact ? { incarnationId: fact.incarnationId, stoppedSwitchSource: fact } : {})
  }
}

function pairedClient(): void {
  makeState({}, { executionHostId: HOST })
  useAppStore.setState({
    tabsByWorktree: { [WORKTREE_ID]: [makeTerminalTab(TAB, WORKTREE_ID, 'Terminal')] },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: BOUND }
      }
    },
    runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>([
      [
        'server-1',
        {
          checkedAt: 1,
          status: {
            runtimeId: 'server-runtime',
            rendererGraphEpoch: 0,
            graphStatus: 'ready',
            authoritativeWindowId: null,
            liveTabCount: 1,
            liveLeafCount: 1,
            capabilities: [
              protocol.STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
              protocol.STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
              protocol.STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
              protocol.STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
            ]
          }
        }
      ]
    ])
  })
}

/** One frame through the sync's derivation, as every frame's final patch runs it. */
function applyFrame(row: TerminalSurface): void {
  const state = useAppStore.getState()
  const patch = buildMirroredStoppedSwitchSourcePatch(
    state,
    state.agentConversationsByPaneKey,
    [row],
    WORKTREE_ID,
    []
  )
  if (patch) {
    useAppStore.setState(patch)
  }
}

const source = () =>
  resolveCliChatResumeSource(useAppStore.getState(), {
    tab: { id: TAB, worktreeId: WORKTREE_ID },
    paneKey: PANE
  })

beforeEach(() => {
  rpc.call.mockReset()
  pairedClient()
})

describe.each(['claude', 'codex'] as const)('a paired %s pane a switch stopped', (agent) => {
  const fact: StoppedSwitchSourceFact = {
    ptyId: 'host-pty-1',
    incarnationId: 'incarnation-1',
    agent,
    providerSessionId: `${agent}-conversation`
  }

  it('offers Switch to Chat UI from main’s fact, and retries in place on its own host', async () => {
    expect(source()).toBeNull()
    applyFrame(surface(fact))

    expect(readMirroredStoppedSwitchSource(TAB, LEAF, BOUND)).toEqual(fact)
    expect(readMirroredStoppedSwitchSource(TAB, LEAF, 'remote:server-1@@other')).toBeNull()
    const offered = source()
    expect(offered).toMatchObject({
      agent,
      providerSessionId: `${agent}-conversation`,
      executionHostId: HOST,
      paneKey: PANE,
      ptyId: BOUND
    })
    // An unchanged frame writes nothing; a second viewer derives the same from the same frame.
    const before = useAppStore.getState().agentConversationsByPaneKey
    applyFrame(surface({ ...fact }))
    expect(useAppStore.getState().agentConversationsByPaneKey).toBe(before)

    const presentation = {
      identity: {
        worktreeId: WORKTREE_ID,
        tabId: 'host-tab-1',
        leafId: LEAF,
        createdAt: 1,
        generation: 0,
        hasLeaf: true,
        ptyId: fact.ptyId,
        incarnationId: fact.incarnationId
      },
      hostIds: [HOST]
    }
    rpc.call.mockResolvedValue({
      terminal: {
        handle: 'handle-1',
        incarnationId: fact.incarnationId,
        tabId: 'host-tab-1',
        leafId: LEAF,
        ptyId: fact.ptyId,
        presentation
      }
    })
    await expect(captureSourceTerminal(offered!)).resolves.toMatchObject({
      target: { kind: 'environment', environmentId: 'server-1' },
      handle: 'handle-1',
      incarnationId: fact.incarnationId
    })
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'server-1' },
      'terminal.resolvePane',
      { paneKey: `host-tab-1:${LEAF}`, worktreeId: WORKTREE_ID }
    )
  })

  it('mounts a new viewer’s pane stopped from the frame, with nothing to reattach', () => {
    applyFrame(surface(fact))
    const died = vi.fn()
    const pane = { tabId: TAB, leafId: LEAF }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the remount reads only these session members.
    const session = {
      deps: { tabId: pane.tabId, onPaneProcessDied: died },
      pane: { id: 1, leafId: pane.leafId },
      handledExitPtyId: null
    } as unknown as ConnectPanePtySession
    expect(remountStoppedSwitchSource(session, 'remote:server-1@@other')).toBe(false)
    expect(remountStoppedSwitchSource(session, BOUND)).toBe(true)
    expect(died).toHaveBeenCalledExactlyOnceWith({
      paneId: 1,
      exitCode: 0,
      startup: null,
      reason: 'switch-stopped',
      replacesPtyId: BOUND,
      agent
    })
    expect(session.handledExitPtyId).toBe(BOUND)
  })

  it('repaints a reloaded viewer\u2019s pane with main\u2019s held screen, at its grid, before the overlay', () => {
    // An alternate-screen agent: the normal buffer under it is rebuilt first, then its frame.
    const screen = {
      data: '\x1b[?1049hHELD-FRAME',
      cols: 100,
      rows: 30,
      alternateScreen: true,
      scrollbackAnsi: 'before the agent'
    }
    applyFrame(surface({ ...fact, screen }))
    const order: string[] = []
    const write = vi.fn((data: string) => void order.push(data))
    const resize = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the remount reads only these session members.
    const session = {
      deps: { tabId: TAB, onPaneProcessDied: () => void order.push('overlay') },
      pane: { id: 1, leafId: LEAF, terminal: { cols: 80, rows: 24, resize } },
      handledExitPtyId: null,
      writeReplayData: write,
      writeInputModeGround: write,
      isPaneOnAlternateScreen: () => false
    } as unknown as ConnectPanePtySession
    expect(remountStoppedSwitchSource(session, BOUND)).toBe(true)
    expect(resize).toHaveBeenCalledExactlyOnceWith(100, 30)
    expect(session.suppressStructuralReplayPtyResize).toBe(false)
    const painted = order.join('')
    expect(painted.indexOf('before the agent')).toBeLessThan(painted.indexOf('HELD-FRAME'))
    // Screen-only: whatever this pane saved above it stays scrollable.
    expect(painted).not.toContain('\x1b[3J')
    expect(order.at(-2)).toBe(POST_REPLAY_MODE_RESET)
    expect(order.at(-1)).toBe('overlay')
  })

  it('drops the fact when the pane runs another process', () => {
    applyFrame(surface(fact))
    applyFrame(surface(undefined, 'handle-2'))
    expect(useAppStore.getState().agentConversationsByPaneKey[PANE]).toBeUndefined()
    expect(source()).toBeNull()
  })
})

it('offers nothing new against an older host, whose rows carry no fact', () => {
  applyFrame(surface())
  expect(useAppStore.getState().agentConversationsByPaneKey[PANE]).toBeUndefined()
  expect(source()).toBeNull()
})
