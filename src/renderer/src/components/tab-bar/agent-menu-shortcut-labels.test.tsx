// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { ProjectedAgentMenuItems } from './QuickLaunchButton'
import { AgentLaunchPickerMenu } from '../agent/AgentLaunchPickerMenu'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'cli' }],
  surfaces: ['terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  catalog: { origin: 'unknown' }
}
afterEach(cleanup)
it('projects live shortcuts only in the + picker and preserves its loading presentation', () => {
  const initial = useAppStore.getState()
  const launch = () => {}
  const root = render(<div />)
  const model: Parameters<typeof ProjectedAgentMenuItems>[0]['model'] = {
    state: 'settled',
    rows: entry.rows,
    detection: {
      detectedIds: ['codex'],
      isLoading: false,
      isRefreshing: false,
      detectionFailed: false,
      needsServerUpdate: false,
      refresh: async () => ['codex']
    },
    pickerContext: {
      workspace: { kind: 'git-worktree' as const, worktreeId: 'menu-wt' },
      executionHostId: 'local',
      settings: null,
      key: 'menu-wt'
    }
  }
  const renderMenu = (loading = false) =>
    act(() =>
      root.rerender(
        <TooltipProvider>
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
            <DropdownMenuContent>
              <ProjectedAgentMenuItems
                model={loading ? { state: 'loading', placeholderCount: 2 } : model}
                pickerEntries={[entry]}
                runLaunch={launch}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      )
    )
  try {
    act(() =>
      useAppStore.setState({
        repos: [TEST_REPO],
        worktreesByRepo: {
          [TEST_REPO.id]: [makeWorktree({ id: 'menu-wt', repoId: TEST_REPO.id })]
        },
        settings: {
          ...getDefaultSettings('/tmp'),
          defaultTuiAgent: 'blank',
          experimentalNativeChat: false
        },
        detectedAgentIds: ['codex'],
        keybindings: { 'tab.newAgent': ['Mod+Alt+T'], 'tab.newAgent.codex': ['Mod+Shift+X'] }
      })
    )
    renderMenu()
    expect(document.body.textContent).toContain('Ctrl+Alt+T, Ctrl+⇧+X')
    act(() =>
      useAppStore.setState({
        keybindings: { 'tab.newAgent': [], 'tab.newAgent.codex': ['Mod+Shift+K'] }
      })
    )
    expect(document.body.textContent).toContain('Ctrl+⇧+K')
    expect(document.body.textContent).not.toContain('Ctrl+⇧+X')
    renderMenu(true)
    expect(document.querySelectorAll('[aria-label="Loading agents"]')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('Ctrl+⇧+K')
    act(() =>
      root.rerender(
        <TooltipProvider>
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
            <DropdownMenuContent>
              <AgentLaunchPickerMenu entries={[entry]} runLaunch={launch} />
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      )
    )
    expect(document.body.textContent).not.toContain('Ctrl+⇧+K')
  } finally {
    act(() => useAppStore.setState(initial, true))
  }
})
