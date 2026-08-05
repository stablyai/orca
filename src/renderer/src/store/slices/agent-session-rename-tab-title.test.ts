import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../../shared/tab-title-resolution'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/path/wt1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TRANSCRIPT_PATH = '/home/dev/.claude/projects/wt1/session.jsonl'

const getRenamedTitle = vi.fn<(args: { transcriptPath: string }) => Promise<string | null>>()
const originalWindow = globalThis.window

beforeEach(() => {
  getRenamedTitle.mockReset()
  globalThis.window = { api: { agentSession: { getRenamedTitle } } } as never
})

afterEach(() => {
  globalThis.window = originalWindow
})

function seedAgentTab(store: ReturnType<typeof createTestStore>): string {
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  const tabId = store.getState().createTab(WORKTREE_ID).id
  const paneKey = makePaneKey(tabId, LEAF_ID)
  store.getState().setAgentStatus(paneKey, {
    state: 'working',
    prompt: 'What is 2+2? Answer in one word.',
    agentType: 'claude'
  })
  // Why: hook-reported provider sessions only reach the store through the hook
  // path; seed it directly so the transcript lookup has a path to scan.
  store.setState({
    agentStatusByPaneKey: {
      ...store.getState().agentStatusByPaneKey,
      [paneKey]: {
        ...store.getState().agentStatusByPaneKey[paneKey]!,
        providerSession: { key: 'session_id', id: 'session-1', transcriptPath: TRANSCRIPT_PATH }
      }
    }
  })
  return tabId
}

async function flushRenameRefresh(): Promise<void> {
  await vi.waitFor(() => expect(getRenamedTitle).toHaveBeenCalled())
  await Promise.resolve()
  await Promise.resolve()
}

describe('deliberate in-agent rename vs generated tab title', () => {
  it('lets a mid-session /rename win the tab label', async () => {
    const store = createTestStore()
    const tabId = seedAgentTab(store)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe('What is 2 2')

    getRenamedTitle.mockResolvedValue('billing-fix')
    store.getState().updateTabTitle(tabId, '✳ billing-fix')
    await flushRenameRefresh()

    expect(getRenamedTitle).toHaveBeenCalledWith({ transcriptPath: TRANSCRIPT_PATH })
    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(resolveTerminalTabTitle(tab, true)).toBe('✳ billing-fix')
    expect(
      resolveUnifiedTabLabel(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0], true)
    ).toBe('✳ billing-fix')
  })

  it('keeps the generated title when the agent only auto-summarized', async () => {
    const store = createTestStore()
    const tabId = seedAgentTab(store)

    getRenamedTitle.mockResolvedValue(null)
    store.getState().updateTabTitle(tabId, '✳ Answer simple arithmetic question')
    await flushRenameRefresh()

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(tab.agentRenamedTitle ?? null).toBeNull()
    expect(resolveTerminalTabTitle(tab, true)).toBe('What is 2 2')
  })

  it('drops the rename once the agent moves its title elsewhere', async () => {
    const store = createTestStore()
    const tabId = seedAgentTab(store)

    getRenamedTitle.mockResolvedValue('billing-fix')
    store.getState().updateTabTitle(tabId, '✳ billing-fix')
    await flushRenameRefresh()
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].agentRenamedTitle).toBe('billing-fix')

    store.getState().updateTabTitle(tabId, '✳ Fix the intake flow')
    await vi.waitFor(() =>
      expect(store.getState().tabsByWorktree[WORKTREE_ID][0].agentRenamedTitle).toBeNull()
    )
    expect(resolveTerminalTabTitle(store.getState().tabsByWorktree[WORKTREE_ID][0], true)).toBe(
      'What is 2 2'
    )
  })

  it('rescans for the newest title of a burst instead of dropping it', async () => {
    const store = createTestStore()
    const tabId = seedAgentTab(store)
    let releaseFirstScan = (): void => {}
    const firstScan = new Promise<string | null>((resolve) => {
      releaseFirstScan = () => resolve(null)
    })
    getRenamedTitle.mockReturnValueOnce(firstScan).mockResolvedValue('billing-fix')

    // Why: the rename can land while the previous frame's scan is still open.
    // Dropping it would leave the tab on the generated title with no later title
    // change to trigger a retry — Claude stops auto-titling once renamed.
    store.getState().updateTabTitle(tabId, '✳ Answer simple arithmetic question')
    store.getState().updateTabTitle(tabId, '✳ billing-fix')
    releaseFirstScan()

    await vi.waitFor(() =>
      expect(store.getState().tabsByWorktree[WORKTREE_ID][0].agentRenamedTitle).toBe('billing-fix')
    )
    expect(resolveTerminalTabTitle(store.getState().tabsByWorktree[WORKTREE_ID][0], true)).toBe(
      '✳ billing-fix'
    )
  })

  it('does not scan transcripts while generated titles are off', async () => {
    const store = createTestStore()
    const tabId = seedAgentTab(store)
    store.setState({ settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: false } })

    store.getState().updateTabTitle(tabId, '✳ billing-fix')
    await Promise.resolve()

    expect(getRenamedTitle).not.toHaveBeenCalled()
  })
})
