// @vitest-environment happy-dom
import { measureRecovery } from './worktree-visibility-recovery-measurement-test-fixtures'
import {
  SCRATCH_PATH,
  mocks,
  makeRepo,
  makeWorktree,
  makeDetected,
  root,
  renderDialog,
  deferred,
  buttonWithText,
  sourceSwitch,
  click,
  setInputValue,
  setGroupedRecovery
} from './worktree-visibility-dialog-test-fixtures'
import { act } from 'react'
import { expect, it } from 'vitest'
import { getHostContextLabel } from '../../../../shared/worktree/host-context-labels'
it('keeps a healthy collection sibling actionable while the other scan fails and retries only the failed exact owner', async () => {
  const alpha = makeRepo()
  const beta = makeRepo({ id: 'beta', path: '/beta' })
  mocks.state.repos = [alpha, beta]
  mocks.state.modalData = {
    repoId: alpha.id,
    hostId: 'local',
    recoveryTargets: [
      { repoId: alpha.id, hostId: 'local' },
      { repoId: beta.id, hostId: 'local' }
    ]
  }
  mocks.state.detectedWorktreesByRepo = {
    [alpha.id]: makeDetected(),
    beta: makeDetected(
      [
        makeWorktree({
          repoId: 'beta',
          id: 'beta-hidden',
          path: '/beta/hidden',
          displayName: 'beta hidden'
        })
      ],
      { repoId: 'beta' }
    )
  }
  mocks.state.fetchWorktrees.mockImplementation(async (id: string) => id !== 'beta')
  await renderDialog()
  const betaShow = () =>
    document.querySelector<HTMLButtonElement>('button[aria-label^="Show beta hidden at"]')!
  expect(betaShow()).not.toBeNull()
  // Failed is not authoritative empty, and does not veto the healthy owner's row.
  expect(
    document.querySelector<HTMLButtonElement>('button[aria-label^="Show scratch-1 at"]')!.disabled
  ).toBe(false)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not list')
  mocks.state.fetchWorktrees.mockClear()
  mocks.state.fetchWorktrees.mockResolvedValue(true)
  await click(buttonWithText('Try again'))
  expect(mocks.state.fetchWorktrees).toHaveBeenCalledExactlyOnceWith('beta', {
    requireAuthoritative: true,
    executionHostId: 'local'
  })
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(betaShow().disabled).toBe(false)
})

it.each([100, 1000])(
  'measures the real collection open and scan trigger at %s members with an independent unrelated catalog',
  async (n) => {
    for (const unrelated of [0, 1000]) {
      let repoReads = 0
      let memberReads = 0
      const repos = Array.from({ length: n + unrelated }, (_, i) => ({
        ...makeRepo({ path: `/repo-${i}` }),
        get id() {
          repoReads++
          return `repo-${i}`
        }
      }))
      const recoveryTargets = Array.from({ length: n }, (_, i) => ({
        get repoId() {
          memberReads++
          return `repo-${i}`
        },
        hostId: 'local'
      }))
      mocks.state.repos = repos
      mocks.state.modalData = { repoId: 'repo-0', hostId: 'local', recoveryTargets }
      mocks.state.detectedWorktreesByRepo = {
        'repo-0': makeDetected([makeWorktree({ repoId: 'repo-0' })], { repoId: 'repo-0' })
      }
      mocks.state.fetchWorktrees.mockClear()
      mocks.state.fetchWorktrees.mockResolvedValue(true)
      await renderDialog()
      expect(document.body.textContent).toContain('Hidden worktrees (1)')
      expect(mocks.state.fetchWorktrees).toHaveBeenCalledTimes(n)
      expect(memberReads).toBeGreaterThanOrEqual(n)
      expect(memberReads).toBeLessThanOrEqual(5 * n)
      expect(repoReads).toBeGreaterThanOrEqual(n + unrelated)
      expect(repoReads).toBeLessThan(20 * (n + unrelated))
      process.stdout.write(
        `Q3708 recovery open ${JSON.stringify({ n, unrelated, repoReads, memberReads, scans: mocks.state.fetchWorktrees.mock.calls.length })}\n`
      )
      await act(async () => root.render(null))
    }
  }
)

