// @vitest-environment happy-dom
import { Profiler, useContext, type ComponentType } from 'react'
import {
  NativeChatMarkdownImageOwnerProvider,
  NativeChatMarkdownImageOwnerContext
} from './native-chat-markdown-image-owner'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  useAppStore,
  instrumentRepoFilter,
  incomingFilterWork,
  IncomingOwnerReadMeter,
  assertIncomingOwnerFilterBoundaries,
  restoreIncomingFilterArrays
} from './native-chat-owner-filter.test-fixture'
import type { AppState } from '@/store/types'
import { NativeChatTextAttachmentScope } from './NativeChatTextAttachments'
import {
  useNativeChatImageRuntimeContext,
  type NativeChatImageRuntimeContext
} from './native-chat-image-runtime-context'
import {
  detectedListingFixture,
  nativeChatFanoutFixture,
  agentSessionTabFixture,
  repoFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'
import * as runtimeContextHooks from './native-chat-image-runtime-context'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'

vi.mock('./NativeChatTextAttachmentPreview', () => ({
  NativeChatTextAttachmentPreview: () => null
}))
const ownerHook = vi.spyOn(runtimeContextHooks, 'useNativeChatImageRuntimeContext')
const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  restoreIncomingFilterArrays()
})

function ssh(
  generation: number
): AppState['sshStateByEnvironment'] extends Map<string, infer T> ? T : never {
  return {
    targetGenerations: new Map(),
    targetLabels: new Map(),
    removedTargetLabels: new Map(),
    targetsHydrated: true,
    connectionStates: new Map([
      [
        'ssh-1',
        {
          targetId: 'ssh-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: generation
        }
      ]
    ])
  }
}

function instrument<T extends { id: string }>(row: T, visit: () => void): T {
  const id = row.id
  Object.defineProperty(row, 'id', {
    enumerable: true,
    get() {
      visit()
      return id
    }
  })
  return row
}

function mountScopes(
  count: number,
  mode: 'scope-only' | 'with-probe' | 'disabled',
  commit: () => void,
  Probe: ComponentType<{ index: number }>
) {
  return render(
    Array.from({ length: count }, (_, index) => (
      <Profiler key={index} id={String(index)} onRender={commit}>
        <NativeChatMarkdownImageOwnerProvider tabId={`chat-${index}`} sessionId={null} isVisible>
          <NativeChatTextAttachmentScope enabled={mode !== 'disabled'}>
            {mode === 'with-probe' ? <Probe index={index} /> : <span />}
          </NativeChatTextAttachmentScope>
        </NativeChatMarkdownImageOwnerProvider>
      </Profiler>
    ))
  )
}

