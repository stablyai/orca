// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReadyProjectHostSetupOption } from '@/lib/project-host-setup-options'
import type { MachineGroupOption, MachineOption } from '@/lib/machines/machine-group-options'
import RunTargetCombobox from './RunTargetCombobox'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

const PROVIDER = 'plugin:omarchy/omarchy' as const

const localOption: ReadyProjectHostSetupOption = {
  id: 'local-setup',
  kind: 'ready',
  projectId: 'project',
  hostId: 'local',
  repoId: 'repo',
  label: 'Local Mac',
  detail: '~/code/acme-web',
  path: '~/code/acme-web'
}

function machine(name: string, state: MachineOption['state'] = 'running'): MachineOption {
  return {
    providerKey: PROVIDER,
    machineId: name,
    environmentId: null,
    locationKey: null,
    name,
    state,
    lifetime: 'persistent',
    expiresAt: null
  }
}

const group: MachineGroupOption = {
  key: PROVIDER,
  providerKey: PROVIDER,
  name: 'Omarchy',
  environmentId: null,
  serverName: null,
  status: { kind: 'ready' },
  machines: ['omarchy-dev', 'pr-2231', 'perf-bench', 'gpu-box'].map((name) => machine(name)),
  archived: [],
  canCreate: false
}

function renderPicker(
  machines: Partial<React.ComponentProps<typeof RunTargetCombobox>['machines']> = {}
) {
  const onChange = vi.fn()
  const onProviderAction = vi.fn()
  const onCreate = vi.fn()
  const onHostChange = vi.fn()
  render(
    <RunTargetCombobox
      hostOptions={[localOption]}
      hostValue="local-setup"
      onHostChange={onHostChange}
      recipes={[]}
      recipeValue={null}
      machines={{
        groups: [group],
        selected: null,
        onChange,
        onProviderAction,
        onCreate,
        creating: null,
        ...machines
      }}
    />
  )
  return {
    onChange,
    onProviderAction,
    onCreate,
    onHostChange,
    field: screen.getByRole('combobox')
  }
}

afterEach(cleanup)

describe('run target machines', () => {
  it('labels the provider group without making the label a choice', () => {
    renderPicker()
    expect(screen.getByText('Omarchy').closest('[role="option"]')).toBeNull()
    expect(screen.getAllByRole('option').map((option) => option.textContent)).not.toContain(
      'Omarchy'
    )
    const machines = screen.getByRole('group', { name: 'Omarchy' })
    expect(machines.querySelectorAll('[role="option"]')).toHaveLength(4)
  })

  it('labels unconnected hosts beside a provider group', () => {
    render(
      <RunTargetCombobox
        hostOptions={[
          localOption,
          {
            id: 'ssh-setup',
            kind: 'needs-setup',
            projectId: 'project',
            hostId: 'ssh:awin',
            label: 'awin',
            detail: 'Not connected',
            isAvailable: false,
            attention: false,
            canSetLocation: false
          }
        ]}
        hostValue="local-setup"
        recipes={[]}
        recipeValue={null}
        machines={{
          groups: [group],
          selected: null,
          onChange: vi.fn(),
          onProviderAction: vi.fn(),
          onCreate: vi.fn(),
          creating: null
        }}
      />
    )
    const hosts = screen.getByRole('group', { name: 'SSH hosts' })
    expect(hosts.textContent).toContain('awin')
  })

  it('caps the group and expands it in place without closing', () => {
    const { field } = renderPicker()
    fireEvent.focus(field)
    expect(screen.queryByRole('option', { name: /gpu-box/ })).toBeNull()

    fireEvent.click(screen.getByRole('option', { name: /Show all \(4\)/ }))

    expect(screen.getByRole('option', { name: /gpu-box/ })).toBeTruthy()
    expect(field.getAttribute('aria-expanded')).toBe('true')
  })

  it('commits a machine and clears the host and recipe choices', () => {
    const onRecipeChange = vi.fn()
    const onChange = vi.fn()
    render(
      <RunTargetCombobox
        hostOptions={[localOption]}
        hostValue="local-setup"
        recipes={[]}
        recipeValue={null}
        onRecipeChange={onRecipeChange}
        machines={{
          groups: [group],
          selected: null,
          onChange,
          onProviderAction: vi.fn(),
          onCreate: vi.fn(),
          creating: null
        }}
      />
    )

    fireEvent.click(screen.getByRole('option', { name: /pr-2231/ }))

    expect(onChange).toHaveBeenCalledWith(group.machines[1])
    expect(onRecipeChange).toHaveBeenCalledWith(null)
  })

  it('reaches machine rows with the arrow keys, skipping the group label', () => {
    const { field, onChange } = renderPicker()
    fireEvent.focus(field)
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(group.machines[0])
  })

  it('paints the committed machine in the field, naming its state only when not running', () => {
    const shownFor = (picked: MachineOption): string => {
      cleanup()
      renderPicker({ selected: { group, machine: picked } })
      const field = screen.getByRole('combobox', { name: 'Run on' })
      return field.parentElement?.parentElement?.textContent ?? ''
    }
    const running = shownFor(group.machines[1])
    expect(running).toContain('pr-2231')
    expect(running).toContain('Omarchy')
    expect(running).not.toContain('Running')
    expect(shownFor(machine('pr-2231', 'sleeping'))).toContain('Sleeping')
  })

  it('fills only the armed row, which starts on the current choice', () => {
    const { field } = renderPicker({ selected: { group, machine: group.machines[1] } })
    fireEvent.focus(field)
    const armed = screen.getAllByRole('option').filter((option) => option.dataset.armed)
    expect(armed.map((option) => option.textContent)).toEqual([expect.stringContaining('pr-2231')])
  })

  it('turns a sign-in group into one row that asks the composer to sign in', () => {
    const signIn = { ...group, status: { kind: 'sign-in' as const }, machines: [] }
    const { onProviderAction } = renderPicker({ groups: [signIn] })

    fireEvent.click(screen.getByRole('option', { name: 'Sign in to Omarchy' }))

    expect(onProviderAction).toHaveBeenCalledWith({ kind: 'sign-in', group: signIn })
  })

  it('starts a new machine from the provider group and paints the draft in the field', () => {
    const creatable = { ...group, canCreate: true }
    const { onCreate } = renderPicker({ groups: [creatable] })
    fireEvent.click(screen.getByRole('option', { name: 'New machine on Omarchy…' }))
    expect(onCreate).toHaveBeenCalledWith(PROVIDER)

    cleanup()
    renderPicker({
      groups: [creatable],
      creating: { providerKey: PROVIDER, summary: 'Omarchy · Temporary · deletes 6:00 PM' }
    })
    const field = screen.getByRole('combobox', { name: 'Run on' })
    expect(field.parentElement?.parentElement?.textContent).toContain('New machine')
  })
})