it('reopens a collection mid-write without scanning that owner, then settles it while a healthy sibling stays usable', async () => {
  const alpha = makeRepo()
  const beta = makeRepo({ id: 'beta', path: '/beta' })
  mocks.state.repos = [alpha, beta]
  mocks.state.modalData = {
    repoId: alpha.id,
    hostId: 'local',
    recoveryTargets: [
      { repoId: alpha.id, hostId: 'local' },
      { repoId: beta.id, hostId: 'local' }
    ]
  }
  mocks.state.detectedWorktreesByRepo = {
    [alpha.id]: makeDetected(),
    beta: makeDetected(
      [
        makeWorktree({
          repoId: 'beta',
          id: 'beta-hidden',
          path: '/beta/hidden',
          displayName: 'beta hidden'
        })
      ],
      { repoId: 'beta' }
    )
  }
  const update = deferred<boolean>()
  mocks.state.updateRepo.mockReturnValueOnce(update.promise)
  await renderDialog()
  await click(
    document.querySelector<HTMLButtonElement>('button[aria-label^="Show beta hidden at"]')!
  )
  await act(async () => root.render(null))
  mocks.state.fetchWorktrees.mockClear()
  await renderDialog()
  expect(
    document.querySelector<HTMLButtonElement>('button[aria-label^="Show beta hidden at"]')!.disabled
  ).toBe(true)
  expect(
    document.querySelector<HTMLButtonElement>('button[aria-label^="Show scratch-1 at"]')!.disabled
  ).toBe(false)
  expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual([alpha.id])
  await act(async () => {
    update.resolve(false)
    await update.promise
  })
  expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual([alpha.id, 'beta'])
  expect(
    document.querySelector<HTMLButtonElement>('button[aria-label^="Show beta hidden at"]')!.disabled
  ).toBe(false)
})

it('does not substitute a removed collection owner or leak its deferred scan into another host scope', async () => {
  const alpha = makeRepo()
  const beta = makeRepo({ id: 'beta', path: '/beta', executionHostId: 'local' })
  const twin = makeRepo({ id: 'beta', path: '/remote/beta', executionHostId: 'runtime:server' })
  mocks.state.repos = [alpha, beta, twin]
  mocks.state.modalData = {
    repoId: alpha.id,
    hostId: 'local',
    recoveryTargets: [
      { repoId: alpha.id, hostId: 'local' },
      { repoId: beta.id, hostId: 'local' }
    ]
  }
  mocks.state.detectedWorktreesByRepo = {
    [alpha.id]: makeDetected(),
    beta: makeDetected(
      [
        makeWorktree({
          repoId: 'beta',
          hostId: 'local',
          id: 'beta-hidden',
          path: '/beta/hidden',
          displayName: 'beta hidden'
        }),
        makeWorktree({
          repoId: 'beta',
          hostId: 'runtime:server',
          id: 'remote-hidden',
          path: '/remote/beta/hidden',
          displayName: 'remote hidden'
        })
      ],
      { repoId: 'beta' }
    )
  }
  const scan = deferred<boolean>()
  mocks.state.fetchWorktrees.mockImplementation((id: string) =>
    id === beta.id ? scan.promise : Promise.resolve(true)
  )
  await renderDialog()
  mocks.state.repos = [alpha, twin]
  await renderDialog()
  expect(document.querySelector('button[aria-label^="Show beta hidden at"]')).toBeNull()
  expect(document.querySelector('button[aria-label^="Show remote hidden at"]')).toBeNull()
  await act(async () => {
    scan.resolve(false)
    await scan.promise
  })
  expect(mocks.state.updateRepo).not.toHaveBeenCalled()
  expect(
    document.querySelector<HTMLButtonElement>('button[aria-label^="Show scratch-1 at"]')!.disabled
  ).toBe(false)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not list')
})