for (const mode of ['scope-only', 'with-probe', 'disabled'] as const) {
  it(`bounds actual SSH and floating catalog work separately from renders (${mode})`, async () => {
    for (const floating of [false, true]) {
      for (const n of [10, 100]) {
        let visits = 0,
          commits = 0,
          renders = 0
        const ws = floating ? FLOATING_TERMINAL_WORKTREE_ID : 'wt-0'
        const tabs = Array.from({ length: n }, (_, i) =>
          instrument(
            agentSessionTabFixture(`chat-${i}`, ws, { entityId: `session-${i}` }),
            () => visits++
          )
        )
        const rows = Array.from({ length: n }, (_, i) =>
          instrument(
            worktreeFixture(`wt-${i}`, `/remote/${i}`, {
              hostId: 'ssh:ssh-1',
              runtimeOwnerEnvironmentId: 'owner-a'
            }),
            () => visits++
          )
        )
        const pins = Object.fromEntries(
          tabs.map((tab, i) => [
            `chat-${i}`,
            { sessionId: tab.entityId, launchDirectory: `/pinned/${i}` }
          ])
        )
        useAppStore.setState(
          {
            ...initial,
            settings: getDefaultSettings('/test-home'),
            repos: [repoFixture({ executionHostId: 'runtime:owner-a' })],
            worktreesByRepo: { repo: rows },
            detectedWorktreesByRepo: {},
            folderWorkspaces: [],
            projectGroups: [],
            runtimeEnvironments: [
              {
                id: 'owner-a',
                name: 'owner-a',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: null,
                runtimeId: null,
                preferredEndpointId: 'endpoint',
                endpoints: []
              }
            ],
            runtimeEnvironmentCatalogHydrated: true,
            removedRuntimeEnvironmentIds: new Set(),
            restoredRuntimeHostIdByWorkspaceSessionKey: {},
            tabsByWorktree: {},
            unifiedTabsByWorktree: { [ws]: tabs },
            structuredSessionLaunchDirectoryByTabId: pins,
            activeWorktreeId: floating ? null : ws,
            activeWorkspaceExecutionHostId: floating ? null : 'ssh:ssh-1',
            sshStateByEnvironment: new Map([['owner-a', ssh(3)]])
          },
          true
        )
        const contexts: NativeChatImageRuntimeContext[] = []
        function Probe({ index }: { index: number }) {
          contexts[index] = useContext(NativeChatMarkdownImageOwnerContext)!.runtimeContext
          renders++
          return null
        }
        visits = 0
        ownerHook.mockClear()
        const view = mountScopes(n, mode, () => commits++, Probe)
        await act(async () => {})
        // The preexisting provider owns all route hooks; enabled scopes add none.
        expect(ownerHook).toHaveBeenCalledTimes(n)
        // Shared immutable indexes plus addressed lookup, including cold catalogs, are additive.
        expect(visits).toBeLessThanOrEqual(12 * n)
        const baseline = contexts.map((context) => JSON.stringify(context))
        const metrics: { kind: string; visits: number; commits: number; renders: number }[] = []
        for (const kind of ['other-host', 'other-target', 'other-pin'] as const) {
          const state = useAppStore.getState()
          const patch =
            kind === 'other-host'
              ? {
                  sshStateByEnvironment: new Map([
                    ...state.sshStateByEnvironment,
                    ['other-host', ssh(8)]
                  ])
                }
              : kind === 'other-target'
                ? {
                    sshStateByEnvironment: new Map([
                      ...state.sshStateByEnvironment,
                      [
                        'owner-a',
                        {
                          ...ssh(3),
                          connectionStates: new Map([
                            ...ssh(3).connectionStates,
                            [
                              'other-target',
                              {
                                targetId: 'other-target',
                                status: 'connected' as const,
                                error: null,
                                reconnectAttempt: 0,
                                connectionGeneration: 8
                              }
                            ]
                          ])
                        }
                      ]
                    ])
                  }
                : {
                    structuredSessionLaunchDirectoryByTabId: {
                      ...pins,
                      unmounted: { sessionId: 'other', launchDirectory: '/other' }
                    }
                  }
          visits = 0
          commits = 0
          renders = 0
          await act(async () => useAppStore.setState(patch))
          expect(contexts.map((context) => JSON.stringify(context))).toEqual(baseline)
          expect(commits).toBe(0)
          expect(renders).toBe(0)
          expect(visits).toBe(0)
          metrics.push({ kind, visits, commits, renders })
        }
        visits = 0
        commits = 0
        renders = 0
        await act(async () =>
          useAppStore.setState(
            floating
              ? {
                  structuredSessionLaunchDirectoryByTabId: {
                    ...pins,
                    'chat-0': { sessionId: 'session-0', launchDirectory: '/changed' }
                  }
                }
              : { sshStateByEnvironment: new Map([['owner-a', ssh(4)]]) }
          )
        )
        expect(commits).toBe(floating ? 1 : n)
        expect(renders).toBe(mode === 'with-probe' ? (floating ? 1 : n) : 0)
        expect(visits).toBeLessThanOrEqual(4 * n)
        if (mode === 'with-probe') {
          expect(contexts[0]).toMatchObject(
            floating ? { worktreePath: '/changed' } : { expectedSshConnectionGeneration: 4 }
          )
          if (floating) {
            expect(contexts[1]?.worktreePath).toBe('/pinned/1')
          }
        }
        // Replaced catalogs may be scanned once, never once per mounted consumer.
        const replacement = floating
          ? { unifiedTabsByWorktree: { [ws]: [...tabs] } }
          : { worktreesByRepo: { repo: [...rows] } }
        visits = 0
        commits = 0
        renders = 0
        await act(async () => useAppStore.setState(replacement))
        // The store's existing catalog publisher also visits rows in the disabled control.
        expect(visits).toBeLessThanOrEqual(12 * n)
        expect(commits).toBe(0)
        expect(renders).toBe(0)
        console.info(
          'attachment-routing-work',
          JSON.stringify({ mode, floating, n, metrics, replacementVisits: visits })
        )
        view.unmount()
      }
    }
  })
}

