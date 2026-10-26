// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import { createTerminalNativeOnlyShortcutTracker } from './terminal-native-only-shortcut'

const { toastInfoMock } = vi.hoisted(() => ({ toastInfoMock: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: toastInfoMock, success: vi.fn(), error: vi.fn() } }))

type DispatchContext = Parameters<typeof dispatchTerminalShortcutAction>[3]

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const SESSION_ID = '01a006a6-1d07-70a1-bad5-f9110d5845c0'
const KEYBINDINGS = { 'terminal.copySessionId': ['Mod+Shift+I'] }

function seedAgentPane(): void {
  const entry: AgentStatusEntry = {
    paneKey: PANE_KEY,
    state: 'done',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude',
    providerSession: { key: 'session_id', id: SESSION_ID }
  }
  useAppStore.setState({
    agentStatusByPaneKey: { [PANE_KEY]: entry },
    paneForegroundAgentByPaneKey: { [PANE_KEY]: { agent: 'claude', shellForeground: false } }
  })
}

async function pressChord({ repeat = false } = {}) {
  const writeTerminalClipboardText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('api', { ui: { writeTerminalClipboardText } })
  const tracker = createTerminalNativeOnlyShortcutTracker()
  const event = new KeyboardEvent('keydown', {
    key: 'i',
    code: 'KeyI',
    metaKey: true,
    shiftKey: true,
    cancelable: true,
    repeat
  })
  // Why: the copy always refocuses the pane last, which marks the end of its async work.
  const { promise: copyFinished, resolve: focus } = Promise.withResolvers<void>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Copying a session id only reads the pane's leaf id and refocuses its terminal.
  const pane = { id: 1, leafId: LEAF_ID, terminal: { focus } } as unknown as ManagedPane
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The action only asks the manager for its panes.
  const manager = { getActivePane: () => pane, getPanes: () => [pane] } as PaneManager
  const context: DispatchContext = {
    tabId: TAB_ID,
    worktreeId: 'workspace',
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
    armNativeOnlyShortcut: tracker.armKeyDown
  }
  const action = resolveTerminalShortcutAction(event, true, 'false', 0, false, KEYBINDINGS)
  if (action) {
    dispatchTerminalShortcutAction(action, event, manager, context)
    if (!repeat) {
      await copyFinished
    }
  }
  return {
    action,
    prevented: event.defaultPrevented,
    copied: writeTerminalClipboardText.mock.calls.map(([text]) => text)
  }
}

describe('terminal Copy Session ID shortcut', () => {
  beforeEach(() => {
    useAppStore.setState({ agentStatusByPaneKey: {}, paneForegroundAgentByPaneKey: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    toastInfoMock.mockClear()
  })

  it('copies the focused agent pane session id when its chord is pressed', async () => {
    seedAgentPane()
    expect(await pressChord()).toEqual({
      action: { type: 'copySessionId' },
      prevented: true,
      copied: [SESSION_ID]
    })
  })

  it('keeps a held chord out of the terminal without copying again', async () => {
    seedAgentPane()
    expect(await pressChord({ repeat: true })).toEqual({
      action: { type: 'copySessionId' },
      prevented: true,
      copied: []
    })
  })

  it('says so when the pane has no session to copy', async () => {
    expect((await pressChord()).copied).toEqual([])
    expect(toastInfoMock).toHaveBeenCalledWith('No session ID to copy')
  })
})
