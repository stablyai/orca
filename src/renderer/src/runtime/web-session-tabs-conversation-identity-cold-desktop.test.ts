// A paired desktop that (re)connects while a headless host's Codex pane sits idle under a neutral
// title must open that pane's conversation from the host's published identity, with no status row.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

import { useAppStore } from '@/store'
import { resolveNativeChatSession } from '@/components/native-chat/native-chat-pane-resolution'
import { canToggleNativeChat } from '@/components/native-chat/native-chat-availability'
import {
  hostLeafConversation,
  offeredHostLeafAgent,
  selectOfferedHostConversationAgentsByLeaf,
  soleHostConversationLeafId
} from '@/components/native-chat/native-chat-leaf-conversation-identity'
import { resolvePaneAgentSessionId } from '@/components/terminal-pane/pane-agent-session-id'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch,
  decideWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'

const ENVIRONMENT_ID = 'cold-desktop-env'
const FIXTURE_PATH = join(
  __dirname,
  '../../../shared/__fixtures__/terminal-conversation-identity-idle-frame.json'
)
const PARITY_FRAMES_PATH = join(
  __dirname,
  '../../../shared/__fixtures__/terminal-conversation-offer-parity-frames.json'
)

type FixtureTab = Record<string, unknown> & { parentTabId: string; leafId: string }

function readFixtureFrame(): RuntimeMobileSessionTabsResult {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
}

function applyFrame(frame: RuntimeMobileSessionTabsResult): void {
  // Why a JSON round trip: the desktop only ever sees what survived the wire.
  const received: RuntimeMobileSessionTabsResult = JSON.parse(JSON.stringify(frame))
  applyWebSessionTabsStorePatch(
    (state) => applyWebSessionTabsSnapshot(state, received, ENVIRONMENT_ID, Date.now()),
    {
      frames: [
        {
          environmentId: ENVIRONMENT_ID,
          worktreeId: received.worktree,
          decision: decideWebSessionTabsSnapshot(received, ENVIRONMENT_ID)
        }
      ]
    },
    received,
    false
  )
}

function fixtureTab(frame: RuntimeMobileSessionTabsResult): FixtureTab {
  const tab = frame.tabs[0]
  if (!tab || tab.type !== 'terminal') {
    throw new Error('fixture must hold one terminal tab')
  }
  return tab
}

function mirroredTab(frame: RuntimeMobileSessionTabsResult) {
  const localTabId = toWebTerminalSurfaceTabId(fixtureTab(frame).parentTabId)
  const mirrored = useAppStore
    .getState()
    .tabsByWorktree[frame.worktree]?.find((tab) => tab.id === localTabId)
  expect(mirrored).toBeDefined()
  return { localTabId, mirrored }
}

/** The agent each entry point hands `canToggleNativeChat`, and its verdict. */
function chatControls(frame: RuntimeMobileSessionTabsResult, leafId: string) {
  const state = useAppStore.getState()
  const { localTabId, mirrored } = mirroredTab(frame)
  const status = state.agentStatusByPaneKey[makePaneKey(localTabId, leafId)]
  const detectedAgent = status?.agentType ?? null
  const agents = {
    header: detectedAgent
      ? null
      : (selectOfferedHostConversationAgentsByLeaf(mirrored)[leafId] ?? null),
    tabMenu: detectedAgent
      ? null
      : offeredHostLeafAgent(
          hostLeafConversation(mirrored, soleHostConversationLeafId(mirrored)),
          undefined
        ),
    shortcut: detectedAgent
      ? null
      : offeredHostLeafAgent(hostLeafConversation(mirrored, leafId), status)
  }
  const allowed = (conversationAgent: string | null) =>
    canToggleNativeChat({
      experimentalNativeChatEnabled: true,
      contentType: 'terminal',
      launchAgent: detectedAgent ? null : mirrored?.launchAgent,
      detectedAgent,
      conversationAgent,
      nativeChatTranscriptIsLocalReadable: true
    })
  return {
    agents,
    allowed: {
      header: allowed(agents.header),
      tabMenu: allowed(agents.tabMenu),
      shortcut: allowed(agents.shortcut)
    }
  }
}

