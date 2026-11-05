// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SidebarHostOption } from '../sidebar/worktree-list/controls/sidebar-host-options'

import { AddRepoHostSelector } from '../sidebar/project-admission/host-selection/AddRepoHostSelector'

// Why 13,692: the host count from the generated ~/.ssh/config in the renderer crash this guards.
const HOST_COUNT = 13_692

const names = Array.from({ length: HOST_COUNT }, (_, i) => `node-${String(i).padStart(5, '0')}`)
const lastName = names[HOST_COUNT - 1]!

afterEach(() => {
  cleanup()
})

describe('host lists with a 13,692-host ssh config', () => {
  it('Add Project host search hides setup actions so Enter picks the typed host', () => {
    const hosts: SidebarHostOption[] = names.map((name, i) => ({
      id: `runtime:server-${i}`,
      label: name,
      detail: '',
      kind: 'runtime',
      health: 'available',
      presence: 'configured'
    }))
    const onSelectHost = vi.fn()
    render(
      <AddRepoHostSelector
        hosts={hosts}
        selectedHostId={hosts[0]!.id}
        open
        onOpenChange={vi.fn()}
        onSelectHost={onSelectHost}
        onAddSshHost={vi.fn()}
      />
    )
    expect(screen.getByText('Add remote host')).toBeTruthy()
    const search = screen.getByRole('combobox', { name: 'Search hosts…' })
    fireEvent.change(search, { target: { value: lastName } })
    expect(screen.queryByText('Add remote host')).toBeNull()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelectHost).toHaveBeenCalledWith(`runtime:server-${HOST_COUNT - 1}`)
  })
})