it('does not let an old failed-member Retry settle a returned collection owner after its new open scan', async () => {
  const alpha = makeRepo()
  const beta = makeRepo({ id: 'beta', path: '/beta', executionHostId: 'local' })
  mocks.state.repos = [alpha, beta]
  mocks.state.modalData = {
    repoId: alpha.id,
    hostId: 'local',
    recoveryTargets: [
      { repoId: alpha.id, hostId: 'local' },
      { repoId: beta.id, hostId: 'local' }
    ]
  }
  mocks.state.detectedWorktreesByRepo = {
    [alpha.id]: makeDetected(),
    beta: makeDetected([], { repoId: 'beta' })
  }
  mocks.state.fetchWorktrees.mockImplementation(async (id: string) => id !== beta.id)
  await renderDialog()
  const oldRetry = deferred<boolean>()
  mocks.state.fetchWorktrees.mockReturnValueOnce(oldRetry.promise)
  await click(buttonWithText('Try again'))
  mocks.state.repos = [alpha]
  await renderDialog()
  mocks.state.fetchWorktrees.mockResolvedValue(true)
  mocks.state.repos = [alpha, beta]
  await renderDialog()
  expect(document.querySelector('[role="alert"]')).toBeNull()
  await act(async () => {
    oldRetry.resolve(false)
    await oldRetry.promise
  })
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

it('keeps identical recovery paths on two owners distinct and names the exact source-control host', async () => {
  const local = makeRepo({ executionHostId: 'local' })
  const remote = makeRepo({ executionHostId: 'runtime:env-1' })
  const write = deferred<boolean>()
  mocks.state.repos = [local, remote]
  mocks.state.modalData = {
    repoId: local.id,
    hostId: 'local',
    recoveryTargets: [
      { repoId: local.id, hostId: 'local' },
      { repoId: remote.id, hostId: 'runtime:env-1' }
    ]
  }
  mocks.state.detectedWorktreesByRepo = {
    [local.id]: makeDetected([
      makeWorktree({ hostId: 'local' }),
      makeWorktree({ hostId: 'runtime:env-1' })
    ])
  }
  mocks.state.updateRepo.mockImplementation(() => write.promise)
  await renderDialog()
  const showButtons = [
    ...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Show scratch-1 at "]')
  ]
  expect(showButtons).toHaveLength(2)
  expect(new Set(showButtons.map((button) => button.getAttribute('aria-label'))).size).toBe(2)
  expect(document.body.textContent).toContain('orca · /repo · Local')
  await act(async () => showButtons[1].click())
  expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith(
    remote.id,
    expect.objectContaining({ importedExternalWorktreePaths: [SCRATCH_PATH] }),
    { hostId: 'runtime:env-1' }
  )
  expect(showButtons[0].disabled).toBe(false)
  expect(showButtons[1].disabled).toBe(true)
  await act(async () => write.resolve(false))
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  expect(showButtons[0].disabled).toBe(false)
  expect(local.importedExternalWorktreePaths).toBeUndefined()
})

it('retains both authored nested filesystems at the same runtime and path through grouping, scan and exact Show', async () => {
  const alpha = makeRepo({
    id: 'a',
    executionHostId: 'runtime:server',
    connectionId: 'build-a',
    upstream: { owner: 'org', repo: 'harbor' }
  })
  const beta = makeRepo({ ...alpha, id: 'b', connectionId: 'build-b' })
  await setGroupedRecovery([alpha, beta], alpha)
  mocks.state.detectedWorktreesByRepo = Object.fromEntries(
    [alpha, beta].map((repo) => [
      repo.id,
      makeDetected(
        [
          makeWorktree({
            repoId: repo.id,
            hostId: 'runtime:server',
            displayName: `${repo.id} hidden`
          })
        ],
        { repoId: repo.id }
      )
    ])
  )
  await renderDialog()
  expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
  const rows = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Show "]')]
  expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
    expect.stringContaining('Show a hidden at /repo ·'),
    expect.stringContaining('Show b hidden at /repo ·')
  ])
  expect(rows.every((row) => !row.disabled)).toBe(true)
  await click(rows[1])
  expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith(
    'b',
    expect.objectContaining({ importedExternalWorktreePaths: [SCRATCH_PATH] }),
    { hostId: 'runtime:server' }
  )
  expect(beta.importedExternalWorktreePaths).toEqual([SCRATCH_PATH])
  expect(alpha.importedExternalWorktreePaths).toBeUndefined()
  expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'b'])
  expect(alpha.connectionId).toBe('build-a')
  expect(beta.connectionId).toBe('build-b')
})

