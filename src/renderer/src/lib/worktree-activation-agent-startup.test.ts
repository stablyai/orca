import { describe, expect, it, vi } from 'vitest'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation-test-harness'

registerWorktreeActivationReset()

describe('ensureWorktreeHasInitialTerminal', () => {
  it('queues a startup command when agent launch is provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      { command: 'claude "Fix this bug"' },
      undefined,
      undefined
    )

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'claude "Fix this bug"'
    })
    expect(store.queueTabSetupSplit).not.toHaveBeenCalled()
    expect(store.queueTabIssueCommandSplit).not.toHaveBeenCalled()
  })

  it('opens new agent workspace terminals in native chat when configured', () => {
    const store = createMockStore({
      settings: {
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true
      }
    })

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      {
        command: 'claude',
        launchAgent: 'claude'
      },
      undefined,
      undefined
    )

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true,
      launchAgent: 'claude',
      viewMode: 'chat'
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'claude',
      launchAgent: 'claude'
    })
  })

  it.each([
    ['mirrorable', 'https://github.com/o/r/issues/12', { viewMode: 'chat' }],
    ['multi-line', 'Review this\n\nhttps://github.com/o/r/issues/12', { viewMode: 'chat' }],
    ['unsupported-separator', 'Review this\u2028https://github.com/o/r/issues/12', {}]
  ])('opens a %s draft startup payload accordingly', (_label, draftPrompt, expectedViewMode) => {
    const store = createMockStore({
      settings: {
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true
      }
    })

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      {
        command: 'claude',
        launchAgent: 'claude',
        draftPrompt
      },
      undefined,
      undefined
    )

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true,
      launchAgent: 'claude',
      ...expectedViewMode
    })
  })

  // An argv-prefill launch carries the draft inside `command` and sets NO
  // draftPrompt, so gating on draftPrompt alone lets it open in chat with
  // nothing mirrored — an empty composer beside a filled TUI input.
  it.each([
    ['mirrorable', 'https://github.com/o/r/issues/12', { viewMode: 'chat' }],
    ['multi-line', 'Review this\n\nhttps://github.com/o/r/issues/12', { viewMode: 'chat' }],
    ['unsupported-separator', 'Review this\u2028https://github.com/o/r/issues/12', {}]
  ])(
    'gates a %s argv-prefill draft on launchDraftText alone',
    (_label, launchDraftText, expectedViewMode) => {
      const store = createMockStore({
        settings: {
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true
        }
      })

      ensureWorktreeHasInitialTerminal(
        store,
        'wt-1',
        {
          command: `claude --prefill '${launchDraftText}'`,
          launchAgent: 'claude',
          launchDraftText
        },
        undefined,
        undefined
      )

      expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
        pendingActivationSpawn: true,
        launchAgent: 'claude',
        ...expectedViewMode
      })
    }
  )

  it('opens the startup default tab in native chat when configured', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({
      createTab,
      settings: {
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true
      }
    })

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      { command: 'claude', launchAgent: 'claude' },
      undefined,
      undefined,
      { runCommands: true, tabs: [{ title: 'Claude', command: 'claude' }] }
    )

    expect(createTab).toHaveBeenNthCalledWith(1, 'wt-1', undefined, undefined, {
      pendingActivationSpawn: true,
      recordInteraction: false,
      launchAgent: 'claude',
      viewMode: 'chat'
    })
  })

  it.each([
    ['mirrorable', 'https://github.com/o/r/issues/12', { viewMode: 'chat' }],
    ['multi-line', 'Review this\n\nhttps://github.com/o/r/issues/12', { viewMode: 'chat' }],
    ['unsupported-separator', 'Review this\u2028https://github.com/o/r/issues/12', {}]
  ])(
    'opens a %s draft startup default tab accordingly',
    (_label, draftPrompt, expectedViewMode) => {
      let createdIndex = 0
      const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
      const store = createMockStore({
        createTab,
        settings: {
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true
        }
      })

      ensureWorktreeHasInitialTerminal(
        store,
        'wt-1',
        { command: 'claude', launchAgent: 'claude', draftPrompt },
        undefined,
        undefined,
        { runCommands: true, tabs: [{ title: 'Claude', command: 'claude' }] }
      )

      expect(createTab).toHaveBeenNthCalledWith(1, 'wt-1', undefined, undefined, {
        pendingActivationSpawn: true,
        recordInteraction: false,
        launchAgent: 'claude',
        ...expectedViewMode
      })
    }
  )

  it('forwards telemetry on the queued startup so main can fire agent_started', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      {
        command: 'claude',
        telemetry: {
          agent_kind: 'claude-code',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      },
      undefined,
      undefined
    )

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true,
      launchAgent: 'claude'
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'claude',
      telemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      }
    })
  })

  it('stamps the tab agent from startup launchAgent without telemetry', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      {
        command: 'codex',
        launchAgent: 'codex'
      },
      undefined,
      undefined
    )

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true,
      launchAgent: 'codex'
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'codex',
      launchAgent: 'codex'
    })
  })
})
