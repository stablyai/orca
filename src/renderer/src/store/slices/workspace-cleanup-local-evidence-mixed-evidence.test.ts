import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { probeTerminalLiveness } from './workspace-cleanup-local-evidence'

describe('workspace cleanup mixed PTY evidence', () => {
  it('preserves an unverifiable foreground half when children report exited', async () => {
    const inspectProcess = vi.fn().mockResolvedValue({
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'unverifiable', reason: 'exit raced the foreground read' },
        children: { verdict: 'exited' }
      }
    })
    ;(globalThis as { window?: unknown }).window = {
      api: {
        pty: {
          inspectProcess,
          hasChildProcesses: vi.fn(),
          getForegroundProcess: vi.fn()
        }
      }
    }
    const state = {
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: {},
      ptyIdsByTabId: { 'tab-1': ['pty-race'] },
      runtimePaneTitlesByTabId: {},
      terminalLayoutsByTabId: {}
    } as unknown as AppState

    await expect(probeTerminalLiveness(state, [{ id: 'tab-1', title: 'shell' }])).resolves.toBe(
      'unverifiable'
    )
    expect(inspectProcess).toHaveBeenCalledWith('pty-race')
  })
})
