// @vitest-environment happy-dom
import type { Repo } from '../../../../shared/repo-types'
import { nestedRemovalCatalog } from './settings-project-continuity-test-fixtures'
import * as removalProduct from './repository/RepositoryRemoveProjectButton'
import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../../shared/endpoint-catalog-adoption'
import { makeWorktree, makeOpenFile, makeTab } from '@/store/slices/store-test-helpers'
import { useSettingsProjectRemovalDescription } from './repository/RepositoryRemoveProjectButton'
import { act, useLayoutEffect } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { getProjectGroupingModelFromState } from '@/store/project-host-setup-selector'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'

import {
  buildSettingsProjectList,
  removeSettingsProjectFromAllHosts
} from './settings-project-list'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each([100, 1000])(
  'measures populated current Settings address preparation at N=%s with independent q/W/D/T/U',
  async (n) => {
    for (const q of [1, 2, n]) {
      for (const dimension of ['base', 'W', 'D', 'T', 'U'] as const) {
        const w = dimension === 'W' ? 1000 : 10
        const d = dimension === 'D' ? 1000 : 10
        const t = dimension === 'T' ? 1000 : 10
        const u = dimension === 'U' ? 1000 : 10
        const counts = {
          repoIds: 0,
          repoFields: 0,
          setupIds: 0,
          listedBuckets: 0,
          listedRows: 0,
          detectedBuckets: 0,
          detectedRows: 0,
          terminals: 0,
          files: 0
        }
        const canonical = Array.from({ length: n }, (_, i): Repo => ({
          id: 'r',
          path: `/srv/${i}`,
          displayName: `Harbor ${i}`,
          badgeColor: '',
          addedAt: 0,
          executionHostId: `ssh:physical-${i}`,
          connectionId: `physical-${i}`,
          upstream: { owner: 'org', repo: 'harbor' }
        }))
        const projection = projectHostSetupProjectionFromRepos(canonical)
        const repos = canonical.map((repo, i) =>
          adoptEndpointRepo({ kind: 'environment', environmentId: `E${i % q}` }, repo)
        )
        const setups = projection.setups.map(
          (setup, i) =>
            adoptEndpointProjectCatalog(
              { kind: 'environment', environmentId: `E${i % q}` },
              projection.projects,
              [setup]
            ).setups[0]
        )
        for (let i = 0; i < u; i++) {
          repos.push({
            id: `unrelated-${i}`,
            path: `/unrelated/${i}`,
            displayName: 'Elsewhere',
            badgeColor: '',
            addedAt: 0,
            executionHostId: `runtime:U${i}`
          })
        }
        const observeRepo = (repo: Repo): Repo => {
          for (const key of Object.keys(repo)) {
            const descriptor = Object.getOwnPropertyDescriptor(repo, key)
            if (!descriptor || !('value' in descriptor)) {
              continue
            }
            const value: unknown = descriptor.value
            Object.defineProperty(repo, key, {
              enumerable: descriptor.enumerable,
              configurable: true,
              get() {
                counts.repoFields++
                if (key === 'id') {
                  counts.repoIds++
                }
                return value
              }
            })
          }
          return repo
        }
        repos.forEach(observeRepo)
        for (const setup of setups) {
          const id = setup.repoId
          Object.defineProperty(setup, 'repoId', {
            enumerable: true,
            get() {
              counts.setupIds++
              return id
            }
          })
        }
        const rows = (count: number, detected: boolean) =>
          Array.from({ length: count }, (_, i) => {
            const hostId = `ssh:physical-${i % n}` as const
            const row = makeWorktree({
              id: `r::/${detected ? 'detected' : 'listed'}/${i}`,
              repoId: 'r',
              hostId,
              runtimeOwnerEnvironmentId: `E${i % q}`,
              ephemeralVmCheckoutMode: i === 0 ? 'provisioned-root' : undefined
            })
            Object.defineProperty(row, 'hostId', {
              enumerable: true,
              get() {
                if (detected) {
                  counts.detectedRows++
                } else {
                  counts.listedRows++
                }
                return hostId
              }
            })
            return row
          })
        const listed = rows(w, false)
        const detected = rows(d, true).map((row) => ({
          ...row,
          ownership: 'orca-managed' as const,
          visible: true,
          selectedCheckout: false
        }))
        // Keep the live getter on detected ingress, too: spreading a row snapshots its value.
        for (const row of detected) {
          const hostId = row.hostId
          Object.defineProperty(row, 'hostId', {
            enumerable: true,
            get() {
              counts.detectedRows++
              return hostId
            }
          })
        }
        const tabs = Array.from({ length: t }, (_, i) =>
          makeTab({ id: `terminal-${i}`, worktreeId: listed[0].id })
        )
        for (const tab of tabs) {
          const id = tab.id
          Object.defineProperty(tab, 'id', {
            enumerable: true,
            get() {
              counts.terminals++
              return id
            }
          })
        }
        const files = Array.from({ length: t }, (_, i) =>
          makeOpenFile({
            id: `file-${i}`,
            worktreeId: listed[0].id,
            runtimeEnvironmentId: 'E0',
            isDirty: i === 0
          })
        )
        for (const file of files) {
          const id = file.worktreeId
          Object.defineProperty(file, 'worktreeId', {
            enumerable: true,
            get() {
              counts.files++
              return id
            }
          })
        }
        useAppStore.setState({
          repos,
          projects: projection.projects,
          projectHostSetups: setups,
          settings: getDefaultSettings('/tmp'),
          worktreesByRepo: {
            get r() {
              counts.listedBuckets++
              return listed
            }
          },
          detectedWorktreesByRepo: {
            get r() {
              counts.detectedBuckets++
              return {
                repoId: 'r',
                authoritative: true,
                source: 'git' as const,
                worktrees: detected
              }
            }
          },
          tabsByWorktree: { [listed[0].id]: tabs },
          ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, ['live-pty']])),
          openFiles: files
        })
        const entry = buildSettingsProjectList(
          repos,
          getProjectGroupingModelFromState(useAppStore.getState())
        ).find((entry) => entry.project.providerIdentity?.repo === 'harbor')!
        const sourceSnapshot = { ...counts }
        Object.assign(counts, {
          repoIds: 0,
          repoFields: 0,
          setupIds: 0,
          listedBuckets: 0,
          listedRows: 0,
          detectedBuckets: 0,
          detectedRows: 0,
          terminals: 0,
          files: 0
        })
        let commits = 0
        const result = renderHook(
          ({ context, setups }) => {
            const value = useSettingsProjectRemovalDescription(
              context,
              'project',
              entry.selectionKey,
              setups
            )
            useLayoutEffect(() => {
              commits++
            })
            return value
          },
          { initialProps: { context: repos[0], setups: entry.setups } }
        )
        const initial = { ...counts }
        const named = [
          ...result.result.current.description.matchAll(/E\d+ · physical-\d+: \/srv\/\d+(?= |$)/g)
        ].map((match) => match[0])
        expect(named).toEqual(
          Array.from({ length: n }, (_, i) => `E${i % q} · physical-${i}: /srv/${i}`).sort()
        )
        expect(result.result.current.description).toContain(`Harbor 0`)
        expect(result.result.current.description).toContain(`/srv/${n - 1}`)
        expect(result.result.current.description).not.toContain('/unrelated/')
        expect(result.result.current.description).toContain(`${t} open terminals`)
        expect(initial.listedRows).toBeGreaterThanOrEqual(w)
        expect(initial.listedRows).toBeLessThan(12 * w)
        expect(initial.detectedRows).toBeGreaterThanOrEqual(d)
        expect(initial.detectedRows).toBeLessThan(12 * d)
        expect(initial.listedBuckets).toBeLessThan(5)
        expect(initial.detectedBuckets).toBeLessThan(5)
        Object.assign(counts, {
          repoIds: 0,
          repoFields: 0,
          setupIds: 0,
          listedBuckets: 0,
          listedRows: 0,
          detectedBuckets: 0,
          detectedRows: 0,
          terminals: 0,
          files: 0
        })
        const beforeCommit = commits
        act(() =>
          useAppStore.setState({
            activeRepoId: 'unrelated',
            settings: { ...useAppStore.getState().settings!, terminalFontFamily: 'irrelevant' }
          })
        )
        expect(commits).toBe(beforeCommit)
        expect(counts.setupIds + counts.repoIds).toBe(0)
        expect(counts.listedBuckets + counts.detectedBuckets + counts.terminals).toBe(0)
        // Settings is an editor-route input: its existing identity reconciliation still resolves T views.
        expect(counts.listedRows + counts.detectedRows).toBeLessThanOrEqual(6 * (w + d + t))
        const unrelated = { ...counts }
        Object.assign(counts, {
          repoIds: 0,
          repoFields: 0,
          setupIds: 0,
          listedBuckets: 0,
          listedRows: 0,
          detectedBuckets: 0,
          detectedRows: 0,
          terminals: 0,
          files: 0
        })
        const equalRepos = useAppStore
          .getState()
          .repos.map((repo) => observeRepo({ ...repo, projectGroupOrder: 99, addedAt: 10 }))
        const equalFixture = { ...counts }
        Object.assign(counts, Object.fromEntries(Object.keys(counts).map((key) => [key, 0])))
        act(() => useAppStore.setState({ repos: equalRepos }))
        expect(commits).toBe(beforeCommit)
        result.rerender({ context: equalRepos[0], setups: [...entry.setups] })
        expect(commits).toBe(beforeCommit + 1)
        expect(counts.listedBuckets + counts.detectedBuckets + counts.terminals).toBe(0)
        const equal = { ...counts, storeCommits: 0, forcedParentCommits: commits - beforeCommit }
        const beforeRelevant = commits
        Object.assign(counts, {
          repoIds: 0,
          repoFields: 0,
          setupIds: 0,
          listedBuckets: 0,
          listedRows: 0,
          detectedBuckets: 0,
          detectedRows: 0,
          terminals: 0,
          files: 0
        })
        const materialRepos = equalRepos.map((repo, i) =>
          i === n - 1 ? observeRepo({ ...repo, path: '/changed-current-member' }) : repo
        )
        const materialFixture = { ...counts }
        Object.assign(counts, Object.fromEntries(Object.keys(counts).map((key) => [key, 0])))
        act(() => useAppStore.setState({ repos: materialRepos }))
        expect(commits).toBeGreaterThan(beforeRelevant)
        expect(result.result.current.description).toContain('/changed-current-member')
        expect(counts.listedBuckets).toBe(1)
        expect(counts.detectedBuckets).toBe(1)
        const relevant = { ...counts }
        Object.assign(counts, {
          repoIds: 0,
          repoFields: 0,
          setupIds: 0,
          listedBuckets: 0,
          listedRows: 0,
          detectedBuckets: 0,
          detectedRows: 0,
          terminals: 0,
          files: 0
        })
        const accepted = removalProduct.prepareSettingsProjectRemoval(
          useAppStore.getState(),
          repos[0],
          'project',
          entry.selectionKey,
          entry.setups
        )
        expect(accepted.addresses).toHaveLength(q)
        expect(accepted.targets).toHaveLength(w + d)
        expect(accepted.closedFileIds.size).toBe(t)
        const actualCalls: string[] = []
        await removeSettingsProjectFromAllHosts(accepted.addresses, async (raw, options) => {
          actualCalls.push(`${options.hostId}\0${raw}`)
        })
        expect(actualCalls).toEqual(Array.from({ length: q }, (_, i) => `runtime:E${i}\0r`))
        const acceptance = { ...counts }
        expect(equal.repoIds).toBeGreaterThan(0)
        expect(equal.repoFields).toBeGreaterThan(equal.repoIds)
        expect(relevant.repoIds).toBeGreaterThan(0)
        expect(relevant.repoFields).toBeGreaterThan(relevant.repoIds)
        expect(acceptance.repoIds).toBeGreaterThan(0)
        expect(acceptance.repoFields).toBeGreaterThan(acceptance.repoIds)
        process.stdout.write(
          `R address preparation ${JSON.stringify({ n, q, w, d, t, u, dimension, sourceSnapshot, initial, unrelated, equalFixture, equal, materialFixture, relevant, acceptance, dispatches: actualCalls.length, named: named.length, targets: accepted.targets.length, closedFiles: accepted.closedFileIds.size })}\n`
        )
        result.unmount()
      }
    }
  }
)

