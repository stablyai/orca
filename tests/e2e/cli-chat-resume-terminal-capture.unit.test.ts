// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { captureSourceTerminal } from '@/components/tab-bar/cli-chat-resume-terminal-capture'
import { buildMirroredTerminalTabs } from '@/runtime/web-session-tabs-sync/terminal-build'
import type { captureTerminalSurfaceIdentity } from '../../src/shared/terminal-tab-close'
import {
  createHarness,
  WORKTREE_ID,
  TAB_ID,
  LEAF_ID
} from '../../src/main/runtime/__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  rpc.mockReset()
})
function source(ptyId: string | undefined, executionHostId: 'local' | 'runtime:paired' = 'local') {
  return {
    workspaceId: WORKTREE_ID,
    tabId: TAB_ID,
    paneKey: `${TAB_ID}:${LEAF_ID}`,
    agent: 'codex' as const,
    providerSessionId: 'conversation',
    executionHostId,
    ptyId
  }
}
it('captures a real mirrored source on host coordinates and keeps client continuity independent of host clocks', async () => {
  const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
  harness.editSession((session) => ({
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [WORKTREE_ID]: session.tabsByWorktree[WORKTREE_ID].map((row) => ({ ...row, generation: 7 }))
    }
  }))
  const snapshot = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const terminal = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  const [mirror] = buildMirroredTerminalTabs(snapshot, 'paired', new Map(), {}, {}, 0, 9000)
  if (!mirror || !terminal.presentation) {
    throw new Error('Expected a real published terminal')
  }
  const mirrored = {
    ...source(mirror.layout.ptyIdsByLeafId?.[LEAF_ID], 'runtime:paired'),
    tabId: mirror.tab.id,
    paneKey: `${mirror.tab.id}:${LEAF_ID}`
  }
  const seedMirror = () => {
    const presentationState: NonNullable<Parameters<typeof captureTerminalSurfaceIdentity>[0]> = {
      tabsByWorktree: { [WORKTREE_ID]: [mirror.tab] },
      terminalLayoutsByTabId: { [mirror.tab.id]: mirror.layout },
      terminalPtyIncarnationsByPaneKey: {}
    }
    useAppStore.setState({
      ...presentationState,
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'runtime:paired'
    })
  }
  seedMirror()
  rpc.mockImplementation(
    async (_target, method, params: { paneKey: string; worktreeId: string }) => {
      expect(method).toBe('terminal.resolvePane')
      expect(params).toEqual({ paneKey: `${TAB_ID}:${LEAF_ID}`, worktreeId: WORKTREE_ID })
      return { terminal: harness.runtime.resolveTerminalPane(params.paneKey, params.worktreeId) }
    }
  )
  expect(mirrored.tabId).not.toBe(terminal.presentation.identity.tabId)
  expect(mirror.tab.createdAt).not.toBe(terminal.presentation.identity.createdAt)
  expect(mirror.tab.generation ?? 0).not.toBe(terminal.presentation.identity.generation)
  expect(await captureSourceTerminal(mirrored)).toEqual({
    target: { kind: 'environment', environmentId: 'paired' },
    handle: terminal.handle,
    incarnationId: terminal.incarnationId,
    presentation: terminal.presentation
  })
})
