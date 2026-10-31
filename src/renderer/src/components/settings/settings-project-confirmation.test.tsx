// @vitest-environment happy-dom
import type { Repo } from '../../../../shared/repo-types'
import {
  RepositoryRemoveProjectButton,
  useSettingsProjectRemovalDescription
} from './repository/RepositoryRemoveProjectButton'
import * as removalLookup from '../../../../shared/project-section-reveal'
import { createRoot } from 'react-dom/client'
import { act, useRef } from 'react'
import { render, cleanup, screen, renderHook } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'

import { TooltipProvider } from '../ui/tooltip'
import { buildSettingsProjectList } from './settings-project-list'
import { useConcreteProjectContinuity } from './settings-view-model'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('bounds the mounted current-selection regroup operation with independent entry and setup populations', () => {
  for (const dimension of ['entries', 'setups'] as const) {
    for (const n of [100, 1000]) {
      const repos = Array.from({ length: 1000 }, (_, i) => ({
        id: `settings-${i}`,
        path: `/settings/${i}`,
        displayName: `Settings ${i}`,
        badgeColor: '',
        addedAt: 0
      }))
      const projection = projectHostSetupProjectionFromRepos(repos)
      const count = dimension === 'entries' ? n : 1000
      const setupCount = dimension === 'setups' ? n : 1000
      const setups = projection.setups
        .slice(0, setupCount)
        .map((setup, i) => ({ ...setup, projectId: projection.projects[i % count].id }))
      let entries = buildSettingsProjectList(repos, {
        projects: projection.projects.slice(0, count),
        projectHostSetups: setups
      })
      let activeSectionId = `repo-${entries[0].selectionKey}`
      const hosts = {}
      const choices = {}
      const setActiveSectionId = (id: string) => {
        activeSectionId = id
      }
      const nothing = () => {}
      const container = document.createElement('div')
      const root = createRoot(container)
      let actual = ''
      function Harness() {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exact fields read by continuity are supplied.
        const input = {
          settingsProjectList: entries,
          activeSectionId,
          setActiveSectionId,
          settingsProjectHostSelection: hosts,
          settingsProjectSetupSelection: choices,
          setSettingsProjectHostSelection: nothing,
          settingsNavigationTarget: null
        } as unknown as SettingsStoreModel
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: continuity reads only the pending navigation ref.
        const interactions = {
          pendingNavSectionRef: useRef(null)
        } as unknown as SettingsInteractionController
        actual = useConcreteProjectContinuity(input, interactions).activeSectionId
        return null
      }
      const get = Map.prototype.get
      let reads = 0
      try {
        act(() => root.render(<Harness />))
        const probe = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
          this: Map<unknown, unknown>,
          key: unknown
        ) {
          reads++
          return get.call(this, key)
        })
        try {
          entries = buildSettingsProjectList(repos, {
            projects: projection.projects.slice(0, count),
            projectHostSetups: setups,
            settings: { projectGroupingMode: 'folder' }
          })
          act(() => root.render(<Harness />))
          expect(actual).toBe(
            `repo-${entries.find((entry) => entry.setups.some((setup) => setup.repoId === repos[0].id))!.selectionKey}`
          )
          expect(reads).toBeGreaterThan(setupCount)
          expect(reads).toBeLessThan(60 * (count + setupCount))
          process.stdout.write(
            `PG8 settings operations ${JSON.stringify({ dimension, n, entries: entries.length, setups: setupCount, reads })}\n`
          )
        } finally {
          probe.mockRestore()
        }
      } finally {
        act(() => root.unmount())
      }
    }
  }
})