it.each([100, 1000])(
  'measures same-raw bucket visits through the real current removal selector at N=%s',
  (n) => {
    let visits = 0
    const canonical = Array.from({ length: n }, (_, i): Repo => ({
      id: 'r',
      path: `/srv/${i}`,
      displayName: 'Harbor',
      badgeColor: '',
      addedAt: 0,
      upstream: { owner: 'org', repo: 'harbor' }
    }))
    const projection = projectHostSetupProjectionFromRepos(canonical)
    const repos = canonical.map((repo, i) =>
      adoptEndpointRepo({ kind: 'environment', environmentId: `E${i}` }, repo)
    )
    const setups = projection.setups.map(
      (setup, i) =>
        adoptEndpointProjectCatalog(
          { kind: 'environment', environmentId: `E${i}` },
          projection.projects,
          [setup]
        ).setups[0]
    )
    const rows = Array.from({ length: 3 * n }, (_, i) => {
      const hostId = `runtime:E${i % n}` as const
      const row = makeWorktree({ id: `r::/work/${i}`, repoId: 'r', hostId })
      Object.defineProperty(row, 'hostId', {
        enumerable: true,
        get() {
          visits++
          return hostId
        }
      })
      return row
    })
    useAppStore.setState({
      repos,
      projects: projection.projects,
      projectHostSetups: setups,
      settings: getDefaultSettings('/tmp'),
      worktreesByRepo: { r: rows }
    })
    visits = 0
    const result = renderHook(() =>
      useSettingsProjectRemovalDescription(repos[0], 'project', 'benchmark', setups)
    )
    const initial = visits
    expect(result.result.current.description).toContain('all configured hosts')
    process.stdout.write(
      `R repeated raw bucket ${JSON.stringify({ n, q: n, w: rows.length, initialHostReads: initial })}\n`
    )
    expect(initial).toBeGreaterThanOrEqual(rows.length)
    expect(initial).toBeLessThan(12 * rows.length)
    result.unmount()
  }
)

