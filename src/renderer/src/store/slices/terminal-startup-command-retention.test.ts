import { describe, expect, it } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/path/wt1'

function seedWorktreeWithTab(store: ReturnType<typeof createTestStore>): string {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  return store.getState().createTab(WORKTREE_ID).id
}

// Why this suite exists: TerminalPane snapshots pendingStartupByTabId in a useState initializer,
// so whatever is missing there at mount is missing for good. The command must therefore survive
// every store event that can precede its owning pane's fresh spawn, or a quick command leaves the
// user a titled tab sitting at a bare prompt (STA-4876).
describe('queued startup command retention', () => {
  it('survives a recovery remount so the next mount can still deliver it', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    store.getState().remountTerminalTabForRecovery(tabId)

    expect(store.getState().pendingStartupByTabId[tabId]).toEqual({ command: 'echo hi' })
  })

  // Why: binding is pane-scoped but this map is tab-scoped. A tab routinely runs several panes
  // (setup/issue splits land on the same tabId), and the sibling often binds first — if a bind
  // spent the command, the pane that actually owns it would find an empty slot on remount.
  it('is not spent by a sibling pane binding a pty to the same tab', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    store.getState().updateTabPtyId(tabId, 'pty-sibling')

    expect(store.getState().pendingStartupByTabId[tabId]).toEqual({ command: 'echo hi' })
  })

  // Only the owning pane spends it, via this action, once its own fresh spawn exists.
  it('is spent through consumeTabStartupCommand and does not replay afterwards', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    expect(store.getState().consumeTabStartupCommand(tabId)).toEqual({ command: 'echo hi' })

    store.getState().remountTerminalTabForRecovery(tabId)
    expect(store.getState().pendingStartupByTabId[tabId]).toBeUndefined()
    expect(store.getState().consumeTabStartupCommand(tabId)).toBeNull()
  })

  // Why: retention is bounded by tab lifetime, so a spawn that never binds cannot leak forever.
  it('is dropped when the tab closes without ever spawning', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    store.getState().closeTab(tabId)

    expect(store.getState().pendingStartupByTabId[tabId]).toBeUndefined()
  })

  it('leaves a sibling tab’s queued command alone', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    const siblingId = store.getState().createTab(WORKTREE_ID).id
    store.getState().queueTabStartupCommand(tabId, { command: 'echo mine' })
    store.getState().queueTabStartupCommand(siblingId, { command: 'echo theirs' })

    store.getState().consumeTabStartupCommand(tabId)

    expect(store.getState().pendingStartupByTabId[siblingId]).toEqual({ command: 'echo theirs' })
  })

  it('stamps a bare cursor-agent startup with a launch token so the pane env can carry it', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'cursor-agent' })

    const queued = store.getState().pendingStartupByTabId[tabId]
    expect(queued?.launchAgent).toBe('cursor')
    expect(queued?.launchConfig).toEqual({
      agentCommand: 'cursor-agent',
      agentArgs: '',
      agentEnv: {}
    })
    expect(queued?.launchToken).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i))
    expect(queued?.env?.ORCA_AGENT_LAUNCH_TOKEN).toBe(queued?.launchToken)
  })

  it('does not mint a token for an unrecognized command even when launchConfig is present', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, {
      command: 'echo hi',
      launchConfig: { agentArgs: '', agentEnv: {} }
    })

    const queued = store.getState().pendingStartupByTabId[tabId]
    expect(queued?.launchToken).toBeUndefined()
    expect(queued?.env?.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined()
    expect(queued?.command).toBe('echo hi')
  })

  it('overwrites a captured ORCA_AGENT_LAUNCH_TOKEN when resume-shaped startup is queued', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, {
      command: 'codex resume sess-1',
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: 'codex',
        agentArgs: '',
        agentEnv: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'stale-persisted-token' }
      },
      env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'stale-persisted-token' }
    })

    const queued = store.getState().pendingStartupByTabId[tabId]
    expect(queued?.env?.CODEX_PROFILE).toBe('captured')
    expect(queued?.launchToken).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i))
    expect(queued?.launchToken).not.toBe('stale-persisted-token')
    expect(queued?.env?.ORCA_AGENT_LAUNCH_TOKEN).toBe(queued?.launchToken)
  })

  it('mints a distinct launch token per tab so a sibling cannot inherit authority', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    const siblingId = store.getState().createTab(WORKTREE_ID).id
    store.getState().queueTabStartupCommand(tabId, { command: 'cursor-agent' })
    store.getState().queueTabStartupCommand(siblingId, { command: 'cursor-agent' })

    const queued = store.getState().pendingStartupByTabId[tabId]
    const sibling = store.getState().pendingStartupByTabId[siblingId]
    expect(queued?.launchToken).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i))
    expect(sibling?.launchToken).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i))
    expect(queued?.launchToken).not.toBe(sibling?.launchToken)
    expect(queued?.env?.ORCA_AGENT_LAUNCH_TOKEN).not.toBe(sibling?.env?.ORCA_AGENT_LAUNCH_TOKEN)
  })
})
