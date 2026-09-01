import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { CustomTuiAgent } from '../../../../shared/types'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import type { AppState } from '../../store/types'
import { useAppStore } from '../../store'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { pasteTerminalText } from './terminal-bracketed-paste'
import {
  executeTerminalPastePlan,
  planTerminalPaste,
  type TerminalPasteTarget,
  type TerminalPasteTextOptions
} from './terminal-paste-coordinator'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'

const TAB_ID = 'tab-1'
const AGENT_LEAF = '11111111-1111-4111-8111-111111111111'
const SHELL_LEAF = '22222222-2222-4222-8222-222222222222'
const AGENT_PANE_KEY = `${TAB_ID}:${AGENT_LEAF}`

function agentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'waiting',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    stateHistory: [],
    agentType: 'codex',
    paneKey: AGENT_PANE_KEY,
    ...overrides
  }
}

function foregroundEntry(
  overrides: Partial<PaneForegroundAgentEntry> = {}
): PaneForegroundAgentEntry {
  return { agent: null, shellForeground: false, ...overrides }
}

const CODEX_ON_AGENT_LEAF = { [AGENT_PANE_KEY]: agentEntry() }

function decide(
  args: Partial<Parameters<typeof resolveProtectedMultilinePasteOptionsForPane>[0]> = {}
): TerminalPasteTextOptions | undefined {
  return resolveProtectedMultilinePasteOptionsForPane({
    isWindowsClient: false,
    hostPlatform: 'linux',
    agentStatusByPaneKey: CODEX_ON_AGENT_LEAF,
    paneForegroundAgentByPaneKey: {},
    tabId: TAB_ID,
    leafId: AGENT_LEAF,
    ...args
  })
}

describe('resolveProtectedMultilinePasteOptionsForPane', () => {
  it('brackets an agent pane on a non-Windows host', () => {
    expect(decide()).toEqual({ forceBracketedPasteForMultiline: true })
  })

  it('leaves a plain shell pane alone so ESC[200~ never reaches a non-TUI program', () => {
    expect(decide({ leafId: SHELL_LEAF })).toBeUndefined()
  })

  it('gates per leaf, not per tab', () => {
    expect(decide({ tabId: 'other-tab' })).toBeUndefined()
  })

  it('keeps the existing Windows-client behaviour for non-agent panes', () => {
    expect(decide({ isWindowsClient: true, agentStatusByPaneKey: {}, leafId: SHELL_LEAF })).toEqual(
      { forceBracketedPasteForMultiline: true }
    )
  })

  it('ignores a pane whose agentType is not a TUI agent', () => {
    expect(
      decide({
        agentStatusByPaneKey: {
          [AGENT_PANE_KEY]: agentEntry({
            agentType: 'not-an-agent' as AgentStatusEntry['agentType']
          })
        }
      })
    ).toBeUndefined()
  })

  it('brackets on a process-confirmed agent even with no status row', () => {
    expect(
      decide({
        agentStatusByPaneKey: {},
        paneForegroundAgentByPaneKey: {
          [AGENT_PANE_KEY]: foregroundEntry({ agent: 'codex', shellForeground: false })
        }
      })
    ).toEqual({ forceBracketedPasteForMultiline: true })
  })

  it('vetoes a row rehydrated from disk across an app restart', () => {
    expect(
      decide({
        agentStatusByPaneKey: {
          [AGENT_PANE_KEY]: agentEntry({ restoredUnconfirmed: true })
        }
      })
    ).toBeUndefined()
  })

  it('still brackets a long-idle agent parked at done', () => {
    // Why: an idle-but-live agent sits at `done` with an old updatedAt. Gating on
    // state or the 30-minute freshness TTL would strip bracketing from exactly the
    // pane that needs it most.
    expect(
      decide({
        agentStatusByPaneKey: {
          [AGENT_PANE_KEY]: agentEntry({ state: 'done', updatedAt: 0, stateStartedAt: 0 })
        }
      })
    ).toEqual({ forceBracketedPasteForMultiline: true })
  })

  it('degrades to the pre-fix path instead of throwing on a malformed pane key', () => {
    // Why: makePaneKey throws on a non-UUID leaf or a tabId containing ':'. The throw
    // would escape before the paste helper's catch is attached, making the paste a
    // silent no-op with no error surface.
    expect(() => decide({ leafId: 'not-a-uuid' })).not.toThrow()
    expect(decide({ leafId: 'not-a-uuid' })).toBeUndefined()
    expect(() => decide({ tabId: 'tab:with:colons' })).not.toThrow()
    expect(decide({ tabId: 'tab:with:colons' })).toBeUndefined()
  })

  it('still brackets when shellForeground is latched true while an agent owns the pane', () => {
    // Why: shellForeground is republished only at OSC 133 boundaries, so a shell with
    // no 133 integration leaves it true while an agent runs. Measured live: vetoing on
    // it reinstated the submit bug.
    expect(
      decide({
        paneForegroundAgentByPaneKey: {
          [AGENT_PANE_KEY]: foregroundEntry({ shellForeground: true })
        }
      })
    ).toEqual({ forceBracketedPasteForMultiline: true })
  })

  it('uses modified Enter for an agent that reads Windows input records', () => {
    expect(decide({ hostPlatform: 'win32' })).toEqual({
      windowsInputRecordNewline: 'alt-enter'
    })
  })

  it('does not change unverified Windows agent paste protocols', () => {
    expect(
      decide({
        hostPlatform: 'win32',
        agentStatusByPaneKey: {
          [AGENT_PANE_KEY]: agentEntry({ agentType: 'pi' })
        }
      })
    ).toEqual({ forceBracketedPasteForMultiline: true })
  })
})

