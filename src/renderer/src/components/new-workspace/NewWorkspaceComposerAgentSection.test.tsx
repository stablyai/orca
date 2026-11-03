// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { NewWorkspaceComposerAgentSection } from './NewWorkspaceComposerAgentSection'

afterEach(cleanup)

describe('NewWorkspaceComposerAgentSection agent picker', () => {
  it.each([
    { kind: 'project', selectedRepoIsGit: true, matched: true },
    { kind: 'project', selectedRepoIsGit: false, matched: false },
    { kind: 'project-group', selectedRepoIsGit: true, matched: false }
  ] as const)(
    'keeps Blank Terminal and scopes menu width to Create worktree: $kind / $selectedRepoIsGit',
    ({ kind, selectedRepoIsGit, matched }) => {
      const onQuickAgentChange = vi.fn()
      render(
        <TooltipProvider>
          <NewWorkspaceComposerAgentSection
            quickAgent="codex"
            selectedRepoIsGit={selectedRepoIsGit}
            selectedProjectId="target"
            projectOptions={[
              {
                id: 'target',
                displayName: 'Target',
                badgeColor: '',
                detail: '/target',
                ...(kind === 'project'
                  ? { kind, projectId: 'target' }
                  : { kind, projectGroupId: 'target', parentPath: '/target', connectionId: null })
              }
            ]}
            agentSurfaceRows={{
              model: {
                state: 'settled',
                rows: [{ agent: 'codex', kind: 'terminal' }],
                detection: {
                  detectedIds: ['codex'],
                  isLoading: false,
                  isRefreshing: false,
                  detectionFailed: false,
                  needsServerUpdate: false,
                  refresh: async () => ['codex']
                }
              },
              selection: { ready: true, cli: false },
              contextKey: 'test',
              onPick: vi.fn()
            }}
            onQuickAgentChange={onQuickAgentChange}
            onOpenAgentSettings={vi.fn()}
            createDisabled={false}
            onCreate={vi.fn()}
            advancedOpen={false}
            onToggleAdvanced={vi.fn()}
            visibleQuickAgents={AGENT_CATALOG}
            defaultTuiAgent="blank"
            handleSetDefaultAgent={vi.fn()}
          />
        </TooltipProvider>
      )

      expect(screen.getByRole('button', { name: 'Select agent' }).textContent).not.toContain('Chat')
      expect(screen.getByRole('button', { name: 'Select agent' }).textContent).not.toContain(
        '(CLI)'
      )
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
        button: 0,
        ctrlKey: false
      })
      const blankTerminal = screen.getByRole('menuitem', { name: 'Blank Terminal' })
      const menu = screen.getByRole('menu')
      expect(menu.classList.contains('w-(--radix-dropdown-menu-trigger-width)')).toBe(matched)
      expect(menu.classList.contains('min-w-(--radix-dropdown-menu-trigger-width)')).toBe(matched)
      expect(menu.classList.contains('min-w-64')).toBe(!matched)
      expect(blankTerminal.querySelector('svg')).not.toBeNull()
      expect(screen.queryByRole('menuitem', { name: 'Setup only' })).toBeNull()
      expect(screen.getByRole('menuitem', { name: 'Agent settings…' })).toBeTruthy()
      fireEvent.click(blankTerminal)

      expect(onQuickAgentChange).toHaveBeenCalledWith(null)
    }
  )
})
