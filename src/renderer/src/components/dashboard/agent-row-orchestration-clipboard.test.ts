import { describe, expect, it, vi } from 'vitest'
import {
  buildOrchestrationAskCommand,
  buildOrchestrationSendCommand,
  buildWorktreeGroupAddress,
  resolveTerminalHandleForPaneKey
} from './agent-row-orchestration-clipboard'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

describe('agent-row-orchestration-clipboard', () => {
  it('builds orchestration send/ask command templates and worktree addresses', () => {
    expect(buildOrchestrationSendCommand('term_worker')).toBe(
      'orca orchestration send --to term_worker --subject "" --json'
    )
    expect(buildOrchestrationAskCommand('term_worker')).toBe(
      'orca orchestration send --to term_worker --type question --subject "" --json'
    )
    expect(buildWorktreeGroupAddress('wt_abc')).toBe('@worktree:wt_abc')
  })

  it('resolves a terminal handle for a pane key', async () => {
    const callRuntime = vi.fn().mockResolvedValue({
      id: 'req-1',
      ok: true,
      result: {
        terminal: {
          handle: 'term_sidebar_agent',
          tabId: 'tab-1',
          leafId: LEAF_ID,
          ptyId: 'pty-1'
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      resolveTerminalHandleForPaneKey({
        paneKey: PANE_KEY,
        callRuntime
      })
    ).resolves.toBe('term_sidebar_agent')

    expect(callRuntime).toHaveBeenCalledWith({
      method: 'terminal.resolvePane',
      params: { paneKey: PANE_KEY }
    })
  })
})