describe('custom-agent-owned panes', () => {
  // Regression: agent-status rows and pty launch metadata keep the custom id
  // unresolved, but TUI_AGENT_CONFIG is keyed by built-in ids — indexing raw
  // read `windowsInputRecordPasteNewline` off undefined BEFORE the win32 guard,
  // so every multiline paste threw on macOS/Linux too.
  const CUSTOM_CODEX_ID = 'custom-agent:codex:3f9f1c22-2a1b-4c33-9a44-55d6e7f8a900' as const
  const codexDerived: CustomTuiAgent = {
    id: CUSTOM_CODEX_ID,
    baseAgent: 'codex',
    label: 'Codex (review)',
    args: '',
    env: {},
    syncEnv: false
  }
  let originalSettings: AppState['settings']

  beforeEach(() => {
    originalSettings = useAppStore.getState().settings
    useAppStore.setState({
      settings: {
        customTuiAgents: [codexDerived],
        deletedCustomTuiAgents: []
      } as unknown as AppState['settings']
    })
  })

  afterEach(() => {
    useAppStore.setState({ settings: originalSettings })
  })

  const customStatusRow = {
    agentStatusByPaneKey: { [AGENT_PANE_KEY]: agentEntry({ agentType: CUSTOM_CODEX_ID }) }
  }

  it('does not throw on a non-Windows host and brackets like its base', () => {
    expect(() => decide(customStatusRow)).not.toThrow()
    expect(decide(customStatusRow)).toEqual({ forceBracketedPasteForMultiline: true })
  })

  it('brackets a process-confirmed custom foreground agent with no status row', () => {
    const args = {
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {
        [AGENT_PANE_KEY]: foregroundEntry({ agent: CUSTOM_CODEX_ID })
      }
    }
    expect(() => decide(args)).not.toThrow()
    expect(decide(args)).toEqual({ forceBracketedPasteForMultiline: true })
  })

  it('inherits the base agent Windows input-record newline', () => {
    expect(decide({ hostPlatform: 'win32', ...customStatusRow })).toEqual({
      windowsInputRecordNewline: 'alt-enter'
    })
  })

  it('degrades to plain bracketing when the catalog lost the custom id', () => {
    useAppStore.setState({
      settings: {
        customTuiAgents: [],
        deletedCustomTuiAgents: []
      } as unknown as AppState['settings']
    })
    expect(decide({ hostPlatform: 'win32', ...customStatusRow })).toEqual({
      forceBracketedPasteForMultiline: true
    })
  })
})

describe('leading-newline paste into a remote agent pane', () => {
  // Regression: a mac client on a remote Windows host pasted a block starting with "\n".
  // ConPTY never forwarded DECSET 2004, so xterm rewrote the newline to CR and codex
  // submitted the draft parked in its composer.
  const PASTED = '\nRemember: At the end of the day, we want the best possible code.'

  function remoteWindowsTarget(): TerminalPasteTarget {
    return {
      kind: 'terminal',
      paneId: 1,
      leafId: AGENT_LEAF,
      ptyId: 'remote:host-abc/pty-1',
      runtime: resolveTerminalPasteRuntime({
        platform: 'win32',
        ptyId: 'remote:host-abc/pty-1',
        isWindowsConpty: false
      })
    }
  }

  it('encodes the leading newline as modified Enter instead of submit', async () => {
    const terminal = {
      modes: { bracketedPasteMode: false },
      options: { ignoreBracketedPasteMode: false },
      input: vi.fn(),
      paste: vi.fn()
    }
    const plan = planTerminalPaste({
      text: PASTED,
      source: 'keyboard',
      target: remoteWindowsTarget(),
      terminalBracketedPasteMode: false,
      ...decide({ hostPlatform: 'win32' })
    })
    await executeTerminalPastePlan(plan, {
      pasteText: (text, options) => pasteTerminalText(terminal, text, options)
    })

    expect(plan.payload.lineCount).toBe(2)
    expect(plan.mode).toBe('windows-input-record')
    expect(plan.bracketed).toBe(false)
    expect(terminal.input).toHaveBeenCalledWith(`\x1b\r${PASTED.slice(1)}`)
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('a single-line paste stays on the direct path', () => {
    const plan = planTerminalPaste({
      text: 'no newline here',
      source: 'keyboard',
      target: remoteWindowsTarget(),
      terminalBracketedPasteMode: false,
      ...decide({ hostPlatform: 'win32' })
    })

    expect(plan.mode).toBe('direct')
  })
})
