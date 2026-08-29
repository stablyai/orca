// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillInstallTargetFields } from './SkillInstallTargetFields'
import { defaultSelectedSkillProviders } from './skill-install-provider-groups'

const callbacks = {
  onEnvironmentChange: vi.fn(),
  onScopeChange: vi.fn(),
  onWorkspaceChange: vi.fn(),
  onExecutionTargetChange: vi.fn()
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { skills: { listWslDistros: vi.fn().mockResolvedValue(['Ubuntu-24.04']) } }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

describe('SkillInstallTargetFields', () => {
  it('names every conditional selector and contains long destination labels', async () => {
    const longWorkspace = `workspace-${'深'.repeat(240)}`
    const props = {
      ...callbacks,
      environmentId: 'local',
      scope: 'global' as const,
      workspace: '',
      executionTarget: null,
      runtimeEnvironments: [],
      runtimeStatus: new Map(),
      sshConnections: [],
      workspaceChoices: [{ id: 'folder_1', label: longWorkspace, kind: 'folder' as const }],
      providers: defaultSelectedSkillProviders(null),
      detectedAgents: null,
      onProvidersChange: vi.fn()
    }
    const view = render(<SkillInstallTargetFields {...props} />)

    expect(screen.getByRole('combobox', { name: 'Machine' })).toHaveClass('w-full', 'min-w-0')
    expect(screen.getByRole('combobox', { name: 'Destination' })).toHaveClass('w-full', 'min-w-0')
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Execution environment' })).toHaveClass(
        'w-full',
        'min-w-0'
      )
    )

    view.rerender(<SkillInstallTargetFields {...props} scope="workspace" workspace="folder_1" />)
    const workspace = screen.getByRole('combobox', { name: 'Workspace' })
    expect(workspace).toHaveClass('w-full', 'min-w-0')
    expect(workspace.textContent).toContain(longWorkspace)
  })

  it('filters workspaces via search and calls onWorkspaceChange upon selection', () => {
    const onWorkspaceChange = vi.fn()
    const props = {
      ...callbacks,
      environmentId: 'local',
      scope: 'workspace' as const,
      workspace: '',
      executionTarget: null,
      runtimeEnvironments: [],
      runtimeStatus: new Map(),
      sshConnections: [],
      workspaceChoices: [
        { id: 'wt-1', label: 'orca-main', kind: 'worktree' as const },
        { id: 'wt-2', label: 'feature-skills', kind: 'worktree' as const },
        { id: 'folder_1', label: 'dotfiles', kind: 'folder' as const }
      ],
      providers: defaultSelectedSkillProviders(null),
      detectedAgents: null,
      onProvidersChange: vi.fn(),
      onWorkspaceChange
    }

    render(<SkillInstallTargetFields {...props} />)

    const workspaceTrigger = screen.getByRole('combobox', { name: 'Workspace' })
    fireEvent.click(workspaceTrigger)

    const searchInput = screen.getByPlaceholderText('Search workspaces...')
    expect(searchInput).toBeInTheDocument()

    // Type query to filter
    fireEvent.change(searchInput, { target: { value: 'feature' } })

    expect(screen.getByText('feature-skills ·')).toBeInTheDocument()
    expect(screen.queryByText('orca-main ·')).toBeNull()

    // Click matching item
    fireEvent.click(screen.getByText('feature-skills ·'))
    expect(onWorkspaceChange).toHaveBeenCalledWith('wt-2')
  })
})
