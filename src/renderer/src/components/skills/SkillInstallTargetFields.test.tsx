// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillInstallTargetFields } from './SkillInstallTargetFields'
import { defaultSelectedSkillProviders } from './skill-install-provider-groups'

const callbacks = {
  onEnvironmentChange: vi.fn(),
  onScopeChange: vi.fn(),
  onWorkspaceChange: vi.fn(),
  onExecutionTargetChange: vi.fn()
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

describe('SkillInstallTargetFields', () => {
  it('names every conditional selector and contains long destination labels', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { listWslDistros: vi.fn().mockResolvedValue(['Ubuntu-24.04']) } }
    })
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
})
