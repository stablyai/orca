import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('TerminalPane quick-command initialization', () => {
  it('defers quick-command host work until the context menu opens', () => {
    const startupSource = readFileSync(
      join(__dirname, 'use-terminal-pane-startup-actions.ts'),
      'utf8'
    )
    const contextSource = readFileSync(
      join(__dirname, 'use-terminal-pane-context-actions.ts'),
      'utf8'
    )

    expect(startupSource).toContain('const quickCommandRepoId =')
    expect(startupSource).not.toContain('useTerminalQuickCommandHosts')
    expect(contextSource).toContain('useTerminalQuickCommandHosts(worktreeId, contextMenu.open)')
    expect(contextSource).toContain('terminalQuickCommandMatchesWorkspaceProject')
    expect(contextSource).toContain('projectHostSetupProjection.setups')
    expect(contextSource).toContain('quickCommandExecutionHostId')
  })
})
