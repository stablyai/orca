import { afterEach, describe, expect, it } from 'vitest'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane
} from '@/components/terminal-pane/agent-status/renderer-owned-agent-status-registry'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { ENV, LEAF_ID, NOW, WT, makeState } from '../testing/web-session-tabs-sync.test-fixture'
import { buildMirroredAgentStatusPatch } from './agent-status-patch'

const HOST_TAB_ID = 'host-tab-1'
const PANE_KEY = `${toWebTerminalSurfaceTabId(HOST_TAB_ID)}:${LEAF_ID}`
const ORCHESTRATION = {
  taskId: 'task-1',
  dispatchId: 'dispatch-1',
  parentTerminalHandle: 'term_coordinator',
  coordinatorHandle: 'term_coordinator'
}

function hostWorkerRow(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'host prompt',
    agentType: 'claude',
    paneKey: `${HOST_TAB_ID}:${LEAF_ID}`,
    worktreeId: WT,
    terminalHandle: 'term_worker',
    updatedAt: NOW - 5_000,
    stateStartedAt: NOW - 5_000,
    stateHistory: [],
    ...overrides
  }
}

function workerSurface(agentStatus: AgentStatusEntry): RuntimeMobileSessionTerminalClientTab {
  return {
    type: 'terminal',
    id: `${HOST_TAB_ID}::${LEAF_ID}`,
    title: 'Claude Code',
    parentTabId: HOST_TAB_ID,
    leafId: LEAF_ID,
    isActive: true,
    status: 'ready',
    terminal: 'term_worker',
    agentStatus
  }
}

function buildPatch(
  state: ReturnType<typeof makeState>,
  surface: RuntimeMobileSessionTerminalClientTab
): ReturnType<typeof buildMirroredAgentStatusPatch> {
  return buildMirroredAgentStatusPatch(state, [], [surface], [], ENV, WT, new Set(), NOW)
}

describe('buildMirroredAgentStatusPatch worker lineage', () => {
  let releasePane: (() => void) | undefined
  afterEach(() => {
    releasePane?.()
    releasePane = undefined
  })

  it('keeps host lineage on a working row the client fences', () => {
    releasePane = registerRendererOwnedAgentStatusPane(PANE_KEY, ENV)
    markRendererOwnedAgentStatusWrite(PANE_KEY)
    const clientRow: AgentStatusEntry = {
      state: 'working',
      prompt: 'client prompt',
      agentType: 'claude',
      paneKey: PANE_KEY,
      worktreeId: WT,
      connectionId: ENV,
      tabId: toWebTerminalSurfaceTabId(HOST_TAB_ID),
      terminalHandle: 'term_stale',
      updatedAt: NOW - 100,
      stateStartedAt: NOW - 100,
      stateHistory: []
    }
    const state = makeState({
      agentStatusByPaneKey: acceptedAgentStatuses([[PANE_KEY, clientRow]])
    })

    const patch = buildPatch(state, workerSurface(hostWorkerRow({ orchestration: ORCHESTRATION })))

    const row = patch?.agentStatusByPaneKey.get(PANE_KEY)
    expect(row).toMatchObject({
      state: 'working',
      prompt: 'client prompt',
      updatedAt: NOW - 100,
      terminalHandle: 'term_worker',
      orchestration: ORCHESTRATION
    })
  })

  it('lands a frame whose only change is newly attached orchestration', () => {
    const plainFrame = workerSurface(hostWorkerRow())
    const first = buildPatch(makeState(), plainFrame)
    const state = makeState(first ?? {})
    expect(buildPatch(state, plainFrame)).toBeNull()

    const patch = buildPatch(state, workerSurface(hostWorkerRow({ orchestration: ORCHESTRATION })))

    expect(patch?.agentStatusByPaneKey.get(PANE_KEY)?.orchestration).toEqual(ORCHESTRATION)
  })
})
