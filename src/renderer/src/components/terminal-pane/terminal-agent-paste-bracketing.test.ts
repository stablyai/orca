import { describe, expect, it, vi } from 'vitest'

import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { pasteTerminalText } from './terminal-bracketed-paste'
import { executeTerminalPastePlan } from './terminal-paste-executor'
import { planTerminalPaste } from './terminal-paste-coordinator'
import type { TerminalPasteTarget, TerminalPasteTextOptions } from './terminal-paste-model'
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
    // Idle live agents can stay done past the freshness TTL and still require paste brackets.
    expect(
      decide({
        agentStatusByPaneKey: {
          [AGENT_PANE_KEY]: agentEntry({ state: 'done', updatedAt: 0, stateStartedAt: 0 })
        }
      })
    ).toEqual({ forceBracketedPasteForMultiline: true })
  })

  it('degrades to the pre-fix path instead of throwing on a malformed pane key', () => {
    // Malformed pane keys throw before the paste handler’s catch; require graceful fallback rather than a silent no-op.
    expect(() => decide({ leafId: 'not-a-uuid' })).not.toThrow()
    expect(decide({ leafId: 'not-a-uuid' })).toBeUndefined()
    expect(() => decide({ tabId: 'tab:with:colons' })).not.toThrow()
    expect(decide({ tabId: 'tab:with:colons' })).toBeUndefined()
  })

  it('still brackets when shellForeground is latched true while an agent owns the pane', () => {
    // Without OSC 133, shellForeground stays true while the agent runs and cannot veto bracketing.
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

describe('leading-newline paste into a remote agent pane', () => {
  // ConPTY lost DECSET 2004, so a leading LF became CR and submitted a Codex draft on a remote Windows host.
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
