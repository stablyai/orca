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
      const work: { size: number; initial: number; update: number; targetChange: number }[] = []
      for (const size of [32, 320]) {
        let optionReads = 0
        const projectOptions = Array.from({ length: size }, (_, index) => {
          const optionKind = index === 0 ? (kind === 'project' ? 'project-group' : 'project') : kind
          return {
            get id() {
              optionReads++
              return index === size - 1 ? 'target' : index === 0 ? 'alternate' : `option-${index}`
            },
            displayName: `Target ${index}`,
            badgeColor: '',
            detail: `/target-${index}`,
            ...(optionKind === 'project'
              ? { kind: optionKind, projectId: `target-${index}` }
              : {
                  kind: optionKind,
                  projectGroupId: `target-${index}`,
                  parentPath: `/target-${index}`,
                  connectionId: null
                })
          }
        })
        const onQuickAgentChange = vi.fn()
        const section = (selectedProjectId: string, advancedOpen: boolean) => (
          <TooltipProvider>
            <NewWorkspaceComposerAgentSection
              quickAgent="codex"
              selectedRepoIsGit={selectedRepoIsGit}
              selectedProjectId={selectedProjectId}
              projectOptions={projectOptions}
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
              advancedOpen={advancedOpen}
              onToggleAdvanced={vi.fn()}
              visibleQuickAgents={AGENT_CATALOG}
              defaultTuiAgent="blank"
              handleSetDefaultAgent={vi.fn()}
            />
          </TooltipProvider>
        )
        const { rerender, unmount } = render(section('target', false))
        const initial = optionReads
        expect(initial).toBeLessThanOrEqual(selectedRepoIsGit ? size : 0)
        expect(initial).toBeGreaterThanOrEqual(selectedRepoIsGit ? 1 : 0)

        expect(screen.getByRole('button', { name: 'Select agent' }).textContent).not.toContain(
          'Chat'
        )
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

        optionReads = 0
        rerender(section('target', true))
        const update = optionReads
        expect(update).toBeLessThanOrEqual(selectedRepoIsGit ? size : 0)
        expect(update).toBeGreaterThanOrEqual(selectedRepoIsGit ? 1 : 0)

        optionReads = 0
        rerender(section('alternate', true))
        const targetChange = optionReads
        expect(targetChange).toBeLessThanOrEqual(selectedRepoIsGit ? 1 : 0)
        expect(targetChange).toBeGreaterThanOrEqual(selectedRepoIsGit ? 1 : 0)
        fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
          button: 0,
          ctrlKey: false
        })
        const changedMenu = screen.getByRole('menu')
        const changedMatched = selectedRepoIsGit && kind === 'project-group'
        expect(changedMenu.classList.contains('w-(--radix-dropdown-menu-trigger-width)')).toBe(
          changedMatched
        )
        expect(changedMenu.classList.contains('min-w-(--radix-dropdown-menu-trigger-width)')).toBe(
          changedMatched
        )
        expect(changedMenu.classList.contains('min-w-64')).toBe(!changedMatched)
        expect(onQuickAgentChange).toHaveBeenCalledExactlyOnceWith(null)
        work.push({ size, initial, update, targetChange })
        unmount()
      }
      expect(work[1].initial).toBeLessThanOrEqual(10 * work[0].initial)
      expect(work[1].update).toBeLessThanOrEqual(10 * work[0].update)
      expect(work[1].targetChange).toBeLessThanOrEqual(work[0].targetChange)
      console.info('project option reads', { kind, selectedRepoIsGit, work })
    }
  )
})
