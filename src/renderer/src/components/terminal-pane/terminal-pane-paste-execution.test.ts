// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as TerminalPasteCoordinatorModule from './terminal-paste-coordinator'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import { createTerminalPanePasteExecution } from './terminal-pane-paste-execution'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import { planTerminalPasteWithYield } from './terminal-paste-coordinator'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

const TAB_ID = 'tab-1'
const AGENT_LEAF = '11111111-1111-4111-8111-111111111111'
const SHELL_LEAF = '22222222-2222-4222-8222-222222222222'
const AGENT_PANE_KEY = `${TAB_ID}:${AGENT_LEAF}`

const agentStatusEntry: AgentStatusEntry = {
  state: 'waiting',
  prompt: '',
  updatedAt: 0,
  stateStartedAt: 0,
  stateHistory: [],
  agentType: 'codex',
  paneKey: AGENT_PANE_KEY
}

const agentStatusByPaneKey: Record<string, AgentStatusEntry> = {
  [AGENT_PANE_KEY]: agentStatusEntry
}

const paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry> = {}

const mockState = {
  agentStatusByPaneKey,
  paneForegroundAgentByPaneKey
}

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null,
  getConnectionIdFromState: () => null
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => null,
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('./terminal-paste-coordinator', async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalPasteCoordinatorModule>()
  return {
    ...actual,
    planTerminalPasteWithYield: vi.fn(actual.planTerminalPasteWithYield)
  }
})

vi.mock('./terminal-clipboard-paste', () => ({
  pasteTerminalClipboard: vi.fn().mockResolvedValue({ status: 'pasted', kind: 'text' })
}))

function createStubPane(leafId: string): ManagedPane {
  const stub = {
    id: `pane-${leafId}`,
    leafId,
    container: document.createElement('div'),
    terminal: {
      modes: { bracketedPasteMode: false }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Minimal test stub for ManagedPane.
  return stub as unknown as ManagedPane
}

function createStubController(
  overrides: Partial<TerminalPaneCloseController> = {}
): TerminalPaneCloseController {
  const stub = {
    forceBracketedMultilineTextPaste: false,
    managerRef: { current: null },
    paneTransportsRef: { current: new Map() },
    setTerminalError: vi.fn(),
    tabId: TAB_ID,
    worktreeId: 'worktree-1',
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Minimal test stub for controller.
  return stub as unknown as TerminalPaneCloseController
}

describe('terminal-pane-paste-execution', () => {
  beforeEach(() => {
    const stubUi = {
      readClipboardText: vi.fn(),
      saveClipboardImageAsTempFile: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Minimal test stub for window.api.
    window.api = { ui: stubUi } as unknown as typeof window.api
  })

  it('exposes resolvePaneProtectedMultilinePasteOptions protecting multiline text on agent panes', () => {
    const controller = createStubController({ forceBracketedMultilineTextPaste: false })
    const execution = createTerminalPanePasteExecution(controller, 'darwin')

    expect(typeof execution.resolvePaneProtectedMultilinePasteOptions).toBe('function')

    const agentPane = createStubPane(AGENT_LEAF)
    expect(execution.resolvePaneProtectedMultilinePasteOptions(agentPane)).toEqual({
      forceBracketedPasteForMultiline: true
    })

    const shellPane = createStubPane(SHELL_LEAF)
    expect(execution.resolvePaneProtectedMultilinePasteOptions(shellPane)).toBeUndefined()
  })

  it('passes protectedMultilineTextPasteOptions when executing clipboard paste', () => {
    const controller = createStubController({ forceBracketedMultilineTextPaste: false })
    const execution = createTerminalPanePasteExecution(controller, 'darwin')
    const agentPane = createStubPane(AGENT_LEAF)

    execution.pasteFromClipboard(agentPane, 'keyboard')

    expect(pasteTerminalClipboard).toHaveBeenCalledWith(
      expect.objectContaining({
        forceBracketedMultilineTextPaste: false,
        protectedMultilineTextPasteOptions: {
          forceBracketedPasteForMultiline: true
        }
      })
    )
  })

  it('forwards windowsInputRecordNewline to planTerminalPasteWithYield', async () => {
    const controller = createStubController({ forceBracketedMultilineTextPaste: false })
    const execution = createTerminalPanePasteExecution(controller, 'win32')
    const agentPane = createStubPane(AGENT_LEAF)

    await execution.executePanePasteText(agentPane, 'keyboard', null, 'echo hello\necho world', {
      windowsInputRecordNewline: 'csi-u',
      forceBracketedPasteForMultiline: true
    })

    expect(planTerminalPasteWithYield).toHaveBeenCalledWith(
      expect.objectContaining({
        windowsInputRecordNewline: 'csi-u',
        forceBracketedPasteForMultiline: true
      })
    )
  })
})
