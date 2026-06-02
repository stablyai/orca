import { describe, expect, it } from 'vitest'
import type { TerminalQuickCommand } from '../../../../shared/types'
import {
  createTerminalQuickCommandDialogDraftMemory,
  switchTerminalQuickCommandDialogAction
} from './terminal-quick-command-dialog-draft'

describe('terminal quick command dialog draft transitions', () => {
  it('keeps agent prompt blank when switching from a terminal command for the first time', () => {
    const command: TerminalQuickCommand = {
      id: 'qc-1',
      label: 'Status',
      action: 'terminal-command',
      command: 'git status',
      appendEnter: false,
      scope: { type: 'global' }
    }

    const result = switchTerminalQuickCommandDialogAction(
      command,
      'agent-prompt',
      createTerminalQuickCommandDialogDraftMemory(command, 'claude')
    )

    expect(result.draft).toEqual({
      id: 'qc-1',
      label: 'Status',
      action: 'agent-prompt',
      agent: 'claude',
      prompt: '',
      scope: { type: 'global' }
    })
  })

  it('keeps terminal command blank when switching from an agent prompt for the first time', () => {
    const command: TerminalQuickCommand = {
      id: 'qc-1',
      label: 'Review',
      action: 'agent-prompt',
      agent: 'codex',
      prompt: 'Review the diff',
      scope: { type: 'repo', repoId: 'repo-1' }
    }

    const result = switchTerminalQuickCommandDialogAction(
      command,
      'terminal-command',
      createTerminalQuickCommandDialogDraftMemory(command, 'claude')
    )

    expect(result.draft).toEqual({
      id: 'qc-1',
      label: 'Review',
      action: 'terminal-command',
      command: '',
      appendEnter: true,
      scope: { type: 'repo', repoId: 'repo-1' }
    })
  })

  it('preserves independent text, agent, and append-enter drafts across toggles', () => {
    const initial: TerminalQuickCommand = {
      id: 'qc-1',
      label: 'Work',
      action: 'terminal-command',
      command: 'pnpm test',
      appendEnter: false,
      scope: { type: 'global' }
    }
    const initialMemory = createTerminalQuickCommandDialogDraftMemory(initial, 'claude')
    const toAgent = switchTerminalQuickCommandDialogAction(initial, 'agent-prompt', initialMemory)
    const editedAgent: TerminalQuickCommand = {
      ...toAgent.draft,
      action: 'agent-prompt',
      agent: 'codex',
      prompt: 'Investigate failures'
    }
    const backToTerminal = switchTerminalQuickCommandDialogAction(
      editedAgent,
      'terminal-command',
      toAgent.memory
    )
    const editedTerminal: TerminalQuickCommand = {
      ...backToTerminal.draft,
      action: 'terminal-command',
      command: 'pnpm vitest',
      appendEnter: true
    }
    const backToAgent = switchTerminalQuickCommandDialogAction(
      editedTerminal,
      'agent-prompt',
      backToTerminal.memory
    )

    expect(backToTerminal.draft).toMatchObject({
      action: 'terminal-command',
      command: 'pnpm test',
      appendEnter: false
    })
    expect(backToAgent.draft).toMatchObject({
      action: 'agent-prompt',
      agent: 'codex',
      prompt: 'Investigate failures'
    })

    const finalTerminal = switchTerminalQuickCommandDialogAction(
      backToAgent.draft,
      'terminal-command',
      backToAgent.memory
    )
    expect(finalTerminal.draft).toMatchObject({
      action: 'terminal-command',
      command: 'pnpm vitest',
      appendEnter: true
    })
  })
})
