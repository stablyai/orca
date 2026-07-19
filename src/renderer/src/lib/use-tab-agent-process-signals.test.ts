// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { TerminalTab } from '../../../shared/types'
import {
  resolveLaunchedAgentExitEvidence,
  resolveTabAgentFromSignals,
  useTabAgent,
  type TabAgentIdentity
} from './use-tab-agent'

const initialAppState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
let latestHookAgent: TabAgentIdentity | undefined
const hookRoots: Root[] = []

function HookProbe({ tab }: { tab: TerminalTab }): null {
  latestHookAgent = useTabAgent(tab)
  return null
}

async function renderHookProbe(tab: TerminalTab): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  hookRoots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { tab }))
  })
  return root
}

async function setPaneForeground(entry: PaneForegroundAgentEntry): Promise<void> {
  await act(async () => {
    useAppStore.getState().setPaneForegroundAgent(PANE_KEY, entry)
  })
}

describe('resolveTabAgentFromSignals process identity', () => {
  it('ranks the recognized foreground process above title and launch bootstrap', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✦ Gemini CLI',
        hookAgent: null,
        processAgent: 'aider',
        launchAgent: 'codex'
      })
    ).toBe('aider')
  })

  it('keeps live hook identity above process identity', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: 'claude',
        processAgent: 'aider',
        launchAgent: undefined
      })
    ).toBe('claude')
  })

  it('suppresses launch identity on shell-foreground evidence despite a stale agent title', () => {
    // Why: OSC 133;D is process-grade exit proof — a TUI that died without
    // restoring its title must not keep painting the tab.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        processAgent: null,
        processShellForeground: true,
        launchAgent: 'claude'
      })
    ).toBeNull()
  })

  it('suppresses stuck-title identity once shell foreground is proven on a manual pane', () => {
    // Why: pre-probe-removal, the foreground read cleared icons for TUIs that
    // died with a stuck title; shell-foreground evidence restores that.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        processAgent: null,
        processShellForeground: true,
        launchAgent: undefined
      })
    ).toBeNull()
  })

  it('keeps remote title identity even when a shell-foreground flag is passed', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '✳ Claude Code',
        hookAgent: null,
        processAgent: null,
        processShellForeground: true,
        launchAgent: undefined
      })
    ).toBe('claude')
  })

  it('keeps launch identity while the recognized process is still in the foreground', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        processAgent: 'codex',
        launchAgent: 'codex'
      })
    ).toBe('codex')
  })
})

describe('resolveTabAgentFromSignals unknown-live identity', () => {
  it('returns a neutral unknown-live identity for a live fork process with a working title', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠸ my-fork building',
        hookAgent: null,
        processAgent: null,
        unknownLiveProcessName: 'my-fork'
      })
    ).toEqual({ kind: 'unknown-live', label: 'my-fork' })
  })

  it('stays null for the same fork process without title activity (the vim/htop case)', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'my-fork ~/README.md',
        hookAgent: null,
        processAgent: null,
        unknownLiveProcessName: 'my-fork'
      })
    ).toBeNull()
  })

  it('lets any recognized engine layer outrank the unknown-live fallback', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠸ my-fork building',
        hookAgent: 'claude',
        processAgent: null,
        unknownLiveProcessName: 'my-fork'
      })
    ).toBe('claude')
  })
})

describe('resolveLaunchedAgentExitEvidence shell-foreground gate', () => {
  const baseArgs = {
    title: '✳ Claude Code',
    hasObservedAgentSignal: true,
    hookAgent: null,
    hasCompletedHook: false,
    processShellForeground: true
  }

  it('counts shell-foreground proof as local launched-agent exit evidence', () => {
    expect(resolveLaunchedAgentExitEvidence({ ...baseArgs, isRemote: false })).toBe(true)
  })

  it('never counts a shell-foreground flag as remote launched-agent exit evidence', () => {
    expect(resolveLaunchedAgentExitEvidence({ ...baseArgs, isRemote: true })).toBe(false)
  })
})

describe('useTabAgent process signals', () => {
  const clearTabLaunchAgent = vi.fn()
  const baseTab: TerminalTab = {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }

  beforeEach(() => {
    latestHookAgent = undefined
    clearTabLaunchAgent.mockReset()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      },
      agentStatusByPaneKey: {},
      clearTabLaunchAgent
    })
  })

  afterEach(() => {
    hookRoots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('shows the recognized foreground agent for a manual launch with no hooks or titles', async () => {
    await renderHookProbe(baseTab)
    expect(latestHookAgent).toBeNull()

    await setPaneForeground({ agent: 'aider', shellForeground: false })

    expect(latestHookAgent).toBe('aider')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
  })

  it('clears hookless launch identity on shell-foreground evidence despite a stale title', async () => {
    const launchedTab = { ...baseTab, launchAgent: 'aider' as const, title: '⠸ aider working' }
    const root = await renderHookProbe(launchedTab)

    await setPaneForeground({ agent: 'aider', shellForeground: false })
    expect(latestHookAgent).toBe('aider')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()

    // Why: OSC 133;D marks the launched command exiting; the stale spinner
    // title must not keep the launch identity alive.
    await setPaneForeground({ agent: null, shellForeground: true })
    await act(async () => {
      root.render(createElement(HookProbe, { tab: launchedTab }))
    })

    expect(clearTabLaunchAgent).toHaveBeenCalledWith('tab-1')
  })

  it('does not clear launch identity from shell foreground before any agent activity', async () => {
    const launchedTab = { ...baseTab, launchAgent: 'aider' as const }
    await renderHookProbe(launchedTab)

    // Pre-start window: the shell prompt (or a quick setup command) finishing
    // is not evidence the launched agent ever ran.
    await setPaneForeground({ agent: null, shellForeground: true })

    expect(latestHookAgent).toBe('aider')
    expect(clearTabLaunchAgent).not.toHaveBeenCalled()
  })

  it('surfaces a neutral unknown-live identity for a live fork process with a working title', async () => {
    const forkTab = { ...baseTab, title: '⠸ my-fork building' }
    await renderHookProbe(forkTab)

    await setPaneForeground({
      agent: null,
      rawProcessName: 'my-fork',
      shellForeground: false,
      ptyId: 'pty-1'
    })

    expect(latestHookAgent).toEqual({ kind: 'unknown-live', label: 'my-fork' })
  })

  it('stays null for a full-screen TUI (vim) that reports a static, activity-free title', async () => {
    const editorTab = { ...baseTab, title: 'vim README.md' }
    await renderHookProbe(editorTab)

    await setPaneForeground({
      agent: null,
      rawProcessName: 'vim',
      shellForeground: false,
      ptyId: 'pty-1'
    })

    expect(latestHookAgent).toBeNull()
  })

  it('ignores a shell raw process name even with a working title', async () => {
    const forkTab = { ...baseTab, title: '⠸ working' }
    await renderHookProbe(forkTab)

    await setPaneForeground({
      agent: null,
      rawProcessName: 'zsh',
      shellForeground: false,
      ptyId: 'pty-1'
    })

    expect(latestHookAgent).toBeNull()
  })

  it('drops the unknown-live identity once its evidence is stale', async () => {
    const forkTab = { ...baseTab, title: '⠸ my-fork building' }
    await renderHookProbe(forkTab)

    // Why: observedAt is preserved by the slice, so an ancient timestamp
    // simulates evidence that fell outside the freshness TTL.
    await setPaneForeground({
      agent: null,
      rawProcessName: 'my-fork',
      shellForeground: false,
      ptyId: 'pty-1',
      observedAt: 1
    })

    expect(latestHookAgent).toBeNull()
  })
})
