import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { setupTerminalCreateSurfacing } from './ipc-events-terminal-create-test-harness'

describe('useIpcEvents updater integration', () => {
  it('surfaces terminal creates without stealing focus unless requested', async () => {
    let floatingPanelFocused = false
    const scenario = await setupTerminalCreateSurfacing(() => floatingPanelFocused)
    const { createTab, setActiveView, setActiveWorktree, markWorktreeVisited } = scenario
    const { recordWorktreeVisit, setActiveTabType, setActiveTab } = scenario
    const { revealWorktreeInSidebar, setTabCustomTitle, queueTabStartupCommand } = scenario
    const { registerAgentLaunchConfig, updateTabPtyId, setTabLayout } = scenario
    const { replyTerminalCreate, dispatchEvent } = scenario
    const { createFloatingWorkspaceTerminalTab } = scenario
    const { createWebRuntimeSessionTerminal, focusRuntimeTerminalSurface } = scenario
    const { focusTerminalTabSurface, storeState, createTerminalListenerRef } = scenario
    const { requestTerminalCreateListenerRef, focusTerminalListenerRef } = scenario
    const { newTerminalTabListenerRef } = scenario

    // The harness registers both listeners before returning; narrow them once.
    if (!newTerminalTabListenerRef.current || !createTerminalListenerRef.current) {
      throw new Error('Expected create-terminal and new-terminal-tab listeners to be registered')
    }

    floatingPanelFocused = true
    newTerminalTabListenerRef.current()
    expect(createFloatingWorkspaceTerminalTab).toHaveBeenCalledWith(storeState)
    expect(createTab).not.toHaveBeenCalled()

    floatingPanelFocused = false
    createFloatingWorkspaceTerminalTab.mockClear()
    createTab.mockClear()
    newTerminalTabListenerRef.current()
    await Promise.resolve()
    await Promise.resolve()
    expect(createFloatingWorkspaceTerminalTab).not.toHaveBeenCalled()
    expect(createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      // Why: multi-host scopes the new terminal to the worktree's own runtime
      // env (null here -> falls back to the active env inside the helper).
      environmentId: null,
      activate: true
    })
    expect(createTab).toHaveBeenCalledWith('wt-1')
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')

    // Exact regression sequence: Local default -> connect/navigate Windows 2 ->
    // reveal a local terminal -> restart. Connection and navigation are transient.
    storeState.repos.push({
      id: 'windows-2-repo',
      connectionId: null,
      executionHostId: 'runtime:windows-2'
    })
    storeState.worktreesByRepo['windows-2-repo'] = [
      { id: 'windows-2-worktree', repoId: 'windows-2-repo' }
    ]
    storeState.activeWorktreeId = 'windows-2-worktree'
    createTab.mockClear()
    replyTerminalCreate.mockClear()
    createTerminalListenerRef.current({
      requestId: 'local-reveal-after-remote-navigation',
      worktreeId: 'wt-2',
      title: 'Local shell',
      presentation: 'focused'
    })
    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, undefined)
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'local-reveal-after-remote-navigation',
      tabId: 'tab-new',
      title: 'Local shell'
    })
    expect(storeState.settings.activeRuntimeEnvironmentId).toBeUndefined()
    delete storeState.worktreesByRepo['windows-2-repo']
    storeState.repos = storeState.repos.filter((repo) => repo.id !== 'windows-2-repo')
    storeState.activeWorktreeId = 'wt-1'
    expect(storeState.settings.activeRuntimeEnvironmentId).toBeUndefined()

    createWebRuntimeSessionTerminal.mockClear()
    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()

    storeState.settings = {
      ...storeState.settings,
      activeRuntimeEnvironmentId: 'windows-2'
    }

    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      title: 'Runner',
      command: 'opencode'
    })

    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(markWorktreeVisited).not.toHaveBeenCalled()
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Runner', {
      recordInteraction: false
    })
    expect(queueTabStartupCommand).toHaveBeenCalledWith('tab-new', { command: 'opencode' })
    expect(storeState.settings.activeRuntimeEnvironmentId).toBe('windows-2')

    storeState.settings = {
      ...storeState.settings,
      activeRuntimeEnvironmentId: undefined
    }

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    dispatchEvent.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      title: 'Runner',
      command: 'opencode',
      presentation: 'focused'
    })

    expect(setActiveView).toHaveBeenCalledWith('terminal')
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-2')
    expect(markWorktreeVisited).toHaveBeenCalledWith('wt-2')
    expect(recordWorktreeVisit).toHaveBeenCalledWith('wt-2')
    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, undefined)
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(setActiveTab).toHaveBeenCalledWith('tab-new')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', undefined)

    if (typeof requestTerminalCreateListenerRef.current !== 'function') {
      throw new Error('Expected request-terminal-create listener to be registered')
    }

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    setTabCustomTitle.mockClear()
    queueTabStartupCommand.mockClear()
    replyTerminalCreate.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-focused',
      worktreeId: 'wt-3',
      title: 'Shell'
    })

    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(markWorktreeVisited).not.toHaveBeenCalled()
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(createTab).toHaveBeenCalledWith('wt-3', undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-3')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-3', tabIds: ['tab-new'] }
      })
    )
    expect(setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Shell', {
      recordInteraction: false
    })
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-focused',
      tabId: 'tab-new',
      title: 'Shell'
    })

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    setTabCustomTitle.mockClear()
    queueTabStartupCommand.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    storeState.settings = {
      ...storeState.settings,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
    requestTerminalCreateListenerRef.current({
      requestId: 'req-renderer-backed',
      worktreeId: 'wt-2',
      targetGroupId: 'group-left',
      title: 'Codex',
      command: 'codex',
      cwd: '/repo/packages/app',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'request' }
      },
      launchAgent: 'codex',
      activate: false
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', 'group-left', undefined, {
      activate: false,
      recordInteraction: false,
      launchAgent: 'codex',
      viewMode: 'chat',
      startupCwd: '/repo/packages/app'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(markWorktreeVisited).not.toHaveBeenCalled()
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-2', tabIds: ['tab-new'] }
      })
    )
    expect(setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Codex', {
      recordInteraction: false
    })
    expect(queueTabStartupCommand).toHaveBeenCalledWith('tab-new', {
      command: 'codex',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'request' }
      },
      launchAgent: 'codex'
    })
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-renderer-backed',
      tabId: 'tab-new',
      title: 'Codex'
    })

    createTab.mockClear()
    replyTerminalCreate.mockClear()
    storeState.settings.activeRuntimeEnvironmentId = 'focused-runtime'
    requestTerminalCreateListenerRef.current({
      requestId: 'req-runtime-session',
      worktreeId: 'wt-2',
      targetGroupId: 'group-left',
      title: 'Runtime Terminal',
      command: 'codex',
      launchAgent: 'codex',
      viewMode: 'terminal',
      activate: true,
      source: 'runtime-session'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', 'group-left', undefined, {
      launchAgent: 'codex',
      viewMode: 'terminal'
    })
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-runtime-session',
      tabId: 'tab-new',
      title: 'Runtime Terminal'
    })

    createTab.mockClear()
    replyTerminalCreate.mockClear()
    storeState.settings.activeRuntimeEnvironmentId = 'focused-runtime'
    requestTerminalCreateListenerRef.current({
      requestId: 'req-runtime-blocked',
      worktreeId: 'wt-2',
      title: 'Blocked Local Terminal'
    })

    expect(createTab).toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-runtime-blocked',
      tabId: 'tab-new',
      title: 'Blocked Local Terminal'
    })

    createTab.mockClear()
    replyTerminalCreate.mockClear()
    storeState.repos = [
      ...storeState.repos,
      {
        id: 'repo-remote',
        connectionId: null,
        executionHostId: 'runtime:focused-runtime'
      }
    ]
    storeState.worktreesByRepo = {
      ...storeState.worktreesByRepo,
      'repo-remote': [{ id: 'wt-remote', repoId: 'repo-remote' }]
    }
    requestTerminalCreateListenerRef.current({
      requestId: 'req-remote-owner-blocked',
      worktreeId: 'wt-remote',
      title: 'Remote-owned Terminal'
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-remote-owner-blocked',
      error: 'Local terminal creation is unavailable while a remote runtime is active'
    })
    delete storeState.worktreesByRepo['repo-remote']
    storeState.repos = storeState.repos.filter((repo) => repo.id !== 'repo-remote')

    createTab.mockClear()
    replyTerminalCreate.mockClear()
    storeState.repos = [
      ...storeState.repos,
      {
        id: 'repo-conflicting-owner',
        connectionId: null,
        executionHostId: 'runtime:focused-runtime'
      }
    ]
    storeState.worktreesByRepo = {
      ...storeState.worktreesByRepo,
      'repo-1': [...storeState.worktreesByRepo['repo-1'], { id: 'wt-ambiguous', repoId: 'repo-1' }],
      'repo-conflicting-owner': [{ id: 'wt-ambiguous', repoId: 'repo-conflicting-owner' }]
    }
    requestTerminalCreateListenerRef.current({
      requestId: 'req-ambiguous-owner',
      worktreeId: 'wt-ambiguous',
      title: 'Ambiguous Terminal',
      source: 'runtime-session'
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-ambiguous-owner',
      error: 'Terminal creation is unavailable because the worktree owner could not be resolved'
    })
    storeState.worktreesByRepo['repo-1'] = storeState.worktreesByRepo['repo-1'].filter(
      (worktree) => worktree.id !== 'wt-ambiguous'
    )
    delete storeState.worktreesByRepo['repo-conflicting-owner']
    storeState.repos = storeState.repos.filter((repo) => repo.id !== 'repo-conflicting-owner')

    createTab.mockClear()
    replyTerminalCreate.mockClear()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-missing-owner',
      worktreeId: 'wt-missing',
      title: 'Missing Terminal'
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-missing-owner',
      error: 'Terminal creation is unavailable because the worktree owner could not be resolved'
    })
    storeState.settings.activeRuntimeEnvironmentId = undefined

    if (typeof focusTerminalListenerRef.current !== 'function') {
      throw new Error('Expected focus-terminal listener to be registered')
    }

    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    focusTerminalListenerRef.current({
      worktreeId: 'wt-4',
      tabId: 'tab-focus',
      leafId: 'leaf-focus'
    })

    expect(setActiveView).toHaveBeenCalledWith('terminal')
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-4')
    expect(markWorktreeVisited).toHaveBeenCalledWith('wt-4')
    expect(recordWorktreeVisit).toHaveBeenCalledWith('wt-4')
    expect(setActiveTab).toHaveBeenCalledWith('tab-focus')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-4')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-focus', 'leaf-focus')
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-focus', 'leaf-focus')

    storeState.isNavigatingHistory = true
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    focusTerminalListenerRef.current({
      worktreeId: 'wt-history',
      tabId: 'tab-history'
    })

    expect(setActiveView).toHaveBeenCalledWith('terminal')
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-history')
    expect(markWorktreeVisited).toHaveBeenCalledWith('wt-history')
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(setActiveTab).toHaveBeenCalledWith('tab-history')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-history')
    storeState.isNavigatingHistory = false

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-renderer-backed-background',
      worktreeId: 'wt-2',
      title: 'Codex',
      command: 'codex',
      presentation: 'background'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-2', tabIds: ['tab-new'] }
      })
    )
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-renderer-backed-background',
      tabId: 'tab-new',
      title: 'Codex'
    })

    createTab.mockClear()
    registerAgentLaunchConfig.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-bg',
      leafId: '55555555-5555-4555-8555-555555555555',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'adopted' }
      },
      launchAgent: 'codex'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-bg',
      activate: false,
      launchAgent: 'codex',
      viewMode: 'chat'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(registerAgentLaunchConfig).toHaveBeenCalledWith(
      makePaneKey('tab-new', '55555555-5555-4555-8555-555555555555'),
      {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'adopted' }
      },
      {
        agentType: 'codex',
        tabId: 'tab-new',
        leafId: '55555555-5555-4555-8555-555555555555'
      }
    )

    createTab.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-explicit-terminal',
      launchAgent: 'codex',
      viewMode: 'terminal'
    })
    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-explicit-terminal',
      activate: false,
      launchAgent: 'codex',
      viewMode: 'terminal'
    })

    createTab.mockClear()
    storeState.settings.openAgentTabsInChatByDefault = false
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-explicit-chat',
      launchAgent: 'codex',
      viewMode: 'chat'
    })
    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-explicit-chat',
      activate: false,
      launchAgent: 'codex',
      viewMode: 'chat'
    })
    storeState.settings.openAgentTabsInChatByDefault = true

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-bg-2',
      activate: false,
      tabId: 'tab-cli-bg'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-bg-2',
      activate: false,
      id: 'tab-cli-bg'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    dispatchEvent.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-bg-3',
      presentation: 'background',
      tabId: 'tab-cli-bg-reveal'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-bg-3',
      activate: false,
      id: 'tab-cli-bg-reveal'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-2', tabIds: ['tab-cli-bg-reveal'] }
      })
    )

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    dispatchEvent.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-recovery-bg',
      activate: true,
      focus: false,
      tabId: 'tab-recovery-bg'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-recovery-bg',
      activate: false,
      id: 'tab-recovery-bg'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(focusRuntimeTerminalSurface).not.toHaveBeenCalled()
    expect(focusTerminalTabSurface).not.toHaveBeenCalled()
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-2', tabIds: ['tab-recovery-bg'] }
      })
    )

    storeState.tabsByWorktree = {
      'wt-2': [{ id: 'tab-existing', ptyId: 'pty-bg', title: 'Terminal 1' }]
    }
    storeState.ptyIdsByTabId = { 'tab-existing': ['pty-bg'] }
    createTab.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    setTabCustomTitle.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-bg',
      title: 'Runtime title'
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(setTabCustomTitle).not.toHaveBeenCalled()

    createTerminalListenerRef.current({
      requestId: 'req-reveal',
      worktreeId: 'wt-2',
      ptyId: 'pty-bg'
    })

    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-reveal',
      tabId: 'tab-existing',
      title: 'Terminal 1'
    })

    const pendingTabId = 'ba416891-cbcb-4778-8d9c-d8907f31a68c'
    const pendingLeafId = 'e4583c63-2d9a-4877-b66f-05c0150f05f9'
    storeState.tabsByWorktree = {
      'wt-2': [{ id: pendingTabId, ptyId: null, title: 'Terminal 3' }]
    }
    storeState.ptyIdsByTabId = { [pendingTabId]: [] }
    storeState.terminalLayoutsByTabId = {
      [pendingTabId]: {
        root: { type: 'leaf', leafId: pendingLeafId },
        activeLeafId: pendingLeafId,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    }
    createTab.mockClear()
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    replyTerminalCreate.mockClear()
    createTerminalListenerRef.current({
      requestId: 'req-adopt-pending',
      worktreeId: 'wt-2',
      ptyId: 'serve-cf39bedb-a33a-417c-9ab6-f304dc27a6c0',
      tabId: pendingTabId,
      leafId: pendingLeafId
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(updateTabPtyId).toHaveBeenCalledWith(
      pendingTabId,
      'serve-cf39bedb-a33a-417c-9ab6-f304dc27a6c0'
    )
    expect(setTabLayout).toHaveBeenCalledWith(pendingTabId, {
      root: { type: 'leaf', leafId: pendingLeafId },
      activeLeafId: pendingLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [pendingLeafId]: 'serve-cf39bedb-a33a-417c-9ab6-f304dc27a6c0'
      }
    })
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith(pendingTabId, pendingLeafId)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith(pendingTabId, pendingLeafId)
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-adopt-pending',
      tabId: pendingTabId,
      title: 'Terminal 3',
      identity: {
        worktreeId: 'wt-2',
        tabId: pendingTabId,
        leafId: pendingLeafId,
        ptyId: 'serve-cf39bedb-a33a-417c-9ab6-f304dc27a6c0'
      }
    })

    storeState.tabsByWorktree = {
      'wt-2': [{ id: 'tab-existing', ptyId: 'pty-bg', title: 'Terminal 1' }]
    }
    storeState.ptyIdsByTabId = { 'tab-existing': ['pty-bg'] }
    storeState.terminalLayoutsByTabId = {
      'tab-existing': {
        root: { type: 'leaf', leafId: 'leaf-source' },
        activeLeafId: 'leaf-source',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-source': 'pty-bg' }
      }
    }
    createTab.mockClear()
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    replyTerminalCreate.mockClear()
    createTerminalListenerRef.current({
      requestId: 'req-split',
      worktreeId: 'wt-2',
      ptyId: 'pty-split',
      tabId: 'tab-existing',
      leafId: 'leaf-split',
      splitFromLeafId: 'leaf-source',
      splitDirection: 'vertical',
      splitTelemetrySource: 'contextual_tour',
      presentation: 'focused'
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(updateTabPtyId).toHaveBeenCalledWith('tab-existing', 'pty-split')
    expect(setTabLayout).toHaveBeenCalledWith('tab-existing', {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-source' },
        second: { type: 'leaf', leafId: 'leaf-split' },
        ratio: 0.5
      },
      activeLeafId: 'leaf-split',
      expandedLeafId: null,
      ptyIdsByLeafId: {
        'leaf-source': 'pty-bg',
        'leaf-split': 'pty-split'
      }
    })
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-split-terminal-pane',
        detail: {
          tabId: 'tab-existing',
          paneRuntimeId: -1,
          direction: 'vertical',
          sourceLeafId: 'leaf-source',
          sourcePtyId: 'pty-bg',
          telemetrySource: 'contextual_tour',
          newLeafId: 'leaf-split',
          ptyId: 'pty-split'
        }
      })
    )
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-split',
      tabId: 'tab-existing',
      title: 'Terminal 1',
      identity: {
        worktreeId: 'wt-2',
        tabId: 'tab-existing',
        leafId: 'leaf-split',
        ptyId: 'pty-split'
      }
    })

    storeState.terminalLayoutsByTabId = {
      'tab-existing': {
        root: { type: 'leaf', leafId: 'leaf-source' },
        activeLeafId: 'leaf-source',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-source': 'pty-bg' }
      }
    }
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-split-background',
      tabId: 'tab-existing',
      leafId: 'leaf-split-background',
      splitFromLeafId: 'leaf-source',
      splitDirection: 'vertical',
      activate: false
    })

    expect(updateTabPtyId).toHaveBeenCalledWith('tab-existing', 'pty-split-background')
    expect(setTabLayout).toHaveBeenCalledWith('tab-existing', {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-source' },
        second: { type: 'leaf', leafId: 'leaf-split-background' },
        ratio: 0.5
      },
      activeLeafId: 'leaf-source',
      expandedLeafId: null,
      ptyIdsByLeafId: {
        'leaf-source': 'pty-bg',
        'leaf-split-background': 'pty-split-background'
      }
    })

    const splitLayout = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-source' },
        second: { type: 'leaf', leafId: 'leaf-split' },
        ratio: 0.5
      },
      activeLeafId: 'leaf-split',
      expandedLeafId: null,
      ptyIdsByLeafId: {
        'leaf-source': 'pty-bg',
        'leaf-split': 'pty-split'
      }
    }
    storeState.ptyIdsByTabId = { 'tab-existing': ['pty-bg', 'pty-split'] }
    storeState.terminalLayoutsByTabId = { 'tab-existing': splitLayout }
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-split',
      tabId: 'tab-existing',
      leafId: 'leaf-split'
    })

    expect(updateTabPtyId).toHaveBeenCalledWith('tab-existing', 'pty-split')
    expect(setTabLayout).toHaveBeenCalledWith('tab-existing', splitLayout)
  })
})