it('scans genuine aliases once while retaining representative A recovery and exact source B preferences', async () => {
  const alpha = makeRepo({ id: 'a', upstream: { owner: 'org', repo: 'harbor' } })
  const beta = makeRepo({ ...alpha, id: 'b', displayName: 'source B' })
  await setGroupedRecovery([alpha, beta], beta)
  mocks.state.detectedWorktreesByRepo = {
    a: makeDetected([makeWorktree({ repoId: 'a' })], { repoId: 'a' }),
    b: makeDetected([makeWorktree({ repoId: 'b' })], { repoId: 'b' })
  }
  await renderDialog()
  expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual(['a'])
  expect(document.querySelectorAll('button[aria-label^="Show scratch-1 at"]')).toHaveLength(1)
  expect(document.body.textContent).toContain('source B · /repo')
  expect(sourceSwitch().disabled).toBe(false)
  await click(sourceSwitch())
  expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith(
    'b',
    { worktreeVisibilitySourcePreferences: { builtIn: { claude: 'show' } } },
    { hostId: 'local' }
  )
  expect(alpha.worktreeVisibilitySourcePreferences).toBeUndefined()
  expect(beta.worktreeVisibilitySourcePreferences).toEqual({ builtIn: { claude: 'show' } })
  mocks.state.updateRepo.mockClear()
  await click(buttonWithText('Show'))
  expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith(
    'a',
    expect.objectContaining({ importedExternalWorktreePaths: [SCRATCH_PATH] }),
    { hostId: 'local' }
  )
  expect(beta.importedExternalWorktreePaths).toBeUndefined()
  expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'a'])
})

