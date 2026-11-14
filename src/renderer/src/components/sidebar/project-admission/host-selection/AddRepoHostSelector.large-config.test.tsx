// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildSidebarHostOptions,
  type SidebarHostOption
} from '../../worktree-list/controls/sidebar-host-options'

import { AddRepoHostSelector } from './AddRepoHostSelector'
import { TranslationScopeContext, type Translate } from '@/i18n/use-translate'

// Why 13,692: the host count from the generated ~/.ssh/config in the renderer crash this guards.
const HOST_COUNT = 13_692
const t: Translate = (key, fallback) =>
  key === 'auto.components.sidebar.hostSection.localMac' ? 'translated-host' : fallback
const scope = { t, intlLocale: 'en' }

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
  it('finds a host by its displayed translated label as well as its raw label', () => {
    const hosts: SidebarHostOption[] = Array.from({ length: 51 }, (_, i) => ({
      id: i === 50 ? 'local' : `runtime:server-${i}`,
      label: i === 50 ? 'Local Mac' : `node-${i}`,
      isDefaultLocalLabel: i === 50,
      detail: '',
      kind: i === 50 ? 'local' : 'runtime',
      health: i === 50 ? 'local' : 'available',
      presence: i === 50 ? 'local' : 'configured'
    }))
    const onSelectHost = vi.fn()
    render(
      <TranslationScopeContext.Provider value={scope}>
        <AddRepoHostSelector
          hosts={hosts}
          selectedHostId={hosts[0]!.id}
          open
          onOpenChange={vi.fn()}
          onSelectHost={onSelectHost}
        />
      </TranslationScopeContext.Provider>
    )
    const search = screen.getByRole('combobox', { name: 'Search hosts…' })
    fireEvent.change(search, { target: { value: 'translated-host' } })
    expect(screen.getByText('translated-host')).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelectHost).toHaveBeenCalledWith('local')
    onSelectHost.mockClear()
    fireEvent.change(search, { target: { value: 'Local Mac' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelectHost).toHaveBeenCalledWith('local')
  })
  it('preserves a configured host name that matches a generated label', () => {
    const hosts: SidebarHostOption[] = [
      {
        id: 'local',
        label: 'Local Mac',
        isDefaultLocalLabel: true,
        detail: '',
        kind: 'local',
        health: 'local',
        presence: 'local'
      },
      {
        id: 'runtime:custom',
        label: 'Local Mac',
        detail: '',
        kind: 'runtime',
        health: 'available',
        presence: 'configured'
      }
    ]
    render(
      <TranslationScopeContext.Provider value={scope}>
        <AddRepoHostSelector
          hosts={hosts}
          selectedHostId="runtime:custom"
          open
          onOpenChange={vi.fn()}
          onSelectHost={vi.fn()}
        />
      </TranslationScopeContext.Provider>
    )
    expect(screen.getAllByText('Local Mac').length).toBeGreaterThan(0)
    expect(screen.getByText('translated-host')).toBeTruthy()
  })

  it('treats a local display-label override as a configured name', () => {
    const hosts = buildSidebarHostOptions({
      repos: [],
      sshTargetLabels: new Map(),
      settings: null,
      hostLabelOverrides: new Map([['local', 'Local Mac']])
    })
    expect(hosts.find((host) => host.id === 'local')?.isDefaultLocalLabel).toBe(false)
  })
})