it.each(['no-twin', 'distinct-id', 'saved-alias'] as const)(
  'keeps current authored %s removal membership and address order without path-based expansion',
  async (kind) => {
    const { repos, x } = nestedRemovalCatalog('host', (canonical) => {
      if (kind === 'no-twin') {
        canonical.splice(1, 1)
      }
      if (kind === 'distinct-id') {
        canonical[1] = { ...canonical[1], id: 'separate-y' }
      }
      if (kind === 'saved-alias') {
        canonical.push({ ...canonical[0], id: 'saved-alias', displayName: 'Saved alias' })
      }
    })
    const product = removalProduct.prepareSettingsProjectRemoval(
      useAppStore.getState(),
      repos[0],
      'host:runtime:E',
      x.selectionKey,
      x.setups
    )
    expect(product.description).toContain('Build X: /srv/r')
    expect(product.description.includes('Build Y: /srv/r')).toBe(kind === 'saved-alias')
    expect(product.description).not.toContain('/srv/q')
    expect(product.addresses.map((setup) => setup.repoId)).toEqual(
      kind === 'saved-alias' ? ['r', 'saved-alias'] : ['r']
    )
    const calls: string[] = []
    await removeSettingsProjectFromAllHosts(product.addresses, async (raw) => {
      calls.push(raw)
    })
    expect(calls).toEqual(kind === 'saved-alias' ? ['r', 'saved-alias'] : ['r'])
  }
)