it.each([
  { dimension: 'detected', n: 100 },
  { dimension: 'detected', n: 1000 },
  { dimension: 'hidden', n: 100 },
  { dimension: 'hidden', n: 1000 }
])(
  'measures independent $dimension=$n with fixed current catalog and two real recovery members',
  async ({ dimension, n }) => {
    const measurement = await measureRecovery()
    try {
      const alpha = makeRepo({
        id: 'a',
        path: '/alpha',
        upstream: { owner: 'org', repo: 'harbor' }
      })
      const beta = makeRepo({ ...alpha, id: 'b', path: '/beta', executionHostId: 'runtime:server' })
      const unrelated = makeRepo({ id: 'outside', path: '/outside' })
      const requests = await setGroupedRecovery([alpha, beta], alpha)
      measurement.measureRequests(requests)
      mocks.state.repos = [alpha, beta, unrelated]
      const k = dimension === 'hidden' ? n : 12
      const d = dimension === 'detected' ? n : 1100
      const own = [alpha, beta].map((repo) =>
        Array.from({ length: k / 2 }, (_, i) =>
          measurement.row(
            makeWorktree({
              repoId: repo.id,
              hostId: repo.executionHostId ?? 'local',
              id: `${repo.id}-${i}`,
              path: `${repo.path}/hidden-${i}`,
              displayName: `${repo.id} hidden ${i}`
            })
          )
        )
      )
      mocks.state.detectedWorktreesByRepo = {
        a: makeDetected(own[0], { repoId: 'a' }),
        b: makeDetected(own[1], { repoId: 'b' }),
        outside: makeDetected(
          Array.from({ length: d - k }, (_, i) =>
            measurement.row(makeWorktree({ repoId: 'outside', id: `outside-${i}` }))
          ),
          { repoId: 'outside' }
        )
      }
      await renderDialog()
      const opened = measurement.snapshot()
      expect(opened.preparations).toBe(1)
      expect(opened.partitionRows).toBe(d)
      expect(opened.scans).toBe(2)
      expect(opened.requestReads).toBe(4)
      expect(opened.hiddenVisits).toBe(k * opened.listRenders)
      expect(opened.visibleVisits).toBe(k * opened.listRenders)
      expect(opened.sourceRenders).toBeGreaterThan(0)
      expect(opened.sourcePathReads).toBeGreaterThan(0)
      expect(document.body.textContent).toContain(`Hidden worktrees (${k})`)
      const visibleNames = () =>
        [...document.querySelectorAll('button[aria-label^="Show "]')].map((row) =>
          row.getAttribute('aria-label')
        )
      expect(visibleNames().slice(0, 3)).toEqual([
        expect.stringContaining(
          `Show a hidden 0 at /alpha · ${getHostContextLabel('local')} · hidden-0`
        ),
        expect.stringContaining(
          `Show a hidden 1 at /alpha · ${getHostContextLabel('local')} · hidden-1`
        ),
        expect.stringContaining(
          `Show a hidden 2 at /alpha · ${getHostContextLabel('local')} · hidden-2`
        )
      ])
      const search = document.querySelector<HTMLInputElement>(
        'input[aria-label="Search hidden worktrees"]'
      )!
      await setInputValue(search, `b hidden ${k / 2 - 1}`)
      const searched = measurement.snapshot()
      expect(visibleNames()).toEqual([
        expect.stringContaining(
          `Show b hidden ${k / 2 - 1} at /beta · server · hidden-${k / 2 - 1}`
        )
      ])
      expect(searched.preparations).toBe(opened.preparations)
      expect(searched.partitionRows).toBe(opened.partitionRows)
      expect(searched.scans).toBe(2)
      expect(searched.listLowercaseCalls).toBeGreaterThan(opened.listLowercaseCalls)
      expect(searched.listLowercaseBytes).toBeGreaterThan(opened.listLowercaseBytes + k)
      expect(searched.hiddenVisits - opened.hiddenVisits).toBe(k)
      process.stdout.write(
        `Q3708 recovery populations ${JSON.stringify({ dimension, n, c: 2, catalog: 3, d, k, opened, searched })}\n`
      )
    } finally {
      measurement.restore()
    }
  }
)