it('shares cold all-rival transport aggregation without losing ambiguity or catalog precedence', async () => {
  for (const n of [10, 100]) {
    let visits = 0,
      provenanceReads = 0
    const rows = Array.from({ length: n }, () => {
      const row = instrument(
        worktreeFixture('wt-0', '/remote', {
          hostId: 'ssh:ssh-1',
          runtimeOwnerEnvironmentId: 'owner-a'
        }),
        () => visits++
      )
      Object.defineProperty(row, 'runtimeOwnerEnvironmentId', {
        enumerable: true,
        get() {
          provenanceReads++
          return 'owner-a'
        }
      })
      return row
    })
    useAppStore.setState(
      {
        ...initial,
        repos: [repoFixture()],
        worktreesByRepo: { repo: rows },
        detectedWorktreesByRepo: {},
        unifiedTabsByWorktree: {
          'wt-0': Array.from({ length: n }, (_, i) => agentSessionTabFixture(`chat-${i}`, 'wt-0'))
        },
        activeWorktreeId: 'wt-0',
        activeWorkspaceExecutionHostId: 'ssh:ssh-1',
        sshStateByEnvironment: new Map([['owner-a', ssh(3)]])
      },
      true
    )
    const contexts: NativeChatImageRuntimeContext[] = []
    function Probe({ index }: { index: number }) {
      contexts[index] = useNativeChatImageRuntimeContext(`chat-${index}`)
      return null
    }
    const view = render(
      Array.from({ length: n }, (_, index) => <Probe key={index} index={index} />)
    )
    await act(async () => {})
    expect(
      contexts.every(
        (context) =>
          context?.target.kind === 'environment' && context.target.environmentId === 'owner-a'
      )
    ).toBe(true)
    expect(visits).toBeLessThanOrEqual(8 * n)
    expect(provenanceReads).toBeLessThanOrEqual(20 * n)
    await act(async () =>
      useAppStore.setState({
        worktreesByRepo: {
          repo: [
            ...rows,
            worktreeFixture('wt-0', '/rival', {
              hostId: 'ssh:ssh-1',
              runtimeOwnerEnvironmentId: 'owner-b'
            })
          ]
        }
      })
    )
    expect(contexts.every((context) => context === null)).toBe(true)
    // Removing the rival and replacing the first directory row restores the original owner.
    await act(async () =>
      useAppStore.setState({
        worktreesByRepo: {
          repo: [
            worktreeFixture('wt-0', '/first', {
              hostId: 'ssh:ssh-1',
              runtimeOwnerEnvironmentId: 'owner-a'
            }),
            ...rows
          ]
        }
      })
    )
    expect(contexts.every((context) => context?.worktreePath === '/first')).toBe(true)
    // Detected rivals still participate even with a known row and active physical host.
    await act(async () =>
      useAppStore.setState({
        detectedWorktreesByRepo: {
          rival: detectedListingFixture([
            worktreeFixture('wt-0', '/detected', {
              hostId: 'ssh:ssh-1',
              runtimeOwnerEnvironmentId: 'owner-b'
            })
          ])
        }
      })
    )
    expect(contexts.every((context) => context === null)).toBe(true)
    view.unmount()
  }
})

