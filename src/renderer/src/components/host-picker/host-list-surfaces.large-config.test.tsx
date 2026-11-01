// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'
import { HOST_LIST_ROW_LIMIT } from './bounded-host-list'
import { HostCombobox } from './HostCombobox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { SshTargetSelect } from '../settings/SshTargetSelect'
import { SkillInstallMachineSelect } from '../skills/SkillInstallMachineSelect'
import { RemoteStep } from '../sidebar/AddRepoRemoteStep'
import { AddRepoHostSelector } from '../sidebar/AddRepoHostSelector'
import { buildRunTargetRows } from '../new-workspace/run-target-options'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'

// Why 13,692: the host count from the generated ~/.ssh/config in the renderer crash this guards.
const HOST_COUNT = 13_692
const NODE_BUDGET = 3_000

const names = Array.from({ length: HOST_COUNT }, (_, i) => `node-${String(i).padStart(5, '0')}`)
const lastName = names[HOST_COUNT - 1]!

function nodeCount(): number {
  return document.body.getElementsByTagName('*').length
}

function sshTarget(name: string, index: number): SshTarget {
  return { id: `ssh-${index}`, label: name, host: name, port: 22, username: 'deploy' }
}

afterEach(() => {
  cleanup()
})

describe('host lists with a 13,692-host ssh config', () => {
  it('HostCombobox mounts nothing while closed and a bounded, searchable list when open', async () => {
    render(
      <HostCombobox
        value="ssh-0"
        onChange={vi.fn()}
        ariaLabel="Host"
        options={names.map((name, i) => ({ id: `ssh-${i}`, label: name }))}
      />
    )
    expect(nodeCount()).toBeLessThan(50)
    fireEvent.click(screen.getByRole('combobox', { name: 'Host' }))
    const search = await screen.findByRole('combobox', { name: 'Search hosts…' })
    expect(screen.getAllByRole('option')).toHaveLength(HOST_LIST_ROW_LIMIT + 1)
    expect(screen.getByText(/more hosts\. Search by name/)).toBeTruthy()
    expect(nodeCount()).toBeLessThan(NODE_BUDGET)
    fireEvent.change(search, { target: { value: lastName } })
    expect(screen.getAllByRole('option')[0]?.textContent).toContain(lastName)
  })

  it('Settings > Servers SSH host picker', async () => {
    const onChange = vi.fn()
    render(
      <>
        <label htmlFor="ssh-host">SSH host</label>
        <SshTargetSelect
          id="ssh-host"
          targets={names.map(sshTarget)}
          value=""
          onChange={onChange}
          placeholder="Choose an SSH host"
        />
      </>
    )
    expect(nodeCount()).toBeLessThan(50)
    fireEvent.click(screen.getByRole('combobox', { name: 'SSH host' }))
    const search = await screen.findByRole('combobox', { name: 'Search hosts…' })
    expect(nodeCount()).toBeLessThan(NODE_BUDGET)
    fireEvent.change(search, { target: { value: lastName } })
    fireEvent.click(screen.getByRole('option', { name: lastName }))
    expect(onChange).toHaveBeenCalledWith(`ssh-${HOST_COUNT - 1}`)
  })

  it('skill install machine picker', async () => {
    render(
      <SkillInstallMachineSelect
        value="local"
        onChange={vi.fn()}
        localLabel="This computer"
        sshLabel="SSH"
        disconnectedLabel="disconnected"
        environments={[]}
        sshTargets={names.map((name, i) => ({ id: `ssh-${i}`, label: name, connected: false }))}
      />
    )
    expect(nodeCount()).toBeLessThan(50)
    fireEvent.click(screen.getByRole('combobox'))
    await screen.findByRole('combobox', { name: 'Search hosts…' })
    expect(nodeCount()).toBeLessThan(NODE_BUDGET)
  })

  it('Add Project remote step lists a server’s SSH hosts bounded, with the selection kept', () => {
    render(
      <Dialog open>
        <DialogContent>
          <RemoteStep
            sshTargets={names.map(sshTarget)}
            selectedTargetId={`ssh-${HOST_COUNT - 1}`}
            remotePath=""
            remoteError={null}
            isAddingRemote={false}
            onSelectTarget={vi.fn()}
            onRemotePathChange={vi.fn()}
            onAdd={vi.fn()}
            onConnectTarget={vi.fn(async () => undefined)}
            server={{ environmentId: 'env-1', label: 'build-box', onTargetsChanged: vi.fn() }}
          />
        </DialogContent>
      </Dialog>
    )
    expect(nodeCount()).toBeLessThan(NODE_BUDGET)
    expect(screen.getAllByText(lastName).length).toBeGreaterThan(0)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search hosts…' }), {
      target: { value: 'node-00042' }
    })
    expect(screen.getByText('node-00042')).toBeTruthy()
  })

  it('Add Project host selector', () => {
    const hosts: SidebarHostOption[] = names.map((name, i) => ({
      id: `ssh:ssh-${i}`,
      label: name,
      detail: '',
      kind: 'ssh',
      health: 'disconnected',
      presence: 'configured'
    }))
    render(
      <AddRepoHostSelector
        hosts={hosts}
        selectedHostId={hosts[0]!.id}
        open
        onOpenChange={vi.fn()}
        onSelectHost={vi.fn()}
      />
    )
    expect(nodeCount()).toBeLessThan(NODE_BUDGET)
    const list = screen.getByRole('listbox')
    expect(within(list).getAllByRole('option').length).toBeLessThanOrEqual(HOST_LIST_ROW_LIMIT + 1)
  })

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

  it('composer run-target rows bound hosts that still need setup', () => {
    const hostOptions = names.map((name, i): ProjectHostSetupOption => ({
      kind: 'needs-setup',
      id: `setup-${i}`,
      projectId: 'project-1',
      hostId: `ssh:ssh-${i}`,
      label: name,
      detail: 'Connect to set up',
      isAvailable: false,
      attention: false,
      canSetLocation: false
    }))
    const all = buildRunTargetRows({ hostOptions, recipes: [], query: '', hasAddHost: false })
    expect(all.rows.length).toBe(HOST_LIST_ROW_LIMIT)
    expect(all.hiddenHostCount).toBe(HOST_COUNT - HOST_LIST_ROW_LIMIT)
    const exact = buildRunTargetRows({
      hostOptions,
      recipes: [],
      query: lastName,
      hasAddHost: false
    })
    expect(exact.rows[0]?.kind === 'needs-setup' && exact.rows[0].option.label).toBe(lastName)
  })
})
