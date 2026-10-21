import { describe, expect, it, vi } from 'vitest'
import type { BootstrapSplitManager } from './terminal-pane-bootstrap-split-record'
import type { PtyConnectionDeps } from './pty-connection-types'
import { runTerminalPaneBootstrapSplits } from './terminal-pane-mount-bootstrap'

// Only startup is read by the bootstrap; the full PTY dependency bag belongs to mounting.
function startupDeps(): PtyConnectionDeps {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bootstrap only mutates startup and never reaches any other PTY dependency.
  return { startup: { command: 'agent' } } as PtyConnectionDeps
}

describe('issue automation bootstrap', () => {
  it.each([false, true])(
    'splits once from the primary pane and preserves focus policy (%s)',
    (isActive) => {
      const ptyDeps = startupDeps()
      const issue = { command: 'issue runner', env: { ISSUE: '42' } }
      const commands: unknown[] = []
      const splitPane = vi.fn(() => {
        commands.push(ptyDeps.startup)
        return { id: 2 }
      })
      const setActivePane = vi.fn()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bootstrap only uses pane ids and these four manager methods.
      const manager = {
        getActivePane: () => ({ id: 1 }),
        getPanes: () => [{ id: 1 }],
        splitPane,
        setActivePane
      } as unknown as BootstrapSplitManager
      runTerminalPaneBootstrapSplits({ manager, ptyDeps, issueCommandSplit: issue, isActive })
      expect(splitPane).toHaveBeenCalledExactlyOnceWith(1, 'vertical')
      expect(commands).toEqual([issue])
      expect(setActivePane).toHaveBeenCalledExactlyOnceWith(1, { focus: isActive })
      expect(ptyDeps.startup).toBeNull()
      manager.splitPane(1, 'horizontal')
      expect(commands).toEqual([issue, null])
    }
  )
})