it('keeps the current two-click confirmation on equal publications and disarms on exact member or terminal consequences', async () => {
  const alpha: Repo = {
    id: 'alpha',
    path: '/alpha',
    displayName: 'Harbor',
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'harbor' }
  }
  const beta = { ...alpha, id: 'beta', path: '/beta' }
  const projection = projectHostSetupProjectionFromRepos([alpha, beta])
  useAppStore.setState({ repos: [alpha, beta], settings: getDefaultSettings('/tmp') })
  let committed = 0
  let current = { description: '', signature: '' }
  const remove = vi.fn()
  function Confirmation() {
    current = useSettingsProjectRemovalDescription(alpha, 'project', 'group', projection.setups)
    committed++
    return (
      <TooltipProvider>
        <RepositoryRemoveProjectButton
          repo={alpha}
          description={current.description}
          confirmationKey={current.signature}
          forceVisible
          removeProject={remove}
        />
      </TooltipProvider>
    )
  }
  render(<Confirmation />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Remove Project' }))
  const before = committed
  const originalLookup = removalLookup.getProjectSectionRepoLookup
  let evaluations = 0
  const probe = vi
    .spyOn(removalLookup, 'getProjectSectionRepoLookup')
    .mockImplementation((repos) => {
      evaluations++
      return originalLookup(repos)
    })
  try {
    for (const [label, patch] of [
      [
        'font',
        { settings: { ...useAppStore.getState().settings!, terminalFontFamily: 'elsewhere' } }
      ],
      ['other-host', { sshTargetLabels: new Map([['unrelated', 'Elsewhere']]) }],
      ['equal', { repos: [{ ...alpha }, { ...beta, addedAt: 10 }] }]
    ] as const) {
      const prior = evaluations
      act(() => useAppStore.setState(patch))
      expect(committed).toBe(before)
      expect(screen.getByRole('button', { name: 'Confirm Remove Project' })).toBeTruthy()
      expect(evaluations).toBeGreaterThan(prior)
      process.stdout.write(
        `Q3708 confirmation notification ${JSON.stringify({ label, commits: committed - before, evaluations: evaluations - prior })}\n`
      )
    }
    act(() => useAppStore.setState({ repos: [alpha] }))
    expect(screen.queryByRole('button', { name: 'Confirm Remove Project' })).toBeNull()
    expect(remove).not.toHaveBeenCalled()
    act(() => useAppStore.setState({ repos: [alpha, beta] }))
    await user.click(screen.getByRole('button', { name: 'Remove Project' }))
    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          beta: [
            {
              id: 'beta-main',
              repoId: 'beta',
              path: '/beta',
              displayName: 'beta',
              branch: 'main',
              head: '',
              isBare: false,
              isMainWorktree: true,
              linkedIssue: null,
              linkedPR: null,
              linkedLinearIssue: null,
              comment: '',
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 0,
              lastActivityAt: 0
            }
          ]
        },
        tabsByWorktree: {
          'beta-main': [
            {
              id: 'beta-terminal',
              title: 'Terminal',
              ptyId: 'test-pty',
              worktreeId: 'beta-main',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        },
        ptyIdsByTabId: { 'beta-terminal': ['test-pty'] }
      })
    )
    expect(screen.queryByRole('button', { name: 'Confirm Remove Project' })).toBeNull()
    expect(current.description).toContain('1 open terminal in this project will be closed.')
    await user.click(screen.getByRole('button', { name: 'Remove Project' }))
    await user.click(screen.getByRole('button', { name: 'Confirm Remove Project' }))
    expect(remove).toHaveBeenCalledExactlyOnceWith(alpha.id)
  } finally {
    probe.mockRestore()
  }
})

it.each([100, 1000])(
  'measures the actual Settings consequence selector at %s members with independent unrelated Repo growth',
  (n) => {
    for (const unrelated of [0, 1000]) {
      let reads = 0
      const repos = Array.from({ length: n + unrelated }, (_, i): Repo => ({
        get id() {
          reads++
          return `consequence-${i}`
        },
        path: `/repo-${i}`,
        displayName: 'Harbor',
        badgeColor: '',
        addedAt: 0
      }))
      const setups = projectHostSetupProjectionFromRepos(repos.slice(0, n)).setups
      useAppStore.setState({ repos })
      reads = 0
      const result = renderHook(() =>
        useSettingsProjectRemovalDescription(repos[0], 'project', 'scope', setups)
      )
      expect(result.result.current.description).toContain('all configured hosts')
      expect(reads).toBeGreaterThanOrEqual(n + unrelated)
      expect(reads).toBeLessThan(10 * (n + unrelated))
      process.stdout.write(
        `Q3708 confirmation selector ${JSON.stringify({ n, unrelated, repoIdentityReads: reads, members: setups.length })}\n`
      )
      result.unmount()
    }
  }
)

it('discloses a nonrepresentative recipe checkout and ordinary SSH files in the same current removal description', () => {
  const alpha: Repo = {
    id: 'alpha',
    path: '/alpha',
    displayName: 'Harbor',
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'harbor' }
  }
  const vm: Repo = { ...alpha, id: 'vm', path: '/vm', executionHostId: 'runtime:vm' }
  const ssh: Repo = { ...alpha, id: 'ssh', path: '/ssh', connectionId: 'box' }
  const secondSsh: Repo = {
    ...alpha,
    id: 'second-ssh',
    path: '/second-ssh',
    connectionId: 'second-box'
  }
  const projection = projectHostSetupProjectionFromRepos([alpha, vm, ssh, secondSsh])
  useAppStore.setState({
    repos: [alpha, vm, ssh, secondSsh],
    settings: getDefaultSettings('/tmp'),
    sshTargetLabels: new Map([
      ['box', 'Build Box'],
      ['second-box', 'Second Box']
    ]),
    worktreesByRepo: {
      vm: [
        {
          id: 'vm-main',
          repoId: 'vm',
          hostId: 'runtime:vm',
          path: '/vm',
          displayName: 'VM',
          branch: 'main',
          head: '',
          isBare: false,
          isMainWorktree: true,
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          ephemeralVmCheckoutMode: 'provisioned-root'
        }
      ]
    }
  })
  const result = renderHook(
    ({ setups }) => useSettingsProjectRemovalDescription(alpha, 'project', 'group', setups),
    { initialProps: { setups: projection.setups } }
  )
  expect(result.result.current.description).toContain('all configured hosts')
  expect(result.result.current.description).toContain('Its files stay on Build Box')
  expect(result.result.current.description).toContain(
    'VM recipe determines whether the environment and its files are permanently deleted'
  )
  expect(result.result.current.description).not.toContain('It is still on your disk')
  expect(result.result.current.description).toContain('Its files stay on Second Box')
  const beforeReorder = result.result.current
  result.rerender({ setups: projection.setups.toReversed() })
  expect(result.result.current).toEqual(beforeReorder)
})