it.each([100, 1000])(
  'measures %s real scans settling in separate acts, including one immutable detected publication',
  async (n) => {
    const measurement = await measureRecovery()
    try {
      const repos = Array.from({ length: n }, (_, i) =>
        makeRepo({
          id: `member-${i}`,
          path: `/member-${i}`,
          upstream: { owner: 'org', repo: 'harbor' }
        })
      )
      const requests = await setGroupedRecovery(repos, repos[0])
      measurement.measureRequests(requests)
      const scans = repos.map(() => deferred<boolean>())
      const byId = new Map(repos.map((repo, i) => [repo.id, scans[i]]))
      const detected = Object.fromEntries(
        repos.map((repo, i) => [
          repo.id,
          makeDetected(
            [
              measurement.row(
                makeWorktree({
                  repoId: repo.id,
                  id: `hidden-${i}`,
                  path: `${repo.path}/hidden`,
                  displayName: `hidden ${i}`
                })
              )
            ],
            { repoId: repo.id }
          )
        ])
      )
      mocks.state.detectedWorktreesByRepo = detected
      mocks.state.fetchWorktrees.mockImplementation((id: string) => byId.get(id)!.promise)
      const { default: Dialog } = await import('./WorktreeVisibilityDialog')
      await renderDialog()
      const opened = measurement.snapshot()
      expect(opened.scans).toBe(n)
      expect(opened.partitionRows).toBe(n)
      expect(document.body.textContent).toContain(`Hidden worktrees (${n})`)
      expect(sourceSwitch().disabled).toBe(true)
      const settlements: Record<string, number>[] = []
      let previous = opened
      for (let i = 0; i < n; i++) {
        await act(async () => {
          if (i === Math.floor(n / 2)) {
            mocks.state.detectedWorktreesByRepo = {
              ...detected,
              [repos[i].id]: {
                ...detected[repos[i].id],
                worktrees: [...detected[repos[i].id].worktrees]
              }
            }
            root.render(<Dialog />)
          }
          scans[i].resolve(true)
          await scans[i].promise
        })
        const current = measurement.snapshot()
        const before: Record<string, number> = previous
        const delta = Object.fromEntries(
          Object.entries(current).map(([key, value]) => [key, value - before[key]])
        )
        settlements.push(delta)
        expect(current.scans).toBe(n)
        expect(current.listRenders).toBeGreaterThan(previous.listRenders)
        expect(current.sourceRenders).toBeGreaterThan(previous.sourceRenders)
        expect(current.memberReads).toBeGreaterThan(previous.memberReads)
        expect(current.scanProductReads).toBeGreaterThan(previous.scanProductReads)
        expect(current.hiddenVisits - previous.hiddenVisits).toBe(
          n * (current.listRenders - previous.listRenders)
        )
        expect(current.partitionRows - previous.partitionRows).toBe(i === Math.floor(n / 2) ? n : 0)
        expect(current.preparations - previous.preparations).toBe(i === Math.floor(n / 2) ? 1 : 0)
        previous = current
      }
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(sourceSwitch().disabled).toBe(false)
      const rows = [
        ...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Show hidden "]')
      ]
      expect(rows).toHaveLength(10)
      expect(rows[0].getAttribute('aria-label')).toContain(
        `Show hidden 0 at /member-0 · ${getHostContextLabel('local')} · hidden`
      )
      expect(rows[9].getAttribute('aria-label')).toContain(
        `Show hidden 9 at /member-9 · ${getHostContextLabel('local')} · hidden`
      )
      expect(rows.every((row) => !row.disabled)).toBe(true)
      process.stdout.write(
        `Q3708 recovery settlements ${JSON.stringify({ n, opened, settlements, total: measurement.snapshot() })}\n`
      )
    } finally {
      measurement.restore()
    }
  }
)