for (const mode of ['scope-only', 'with-probe', 'disabled'] as const) {
  it.each([
    'inactive-detected',
    'folder-twins',
    'folder-own',
    'detected-twins',
    'unstamped-project'
  ] as const)(
    `shares all directory and explicit-route derivation for %s (${mode})`,
    async (kind) => {
      for (const n of [10, 100]) {
        const reads = new IncomingOwnerReadMeter()
        let commits = 0,
          renders = 0
        const ambiguousFolder = kind === 'folder-twins'
        const folderCase = ambiguousFolder || kind === 'folder-own'
        const initialPath = ambiguousFolder ? null : '/own'
        const unstamped = kind === 'unstamped-project'
        const fixture = nativeChatFanoutFixture(n, 1, 0)
        const ws = folderCase ? 'folder:workspace-0' : 'wt-0'
        const known = worktreeFixture(
          ws,
          '/own',
          unstamped
            ? {}
            : {
                hostId: 'ssh:ssh-1',
                runtimeOwnerEnvironmentId: 'owner-a'
              }
        )
        const detected = Array.from({ length: n }, (_, index) =>
          reads.row(
            detectedListingFixture([
              worktreeFixture(
                ws,
                kind === 'detected-twins' && index < n - 1 ? '/other' : '/own',
                unstamped
                  ? {}
                  : kind === 'detected-twins' && index < n - 1
                    ? { hostId: `runtime:other-${index}` }
                    : { hostId: 'ssh:ssh-1', runtimeOwnerEnvironmentId: 'owner-a' }
              )
            ]).worktrees[0]!,
            'runtimeOwnerEnvironmentId',
            'nested'
          )
        )
        const folders = Array.from({ length: n }, (_, index) =>
          reads.row(
            {
              ...fixture.folderWorkspaces[0]!,
              id: kind === 'folder-own' && index < n - 1 ? `unrelated-${index}` : 'workspace-0',
              folderPath: index === n - 1 ? '/own' : '/other',
              executionHostId:
                index === n - 1 ? ('runtime:owner-a' as const) : (`runtime:other-${index}` as const)
            },
            'executionHostId'
          )
        )
        const repos = unstamped
          ? Array.from({ length: n }, (_, index) =>
              reads.row(
                repoFixture({
                  executionHostId: index % 2 ? 'runtime:owner-a' : 'local'
                }),
                'id',
                'repo'
              )
            )
          : [repoFixture({ executionHostId: 'runtime:owner-a' })]
        useAppStore.setState(
          {
            ...initial,
            ...fixture,
            repos: instrumentRepoFilter(repos),
            worktreesByRepo: folderCase || kind === 'detected-twins' ? {} : { repo: [known] },
            detectedWorktreesByRepo: folderCase
              ? {}
              : { repo: { ...detectedListingFixture([]), worktrees: detected } },
            folderWorkspaces: folderCase ? folders : [],
            unifiedTabsByWorktree: {
              [ws]: Array.from({ length: n }, (_, i) => agentSessionTabFixture(`chat-${i}`, ws))
            },
            activeWorktreeId: folderCase || kind === 'detected-twins' ? ws : 'different-workspace',
            activeWorkspaceExecutionHostId:
              folderCase || kind === 'detected-twins' ? 'runtime:owner-a' : 'local',
            sshStateByEnvironment: new Map([['owner-a', ssh(3)]])
          },
          true
        )
        const contexts: NativeChatImageRuntimeContext[] = []
        function Probe({ index }: { index: number }) {
          contexts[index] = useContext(NativeChatMarkdownImageOwnerContext)!.runtimeContext
          renders++
          return null
        }
        reads.reset()
        ownerHook.mockClear()
        const view = mountScopes(n, mode, () => commits++, Probe)
        await act(async () => {})
        expect(ownerHook).toHaveBeenCalledTimes(n)
        const bound = 20 * n
        expect(reads.rawOperations).toBe(
          reads.operations + reads.repoFilterExcluded + reads.nestedFilterExcluded
        )
        // Main memoizes repeated selector reads; each mounted owner filters this cold snapshot once.
        expect(reads.repoFilterExcluded).toBe(unstamped ? n * n : 0)
        expect(reads.nestedFilterExcluded).toBe(kind === 'detected-twins' ? 2 * n * n : 0)
        if (kind === 'detected-twins') {
          expect(incomingFilterWork.nestedFilters).toBe(2 * n)
          expect(reads.operations).toBe(n + 1)
        }
        expect(reads.repoFilterExcluded).toBe(incomingFilterWork.repoVisits)
        expect(reads.nestedFilterExcluded).toBe(incomingFilterWork.nestedVisits)
        expect(reads.operations).toBeLessThanOrEqual(bound)
        const assertPath = (path: string | null) => {
          for (const result of ownerHook.mock.results) {
            expect(result.type).toBe('return')
            if (path === null) {
              expect(result.value).toBeNull()
            } else {
              expect(result.value?.worktreePath).toBe(path)
              expect(result.value?.target).toEqual(
                unstamped ? { kind: 'local' } : { kind: 'environment', environmentId: 'owner-a' }
              )
            }
          }
          if (mode === 'with-probe') {
            expect(contexts).toHaveLength(n)
            expect(
              contexts.every((context) =>
                path === null ? context === null : context?.worktreePath === path
              )
            ).toBe(true)
          }
        }
        assertPath(initialPath)
        const metrics = [
          {
            event: 'cold',
            ...reads.snapshot(),
            commits,
            renders
          }
        ]
        if (kind === 'detected-twins') {
          const before = reads.snapshot()
          void detected[n - 1]!.runtimeOwnerEnvironmentId
          expect(reads.operations).toBe(before.operations + 1)
          expect(reads.rawOperations).toBe(before.rawOperations + 1)
          expect(reads.repoFilterExcluded).toBe(before.repoFilterExcluded)
          expect(reads.nestedFilterExcluded).toBe(before.nestedFilterExcluded)
        }
        const check = async (
          event: string,
          patch: Partial<AppState>,
          changed = false,
          expectedPath: string | null = initialPath,
          limit = bound
        ) => {
          reads.reset()
          commits = 0
          renders = 0
          ownerHook.mockClear()
          if (patch.repos) {
            instrumentRepoFilter(patch.repos)
          }
          await act(async () => useAppStore.setState(patch))
          expect(reads.rawOperations).toBe(
            reads.operations + reads.repoFilterExcluded + reads.nestedFilterExcluded
          )
          expect(reads.repoFilterExcluded).toBe(incomingFilterWork.repoVisits)
          expect(reads.nestedFilterExcluded).toBe(incomingFilterWork.nestedVisits)
          expect(reads.operations).toBeLessThanOrEqual(limit)
          expect(commits).toBe(changed ? n : 0)
          expect(renders).toBe(changed && mode === 'with-probe' ? n : 0)
          expect(ownerHook).toHaveBeenCalledTimes(changed ? n : 0)
          assertPath(expectedPath)
          metrics.push({
            event,
            ...reads.snapshot(),
            commits,
            renders
          })
        }
        await check('known replacement', {
          worktreesByRepo: { ...useAppStore.getState().worktreesByRepo }
        })
        await check(
          'directory catalog replacement',
          folderCase
            ? { folderWorkspaces: [...folders] }
            : {
                detectedWorktreesByRepo: {
                  repo: { ...detectedListingFixture([]), worktrees: [...detected] }
                }
              }
        )
        await check('repo replacement', { repos: [...repos] })
        await check(
          'other host',
          {
            sshStateByEnvironment: new Map([
              ['owner-a', ssh(3)],
              ['other', ssh(8)]
            ])
          },
          false,
          initialPath,
          0
        )
        if (kind === 'inactive-detected') {
          for (const generation of [4, null, 5]) {
            await check(
              'own generation',
              {
                sshStateByEnvironment: new Map([
                  [
                    'owner-a',
                    generation === null
                      ? { ...ssh(3), connectionStates: new Map() }
                      : ssh(generation)
                  ]
                ])
              },
              true,
              generation === null ? null : '/own',
              0
            )
            if (mode === 'with-probe' && generation !== null) {
              expect(
                contexts.every((context) => context?.expectedSshConnectionGeneration === generation)
              ).toBe(true)
            }
          }
        }
        if (!folderCase && kind !== 'detected-twins') {
          const rival = detectedListingFixture([
            worktreeFixture(ws, '/rival', {
              hostId: 'ssh:ssh-1',
              runtimeOwnerEnvironmentId: 'owner-b'
            })
          ]).worktrees[0]!
          await check(
            'nonfirst rival',
            {
              detectedWorktreesByRepo: {
                repo: { ...detectedListingFixture([]), worktrees: [...detected, rival] }
              }
            },
            true,
            null
          )
          await check(
            'rival removed',
            {
              detectedWorktreesByRepo: {
                repo: { ...detectedListingFixture([]), worktrees: detected }
              }
            },
            true
          )
        }
        if (unstamped) {
          await check(
            'SSH repo sibling',
            { repos: [...repos, repoFixture({ executionHostId: 'ssh:ssh-1' })] },
            true,
            null
          )
          await check('SSH repo sibling removed', { repos: [...repos] }, true)
        }
        if (kind === 'folder-own') {
          await check('unrelated folder path', {
            folderWorkspaces: [
              reads.row({ ...folders[0]!, folderPath: '/unrelated-change' }, 'executionHostId'),
              ...folders.slice(1)
            ]
          })
        }
        const currentFolders = useAppStore.getState().folderWorkspaces
        const ownPath = folderCase
          ? {
              folderWorkspaces: [
                ...currentFolders.slice(0, -1),
                reads.row({ ...currentFolders[n - 1]!, folderPath: '/changed' }, 'executionHostId')
              ]
            }
          : kind === 'detected-twins'
            ? {
                detectedWorktreesByRepo: {
                  repo: {
                    ...detectedListingFixture([]),
                    worktrees: [
                      ...detected.slice(0, -1),
                      reads.row(
                        { ...detected[n - 1]!, path: '/changed' },
                        'runtimeOwnerEnvironmentId',
                        'nested'
                      )
                    ]
                  }
                }
              }
            : { worktreesByRepo: { repo: [{ ...known, path: '/changed' }] } }
        await check('own path', ownPath, !ambiguousFolder, ambiguousFolder ? null : '/changed')
        console.info('attachment-catalog-derivation', JSON.stringify({ mode, kind, n, metrics }))
        view.unmount()
        if (kind === 'detected-twins' && n === 10 && mode === 'scope-only') {
          console.info(
            'attachment-attribution-boundaries',
            JSON.stringify(
              assertIncomingOwnerFilterBoundaries(reads, useAppStore.getState(), known, ws)
            )
          )
        }
      }
    }
  )
}

