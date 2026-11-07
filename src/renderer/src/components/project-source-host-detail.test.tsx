// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { getRepoHostIdentity } from '../../../shared/repo-host-identity'
import type { Repo } from '../../../shared/repo-types'
import { TooltipProvider } from './ui/tooltip'
import TaskProjectSourceCombobox from './task-project-source-combobox'
import AutomationProjectCombobox from './automations/AutomationProjectCombobox'
import {
  getRepoSourceHostCount,
  getSelectedTaskProjectSource
} from './task-project-source-combobox-model'
import { getProjectDetail } from './task-project-source-combobox-labels'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})
it('renders two canonical hosts for three sources in Tasks and Automation while retaining all concrete choices', async () => {
  const first: Repo = {
    id: 'a',
    path: '/a',
    displayName: 'Harbor',
    badgeColor: '',
    addedAt: 0,
    gitRemoteIdentity: {
      canonicalKey: 'github.com/org/app',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/org/app'
    }
  }
  const sources = [
    first,
    { ...first, id: 'b', path: '/b' },
    { ...first, id: 'c', path: '/c', executionHostId: 'runtime:server' as const }
  ]
  const projection = projectHostSetupProjectionFromRepos(sources)
  useAppStore.setState({
    repos: sources,
    settings: getDefaultSettings('/tmp'),
    projects: projection.projects,
    projectHostSetups: projection.setups
  })
  const group = { projectKey: 'harbor', repo: first, sources }
  const selected = new Set([getRepoHostIdentity(sources[2])])
  expect(getRepoSourceHostCount(sources)).toBe(2)
  expect(getSelectedTaskProjectSource(group, selected)).toBe(sources[2])
  expect(getProjectDetail(group, selected, true, () => 'Same label')).toBe('Same label · 2 hosts')
  expect(
    getProjectDetail(
      { ...group, sources: sources.slice(0, 2) },
      new Set([first.id]),
      true,
      () => 'Same label'
    )
  ).toBe('Same label · /a')
  const onChange = vi.fn()
  const user = userEvent.setup()
  const tasks = render(
    <TooltipProvider>
      <TaskProjectSourceCombobox
        groups={[group]}
        selected={selected}
        onChange={onChange}
        onSelectAll={() => {}}
        getRepoHostLabel={() => 'Same label'}
      />
    </TooltipProvider>
  )
  await user.click(screen.getByRole('combobox'))
  expect(screen.getByText('Same label · 2 hosts')).toBeTruthy()
  await user.click(screen.getByTitle('Choose task source'))
  for (const source of sources) {
    expect(screen.getByText(source.path, { exact: false })).toBeTruthy()
  }
  tasks.unmount()
  render(
    <TooltipProvider>
      <AutomationProjectCombobox
        repos={sources}
        value={first.id}
        onValueChange={() => {}}
        getRepoHostLabel={() => 'Same label'}
        allowAddProject={false}
      />
    </TooltipProvider>
  )
  await user.click(screen.getByRole('combobox'))
  expect(screen.getByText('Same label · 2 hosts')).toBeTruthy()
  await user.click(screen.getByTitle('Choose automation host'))
  for (const source of sources) {
    expect(screen.getByText(source.path, { exact: false })).toBeTruthy()
  }
})

it('counts actual shown source-detail work at N/10N without discarding equal-label choices or changing unavailable selection', async () => {
  for (const n of [100, 1000]) {
    let hostReads = 0
    const sources = Array.from({ length: n }, (_, i) => ({
      id: `source-${i}`,
      path: `/source/${i}`,
      displayName: 'Harbor',
      badgeColor: '',
      addedAt: 0,
      get executionHostId() {
        hostReads++
        return i % 2 ? ('runtime:server' as const) : ('local' as const)
      }
    }))
    const selected = new Set([getRepoHostIdentity(sources[0])])
    hostReads = 0
    const group = { projectKey: 'harbor', repo: sources[0], sources }
    const change = vi.fn()
    const user = userEvent.setup()
    const mounted = render(
      <TooltipProvider>
        <TaskProjectSourceCombobox
          groups={[group]}
          selected={selected}
          onChange={change}
          onSelectAll={() => {}}
          getRepoHostLabel={() => 'Same label'}
          getRepoSourceStatus={(source) => ({
            label: source.id === 'source-0' ? 'Offline' : 'Ready',
            disabled: source.id === 'source-0'
          })}
        />
      </TooltipProvider>
    )
    try {
      await user.click(screen.getByRole('combobox'))
      expect(screen.getByText('Same label · 2 hosts')).toBeTruthy()
      await user.click(screen.getByTitle('Choose task source'))
      expect(screen.getAllByText(/^\/source\//)).toHaveLength(n)
      const unavailable = screen.getByText('/source/0', { exact: false }).closest('button')!
      expect(unavailable.disabled).toBe(true)
      expect(change).not.toHaveBeenCalled()
      expect(hostReads).toBeGreaterThanOrEqual(n)
      expect(hostReads).toBeLessThan(40 * n)
      process.stdout.write(
        `PG8 source-detail operations ${JSON.stringify({ n, hostReads, choices: n })}\n`
      )
    } finally {
      mounted.unmount()
    }
  }
})