it('counts alias failure/Retry and reopen during the exact source write without rescanning that physical checkout', async () => {
  const measurement = await measureRecovery()
  try {
    const alpha = makeRepo({ id: 'a', upstream: { owner: 'org', repo: 'harbor' } })
    const source = makeRepo({ ...alpha, id: 'b' })
    const healthy = makeRepo({ ...alpha, id: 'c', path: '/healthy' })
    const requests = await setGroupedRecovery([alpha, source, healthy], source)
    measurement.measureRequests(requests)
    mocks.state.detectedWorktreesByRepo = Object.fromEntries(
      [alpha, source, healthy].map((repo) => [
        repo.id,
        makeDetected(
          [
            measurement.row(
              makeWorktree({
                repoId: repo.id,
                path: `${repo.path}/hidden`,
                displayName: `${repo.id} hidden`
              })
            )
          ],
          { repoId: repo.id }
        )
      ])
    )
    mocks.state.fetchWorktrees.mockImplementation(async (id: string) => id !== 'a')
    await renderDialog()
    expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual(['a', 'c'])
    expect(document.body.textContent).toContain('Hidden worktrees (2)')
    expect(sourceSwitch().disabled).toBe(false)
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label^="Show c hidden at"]')!.disabled
    ).toBe(false)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not list')
    const failed = measurement.snapshot()
    mocks.state.fetchWorktrees.mockResolvedValue(true)
    await click(buttonWithText('Try again'))
    expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual(['a', 'c', 'a'])
    expect(document.querySelector('[role="alert"]')).toBeNull()
    const retried = measurement.snapshot()
    const write = deferred<boolean>()
    mocks.state.updateRepo.mockReturnValueOnce(write.promise)
    await click(sourceSwitch())
    expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith('b', expect.anything(), {
      hostId: 'local'
    })
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label^="Show a hidden at"]')!.disabled
    ).toBe(true)
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label^="Show c hidden at"]')!.disabled
    ).toBe(false)
    await act(async () => root.render(null))
    await renderDialog()
    expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual(['a', 'c', 'a', 'c'])
    expect(sourceSwitch().disabled).toBe(true)
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label^="Show a hidden at"]')!.disabled
    ).toBe(true)
    const reopened = measurement.snapshot()
    await act(async () => {
      write.resolve(false)
      await write.promise
    })
    expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual([
      'a',
      'c',
      'a',
      'c',
      'b'
    ])
    expect(sourceSwitch().disabled).toBe(false)
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label^="Show a hidden at"]')!.disabled
    ).toBe(false)
    expect(alpha.worktreeVisibilitySourcePreferences).toBeUndefined()
    expect(healthy.worktreeVisibilitySourcePreferences).toBeUndefined()
    process.stdout.write(
      `Q3708 recovery lifetime ${JSON.stringify({ failed, retried, reopened, settled: measurement.snapshot(), scans: mocks.state.fetchWorktrees.mock.calls })}\n`
    )
  } finally {
    measurement.restore()
  }
})

it('admits no remaining Retry target after disposal and preserves positive current rows on a fresh reopen', async () => {
  const measurement = await measureRecovery()
  try {
    const alpha = makeRepo({ id: 'a', path: '/alpha', upstream: { owner: 'org', repo: 'harbor' } })
    const beta = makeRepo({ ...alpha, id: 'b', path: '/beta' })
    const requests = await setGroupedRecovery([alpha, beta], alpha)
    measurement.measureRequests(requests)
    mocks.state.detectedWorktreesByRepo = Object.fromEntries(
      [alpha, beta].map((repo) => [
        repo.id,
        makeDetected(
          [
            measurement.row(
              makeWorktree({
                repoId: repo.id,
                path: `${repo.path}/hidden`,
                displayName: `${repo.id} hidden`
              })
            )
          ],
          { repoId: repo.id }
        )
      ])
    )
    mocks.state.fetchWorktrees.mockResolvedValue(false)
    await renderDialog()
    expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    expect(document.body.textContent).toContain('Hidden worktrees (2)')
    const retry = deferred<boolean>()
    mocks.state.fetchWorktrees.mockReturnValueOnce(retry.promise)
    await click(buttonWithText('Try again'))
    expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'a'])
    await act(async () => root.render(null))
    const disposed = measurement.snapshot()
    await act(async () => {
      retry.resolve(true)
      await retry.promise
    })
    expect(measurement.snapshot()).toEqual(disposed)
    expect(document.querySelector('[aria-label^="Show "]')).toBeNull()
    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    mocks.state.fetchWorktrees.mockResolvedValue(true)
    await renderDialog()
    expect(mocks.state.fetchWorktrees.mock.calls.map(([id]) => id)).toEqual([
      'a',
      'b',
      'a',
      'a',
      'b'
    ])
    const rows = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Show "]')]
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => !row.disabled)).toBe(true)
    expect(rows[0].getAttribute('aria-label')).toContain('Show a hidden at /alpha ·')
    expect(rows[1].getAttribute('aria-label')).toContain('Show b hidden at /beta ·')
    process.stdout.write(
      `Q3708 recovery disposal ${JSON.stringify({ disposed, reopened: measurement.snapshot(), scans: mocks.state.fetchWorktrees.mock.calls })}\n`
    )
  } finally {
    measurement.restore()
  }
})