it('keeps mounted attachment scopes quiet and folder catalog work linear at N and 10N', async () => {
  for (const n of [10, 100]) {
    const fixture = nativeChatFanoutFixture(n, n + 1, 0)
    let visits = 0
    for (const folder of fixture.folderWorkspaces) {
      instrument(folder, () => visits++)
    }
    useAppStore.setState(
      {
        ...initial,
        ...fixture,
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null,
        runtimeEnvironments: [],
        runtimeEnvironmentCatalogHydrated: true
      },
      true
    )
    const contexts = new Map<string, NativeChatImageRuntimeContext>()
    const renders = new Map<string, number>()
    function Probe({ id }: { id: string }) {
      contexts.set(id, useContext(NativeChatMarkdownImageOwnerContext)!.runtimeContext)
      renders.set(id, (renders.get(id) ?? 0) + 1)
      return null
    }
    let commits = 0
    const view = render(
      Array.from({ length: n }, (_, index) => {
        const id = `chat-${index}`
        return (
          <Profiler key={id} id={id} onRender={() => commits++}>
            <NativeChatMarkdownImageOwnerProvider tabId={id} sessionId={null} isVisible>
              <NativeChatTextAttachmentScope enabled>
                <Probe id={id} />
              </NativeChatTextAttachmentScope>
            </NativeChatMarkdownImageOwnerProvider>
          </Profiler>
        )
      })
    )
    await act(async () => {})
    const baseline = new Map(renders)
    const state = useAppStore.getState()
    const unusedFolders = state.folderWorkspaces.map((folder, index) =>
      index === n ? { ...folder, name: 'Unused rename' } : folder
    )
    visits = 0
    commits = 0
    await act(async () => useAppStore.setState({ folderWorkspaces: unusedFolders }))
    expect(renders).toEqual(baseline)
    expect(commits).toBe(0)
    expect(visits).toBeLessThanOrEqual(8 * (n + 1))
    visits = 0
    await act(async () =>
      useAppStore.setState({
        sshStateByEnvironment: new Map([
          [
            'other-host',
            {
              targetGenerations: new Map(),
              targetLabels: new Map(),
              removedTargetLabels: new Map(),
              targetsHydrated: true,
              connectionStates: new Map()
            }
          ]
        ])
      })
    )
    expect(renders).toEqual(baseline)
    expect(commits).toBe(0)
    expect(visits).toBe(0)
    const ownChange = unusedFolders.map((folder, index) =>
      index === 0 ? { ...folder, folderPath: '/renamed' } : folder
    )
    visits = 0
    await act(async () => useAppStore.setState({ folderWorkspaces: ownChange }))
    expect(contexts.get('chat-0')?.worktreePath).toBe('/renamed')
    expect(renders.get('chat-0')).toBe(baseline.get('chat-0')! + 1)
    for (let index = 1; index < n; index++) {
      expect(renders.get(`chat-${index}`)).toBe(baseline.get(`chat-${index}`))
    }
    expect(visits).toBeLessThanOrEqual(8 * (n + 1))
    view.unmount()
  }
})