function resolveLeaf(frame: RuntimeMobileSessionTabsResult, leafId: string) {
  const state = useAppStore.getState()
  const hostTab = fixtureTab(frame)
  const localTabId = toWebTerminalSurfaceTabId(hostTab.parentTabId)
  const paneKey = makePaneKey(localTabId, leafId)
  const mirrored = state.tabsByWorktree[frame.worktree]?.find((tab) => tab.id === localTabId)
  expect(mirrored).toBeDefined()
  return resolveNativeChatSession({
    paneKey,
    launchAgent: mirrored?.launchAgent,
    agentStatusEntry: state.agentStatusByPaneKey[paneKey],
    conversation: mirrored?.hostConversationByLeafId?.[leafId],
    ptyId: mirrored?.ptyId ?? null
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  resetWebSessionTabsSnapshotFreshnessForTests()
})

describe('cold paired desktop, idle headless Codex pane', () => {
  it('resolves the pane conversation from the published identity while no status exists', () => {
    const frame = readFixtureFrame()
    const tab = fixtureTab(frame)
    expect(tab).not.toHaveProperty('agentStatus')
    expect(tab).not.toHaveProperty('launchAgent')

    applyFrame(frame)

    expect(useAppStore.getState().agentStatusByPaneKey).toEqual({})
    const resolution = resolveLeaf(frame, tab.leafId)
    expect(resolution?.sessionId ?? null).toBe('ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31')
    expect(resolution?.transcriptPath).toBe('/fixture/rollout.jsonl')
    expect(resolution?.agent).toBe('codex')
    expect(resolution?.authority).toBe('address')
    expect(chatControls(frame, tab.leafId).allowed).toEqual({
      header: true,
      tabMenu: true,
      shortcut: true
    })
    const paneKey = makePaneKey(toWebTerminalSurfaceTabId(tab.parentTabId), tab.leafId)
    expect(resolvePaneAgentSessionId(useAppStore.getState(), paneKey)).toBe(
      'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31'
    )
  })

  it('never lets one split leaf borrow its sibling identity', () => {
    const frame = readFixtureFrame()
    const tab = fixtureTab(frame)
    const siblingLeaf = '22222222-2222-4222-8222-222222222222'
    const host = frame.tabs[0]
    if (host?.type !== 'terminal') {
      throw new Error('fixture must hold one terminal tab')
    }
    const {
      conversationIdentity: _identity,
      conversationOfferedWithoutStatus: _offer,
      ...plain
    } = host
    frame.tabs.push({
      ...plain,
      id: `${tab.parentTabId}::${siblingLeaf}`,
      leafId: siblingLeaf,
      isActive: false,
      status: 'ready',
      terminal: 'terminal-sibling'
    })

    applyFrame(frame)

    expect(resolveLeaf(frame, tab.leafId)?.sessionId).toBe('ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31')
    expect(resolveLeaf(frame, siblingLeaf)).toBeNull()
    const siblingPane = makePaneKey(toWebTerminalSurfaceTabId(tab.parentTabId), siblingLeaf)
    expect(resolvePaneAgentSessionId(useAppStore.getState(), siblingPane)).toBeNull()
    expect(chatControls(frame, siblingLeaf).allowed.shortcut).toBe(false)
    // Why: with two mirrored-or-not leaves the tab-wide menu has no unambiguous leaf.
    expect(chatControls(frame, siblingLeaf).agents.header).toBeNull()
  })

  it('gives no address when the host does not offer the identity on a statusless tab', () => {
    const frame = readFixtureFrame()
    const tab = fixtureTab(frame)
    delete tab.conversationOfferedWithoutStatus

    applyFrame(frame)

    expect(resolveLeaf(frame, tab.leafId)).toBeNull()
    expect(chatControls(frame, tab.leafId).allowed).toEqual({
      header: false,
      tabMenu: false,
      shortcut: false
    })
  })

  it.each([
    ['an aged no-launch remnant under a shell title (genuine status without an agent)', null],
    ['the same remnant with a launch record', 'session-S']
  ])(
    'never takes a missing agent label from the identity beside a genuine status: %s',
    (name, sessionId) => {
      const parity = JSON.parse(readFileSync(PARITY_FRAMES_PATH, 'utf8'))[name]
      const frame: RuntimeMobileSessionTabsResult = {
        worktree: 'repo::/worktree',
        publicationEpoch: 'headless:1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: parity.capablePhone.id,
        activeTabType: 'terminal',
        tabs: [parity.capablePhone]
      }
      applyFrame(frame)
      const leafId = fixtureTab(frame).leafId
      const resolution = resolveLeaf(frame, leafId)
      const allowed = chatControls(frame, leafId).allowed
      if (sessionId === null) {
        expect(resolution).toBeNull()
        expect(allowed).toEqual({ header: false, tabMenu: false, shortcut: false })
        return
      }
      expect(resolution).toMatchObject({ agent: 'codex', sessionId, authority: 'address' })
      expect(allowed).toEqual({ header: true, tabMenu: true, shortcut: true })
    }
  )
})
