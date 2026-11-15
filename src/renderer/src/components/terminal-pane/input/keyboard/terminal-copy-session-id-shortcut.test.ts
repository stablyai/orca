// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'

const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: toastInfo, success: vi.fn(), error: vi.fn() } }))

type DispatchContext = Parameters<typeof dispatchTerminalShortcutAction>[3]

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const KEYBINDINGS = { 'terminal.copySessionId': ['Mod+Shift+C'] }

function seedClaudePane(shellForeground: boolean): void {
  useAppStore.setState({
    agentStatusByPaneKey: acceptedAgentStatuses([
      [
        PANE_KEY,
        {
          paneKey: PANE_KEY,
          state: 'done',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'claude-session-1' }
        }
      ]
    ]),
    paneForegroundAgentByPaneKey: { [PANE_KEY]: { agent: 'claude', shellForeground } }
  })
}

async function pressChord(repeat = false) {
  const writeTerminalClipboardText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('api', { ui: { writeTerminalClipboardText } })
  const event = new KeyboardEvent('keydown', {
    key: 'c',
    code: 'KeyC',
    metaKey: true,
    shiftKey: true,
    cancelable: true,
    repeat
  })
  // The copy always refocuses the pane last, which marks the end of its async work.
  const { promise: copyFinished, resolve: focus } = Promise.withResolvers<void>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Copying a session id only reads the pane's leaf id and refocuses its terminal.
  const pane = { id: 1, leafId: LEAF_ID, terminal: { focus } } as unknown as ManagedPane
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The action only asks the manager for its panes.
  const manager = { getActivePane: () => pane, getPanes: () => [pane] } as PaneManager
  const context: DispatchContext = {
    tabId: TAB_ID,
    worktreeId: 'worktree-1',
    fallbackCwd: '',
    expandedPaneIdRef: { current: null },
    setExpandedPane: vi.fn(),
    restoreExpandedLayout: vi.fn(),
    refreshPaneSizes: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    toggleExpandPane: vi.fn(),
    setSearchOpen: vi.fn(),
    focusSearchInput: vi.fn(),
    searchOpenRef: { current: false },
    onRequestClosePane: vi.fn(),
    onClearPaneScrollback: vi.fn(),
    onSetTitle: vi.fn(),
    onClearPaneTitle: vi.fn(),
    paneTransportsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    managerRef: { current: manager },
    getKeyboardSplitTelemetrySource: () => 'keyboard',
    armNativeOnlyShortcut: vi.fn()
  }
  const action = resolveTerminalShortcutAction(event, true, 'false', 0, false, KEYBINDINGS)
  if (action) {
    dispatchTerminalShortcutAction(action, event, manager, context)
    if (!repeat) {
      await copyFinished
    }
  }
  return {
    action: action?.type,
    prevented: event.defaultPrevented,
    copied: writeTerminalClipboardText.mock.calls.map(([text]) => text)
  }
}

describe('terminal Copy Session ID shortcut', () => {
  beforeEach(() => {
    useAppStore.setState({
      agentStatusByPaneKey: acceptedAgentStatuses(),
      paneForegroundAgentByPaneKey: {}
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    toastInfo.mockClear()
  })

  it('copies the focused agent pane session id once, swallowing held repeats', async () => {
    seedClaudePane(false)
    expect(await pressChord()).toEqual({
      action: 'copySessionId',
      prevented: true,
      copied: ['claude-session-1']
    })
    expect(await pressChord(true)).toEqual({
      action: 'copySessionId',
      prevented: true,
      copied: []
    })
  })

  it('reports a missing session instead of copying one from an exited agent', async () => {
    seedClaudePane(true)
    expect((await pressChord()).copied).toEqual([])
    expect(toastInfo).toHaveBeenCalledWith('No session ID to copy')
  })
})
