// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render as renderUi, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReadyProjectHostSetupOption } from '@/lib/project-host-setup-options'
import RunTargetCombobox from './RunTargetCombobox'
import { TooltipProvider } from '@/components/ui/tooltip'
import { buildRunTargetRows } from './run-target-options'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

function render(element: React.ReactNode): ReturnType<typeof renderUi> {
  return renderUi(<TooltipProvider>{element}</TooltipProvider>)
}

const localOption: ReadyProjectHostSetupOption = {
  id: 'same-id',
  kind: 'ready',
  projectId: 'project',
  hostId: 'local',
  repoId: 'same-id',
  label: 'Local',
  detail: '/local',
  path: '/local'
}
const sshOption: ReadyProjectHostSetupOption = {
  ...localOption,
  hostId: 'ssh:builder',
  label: 'Builder',
  detail: '/remote',
  path: '/remote'
}
const options = [localOption, sshOption]

afterEach(cleanup)

describe('run target host identity', () => {
  it('shows the selected SSH host when its setup ID is also used locally', () => {
    render(
      <RunTargetCombobox
        hostOptions={options}
        hostValue="same-id"
        hostExecutionHostId="ssh:builder"
        recipes={[]}
        recipeValue={null}
      />
    )

    const field = screen.getByRole('combobox', { name: 'Run on' })
    expect(field.parentElement?.parentElement?.textContent).toContain('Builder')
  })

  it('commits a host-qualified setup selection when the SSH row is selected', () => {
    const onHostChange = vi.fn()
    render(
      <RunTargetCombobox
        hostOptions={options}
        hostValue="same-id"
        onHostChange={onHostChange}
        recipes={[]}
        recipeValue={null}
      />
    )

    fireEvent.click(screen.getByRole('option', { name: /Builder/ }))
    expect(onHostChange).toHaveBeenCalledWith(JSON.stringify(['same-id', 'ssh:builder']))
  })

  it('shows a merged machine row when the selection names its other host id', () => {
    const serverOption: ReadyProjectHostSetupOption = {
      ...sshOption,
      id: 'server-setup',
      hostId: 'runtime:builder-server',
      aliasSetups: [{ id: 'ssh-setup', hostId: 'ssh:builder' }]
    }
    render(
      <RunTargetCombobox
        hostOptions={[localOption, serverOption]}
        hostValue="ssh-setup"
        hostExecutionHostId="ssh:builder"
        recipes={[]}
        recipeValue={null}
      />
    )

    const field = screen.getByRole('combobox', { name: 'Run on' })
    expect(field.parentElement?.parentElement?.textContent).toContain('Builder')
  })

  it('gives duplicate setup IDs distinct keyboard navigation keys', () => {
    const { rows } = buildRunTargetRows({
      hostOptions: options,
      recipes: [],
      query: '',
      hasAddHost: false
    })
    expect(new Set(rows.map((row) => row.key)).size).toBe(2)
  })
})
