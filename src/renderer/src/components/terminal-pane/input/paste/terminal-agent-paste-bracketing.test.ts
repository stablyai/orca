import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { describe, expect, it, vi } from 'vitest'

import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'

import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { pasteTerminalText } from './terminal-bracketed-paste'
import { executeTerminalPastePlan } from './terminal-paste-executor'
import { planTerminalPaste } from './terminal-paste-coordinator'
import type { TerminalPasteTarget, TerminalPasteTextOptions } from './terminal-paste-model'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'

const TAB_ID = 'tab-1'
const AGENT_LEAF = '11111111-1111-4111-8111-111111111111'

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

const CODEX_ON_AGENT_LEAF = { [AGENT_PANE_KEY]: agentEntry() }

function decide(
  args: Partial<Parameters<typeof resolveProtectedMultilinePasteOptionsForPane>[0]> = {}
): TerminalPasteTextOptions | undefined {
  return resolveProtectedMultilinePasteOptionsForPane({
    isWindowsClient: false,
    hostPlatform: 'linux',
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries(CODEX_ON_AGENT_LEAF)),
    paneForegroundAgentByPaneKey: {},
    tabId: TAB_ID,
    leafId: AGENT_LEAF,
    ...args
  })
}

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
})
