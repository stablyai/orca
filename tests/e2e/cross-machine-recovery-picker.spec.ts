/**
 * Recover Sessions picker driven end to end against a fake recovery provider executable.
 *
 * Why a fake provider on disk: the picker's contract is the provider CLI's argv, env and JSON, so
 * only a real spawned process proves env scrubbing, --json, progress streaming and group cancel.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeId, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createFakeRecoveryProvider,
  isProcessAlive,
  type FakeProviderFixture
} from './helpers/cross-machine-recovery-fake-provider'

const SCREENSHOT_DIR = path.join(process.cwd(), 'validation-screenshots', 'cross-machine-recovery')
const LOCAL_MACHINE = 'E2E Desk'
const LEAKED_ENV = {
  ORCA_ENVIRONMENT: 'e2e-remote-environment',
  ORCA_PAIRING_CODE: 'e2e-pairing-code',
  ORCA_REMOTE_PAIRING: 'e2e-remote-pairing'
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString()
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

type SessionFixture = {
  id: string
  title: string
  humanAgo: number | null
  activityAgo?: number
  collision?: boolean
}

function item(input: {
  host: string
  hostName: string
  reachable?: boolean
  workspace: string
  name: string
  sessions: SessionFixture[]
  completeness?: Record<string, unknown>
  newerPartial?: unknown
  notRestorable?: unknown[]
  pause?: unknown
}): Record<string, unknown> {
  return {
    selector: `${input.host}/${input.workspace}`,
    source: {
      host_id: input.host,
      host_name: input.hostName,
      last_seen_at: iso(2 * MINUTE),
      reachable: input.reachable ?? true
    },
    workspace: {
      id: input.workspace,
      repo_name: 'orca-e2e',
      repo_origin: 'git@example.com:orca-e2e.git',
      branch: `feature/${input.workspace}`,
      source_path: `/Users/remote/orca-e2e/${input.workspace}`,
      orca: { kind: 'worktree', name: input.name, instance_id: `${input.workspace}-instance` }
    },
    sessions: input.sessions.map((session) => ({
      session_id: session.id,
      title: session.title,
      last_activity_at: iso(session.activityAgo ?? session.humanAgo ?? HOUR),
      last_human_activity_at: session.humanAgo === null ? null : iso(session.humanAgo),
      activity: session.humanAgo === null ? 'autonomous' : 'human',
      bound_in_orca: true,
      live_local_collision: session.collision ?? false
    })),
    not_restorable: input.notRestorable ?? [],
    checkpoint: {
      id: `${input.workspace}-ckpt`,
      tier: 'latest',
      captured_at: iso(3 * MINUTE),
      source_activity_at: iso(4 * MINUTE)
    },
    checkpoint_count: 4,
    completeness: {
      ready: true,
      missing: [],
      transcript: 'complete',
      code: 'complete',
      layout: 'client-view',
      ...input.completeness
    },
    newer_partial: input.newerPartial ?? null,
    pause: input.pause ?? null,
    local_checkout: null
  }
}

function buildFixture(target: { worktreeId: string; path: string }): FakeProviderFixture {
  const laptop = { host: 'laptop', hostName: 'Work Laptop' }
  const mini = { host: 'mini', hostName: 'Studio Mini', reachable: false }
  const items = [
    item({
      ...laptop,
      workspace: 'ws-three',
      name: 'Three sessions',
      sessions: [
        { id: 'sess-old', title: 'Refactor parser', humanAgo: 3 * HOUR },
        { id: 'sess-new', title: 'Fix login bug', humanAgo: 5 * MINUTE },
        { id: 'sess-auto', title: 'Background eval', humanAgo: null, activityAgo: MINUTE }
      ],
      notRestorable: [
        { agent: 'codex', key: 'session_id', id: 'codex-7', reason: 'agent-not-supported-v1' }
      ]
    }),
    item({
      ...laptop,
      workspace: 'ws-complete',
      name: 'Complete workspace',
      sessions: [{ id: 'sess-complete', title: 'Ship release', humanAgo: 20 * MINUTE }]
    }),
    item({
      ...laptop,
      workspace: 'ws-partial',
      name: 'Partial workspace',
      sessions: [{ id: 'sess-partial', title: 'Half synced', humanAgo: 30 * MINUTE }],
      completeness: { ready: false, missing: ['transcript'], transcript: 'partial' }
    }),
    item({
      ...laptop,
      workspace: 'ws-deferred',
      name: 'Deferred code',
      sessions: [{ id: 'sess-deferred', title: 'Large repo work', humanAgo: 40 * MINUTE }],
      completeness: { code: 'deferred', code_captured_at: iso(2 * HOUR) },
      newerPartial: {
        id: 'ws-deferred-newer',
        captured_at: iso(MINUTE),
        session_activity_at: iso(10 * MINUTE),
        code_captured_at: iso(2 * HOUR)
      }
    }),
    item({
      ...laptop,
      workspace: 'ws-collision',
      name: 'Collision workspace',
      sessions: [
        { id: 'sess-collide', title: 'Already open here', humanAgo: 50 * MINUTE, collision: true }
      ]
    }),
    item({
      ...mini,
      workspace: 'ws-paused',
      name: 'Paused on cellular',
      sessions: [{ id: 'sess-paused', title: 'Mini session', humanAgo: 6 * HOUR }],
      pause: { reason: 'cellular', endpoint: 'local', since: iso(15 * MINUTE) }
    })
  ]
  const localHost = { host_id: 'e2e-desk', host_name: LOCAL_MACHINE }
  return {
    status: {
      version: 1,
      ok: true,
      helper: { running: true, build: 'e2e' },
      local: {
        ...localHost,
        network: {
          status: 'satisfied',
          expensive: false,
          constrained: false,
          cellular: false,
          manual_metered: false
        }
      },
      peers: [],
      scheduler: {
        queued_by_tier: { human: 0, autonomous: 0, recent: 0, idle: 0 },
        workers: 1,
        last_round_at: null
      }
    },
    list: { version: 1, ok: true, generated_at: iso(0), local: localHost, items },
    pickup: {
      'laptop/ws-complete': { kind: 'hang' },
      'laptop/ws-three': {
        kind: 'diverge-until-choice',
        details: {
          session_id: 'sess-old',
          local_last_activity_at: iso(MINUTE),
          picked_captured_at: iso(3 * MINUTE)
        },
        result: {
          version: 1,
          ok: true,
          checkout: { path: target.path, branch: 'feature/ws-three', reused: true },
          sessions: [
            { session_id: 'sess-new', status: 'resumed' },
            { session_id: 'sess-old', status: 'resumed' },
            { session_id: 'sess-auto', status: 'dormant' }
          ],
          orca: {
            execution_host_id: 'local',
            worktree_id: target.worktreeId,
            resumed: [
              { session_id: 'sess-new', tab_id: 'tab-new' },
              { session_id: 'sess-old', tab_id: 'tab-old' }
            ],
            dormant: ['sess-auto']
          }
        }
      }
    }
  }
}

async function captureHiddenRenderer(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  // Why CDP: the window is never shown, so the capture comes straight from the hidden renderer.
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})))
    )
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const body = Buffer.from(data, 'base64')
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    writeFileSync(path.join(SCREENSHOT_DIR, `picker-${name}.png`), body)
    await testInfo.attach(`picker-${name}.png`, { body, contentType: 'image/png' })
  } finally {
    await cdp.detach()
  }
}

async function openRecoverSessionsFromJumpPalette(
  electronApp: ElectronApplication,
  page: Page
): Promise<void> {
  // Headless Playwright keys bypass Electron's before-input-event shortcut path.
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ui:toggleWorktreePalette')
  })
  const palette = page.getByRole('dialog', { name: 'Jump to...' })
  const input = palette.getByPlaceholder(
    'Search chats, terminals, worktrees, settings, and actions...'
  )
  await expect(input).toBeVisible()
  await input.fill('Recover Sessions')
  await palette.locator('[cmdk-item][data-value="quick-action:recover-sessions"]').click()
}

async function assertWindowsStayHidden(electronApp: ElectronApplication): Promise<void> {
  const windows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  )
  expect(windows.every((window) => !window.visible && !window.focused)).toBe(true)
}

test.use({ orcaAppExtraEnv: LEAKED_ENV })

test.describe('Cross-machine recovery picker', () => {
  test('lists provider items, re-runs divergence, cancels, and reveals the local worktree', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const startWorktreeId = await waitForActiveWorktree(orcaPage)
    const target = await orcaPage.evaluate((activeId) => {
      const state = window.__store!.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((candidate) => candidate.id !== activeId)
      if (!worktree) {
        throw new Error('seeded repo has no second worktree')
      }
      return { worktreeId: worktree.id, path: worktree.path }
    }, startWorktreeId)

    const provider = createFakeRecoveryProvider(
      path.join(testInfo.outputDir, 'fake-provider'),
      buildFixture(target)
    )
    await orcaPage.evaluate(async (providerPath) => {
      await window.api.settings.set({ crossMachineRecovery: { providerPath } })
    }, provider.programPath)

    // Why: a remote runtime environment is the window's active host, yet recovery must stay local.
    await orcaPage.evaluate(() => {
      const store = window.__store!
      const settings = store.getState().settings
      store.setState({
        settings: settings
          ? { ...settings, activeRuntimeEnvironmentId: 'e2e-remote-runtime' }
          : settings
      })
    })

    const dialog = orcaPage.getByRole('dialog', { name: 'Recover work from another computer' })
    await expect(dialog).toHaveCount(0)
    await captureHiddenRenderer(orcaPage, testInfo, '1-before')

    await openRecoverSessionsFromJumpPalette(electronApp, orcaPage)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('cross-machine-recovery-destination')).toHaveText(
      `Recovers to this computer (${LOCAL_MACHINE})`
    )
    const rows = dialog.getByTestId('cross-machine-recovery-item')
    await expect(rows).toHaveCount(6)
    await expect(dialog.getByText('Studio Mini (unreachable)')).toBeVisible()

    const row = (name: string) => rows.filter({ hasText: name })
    await expect(row('Partial workspace')).toHaveAttribute('data-disabled', 'true')
    await expect(row('Partial workspace')).toContainText('Not ready: missing transcript')
    await expect(row('Partial workspace')).toContainText('Partial transcript')
    await expect(row('Complete workspace')).not.toHaveAttribute('data-disabled', 'true')

    const deferred = row('Deferred code')
    await expect(deferred.getByTestId('cross-machine-recovery-code-age')).toContainText(
      'Code capture deferred · code from 2 hours ago'
    )
    await expect(deferred.getByTestId('cross-machine-recovery-newer-partial')).toContainText(
      'Newer partial checkpoint not recovered · sessions from 10 minutes ago · code from 2 hours ago'
    )
    await expect(row('Paused on cellular')).toContainText('Paused on cellular')
    await expect(
      row('Three sessions').getByTestId('cross-machine-recovery-not-restorable')
    ).toHaveText("Can't recover here: codex codex-7 (agent not supported yet)")
    await captureHiddenRenderer(orcaPage, testInfo, '2-open')

    await row('Collision workspace').click()
    const collisionCheckbox = dialog.getByRole('checkbox', { name: 'Already open here' })
    await expect(collisionCheckbox).toBeDisabled()
    await expect(collisionCheckbox).toHaveAttribute('aria-checked', 'false')
    await expect(dialog.getByTestId('cross-machine-recovery-session')).toContainText(
      'Already running on this computer'
    )

    await row('Complete workspace').click()
    await dialog.getByRole('button', { name: 'Recover', exact: true }).click()
    await expect(dialog.getByRole('status')).toHaveText('Restoring code…')
    await expect.poll(() => provider.readHang()).not.toBeNull()
    const hang = provider.readHang()!
    expect(isProcessAlive(hang.pid)).toBe(true)
    expect(isProcessAlive(hang.grandchildPid)).toBe(true)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('Recovery was cancelled.')
    await expect.poll(() => isProcessAlive(hang.pid)).toBe(false)
    await expect.poll(() => isProcessAlive(hang.grandchildPid)).toBe(false)
    await expect(dialog).toBeVisible()

    await row('Three sessions').click()
    const checkbox = (name: string) => dialog.getByRole('checkbox', { name })
    await expect(dialog.getByTestId('cross-machine-recovery-session')).toHaveCount(3)
    await expect(checkbox('Fix login bug')).toHaveAttribute('aria-checked', 'true')
    await expect(checkbox('Refactor parser')).toHaveAttribute('aria-checked', 'false')
    await expect(checkbox('Background eval')).toHaveAttribute('aria-checked', 'false')
    await checkbox('Refactor parser').click()
    await expect(checkbox('Refactor parser')).toHaveAttribute('aria-checked', 'true')

    await dialog.getByRole('button', { name: 'Recover', exact: true }).click()
    const divergence = dialog.getByTestId('cross-machine-recovery-divergence')
    await expect(divergence).toContainText(
      'This computer has a newer local copy of session sess-old.'
    )
    await captureHiddenRenderer(orcaPage, testInfo, '3-divergence')

    await divergence.getByRole('button', { name: 'Keep local' }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(target.worktreeId)
    await captureHiddenRenderer(orcaPage, testInfo, '4-after-pickup')

    const invocations = provider.invocations()
    expect(invocations.length).toBeGreaterThanOrEqual(5)
    for (const invocation of invocations) {
      expect(invocation.argv.at(-1)).toBe('--json')
      expect(invocation.env.ORCA_ENVIRONMENT).toBeNull()
      expect(invocation.env.ORCA_PAIRING_CODE).toBeNull()
      expect(invocation.env.ORCA_REMOTE_PAIRING).toBeNull()
      expect(invocation.env.CC_SYNC_ORCA_CLIENT_INSTANCE_ID).toMatch(/\S/)
    }
    const pickups = invocations.filter((invocation) => invocation.argv[0] === 'pickup')
    expect(pickups.map((invocation) => invocation.argv[1])).toEqual([
      'laptop/ws-complete',
      'laptop/ws-three',
      'laptop/ws-three'
    ])
    const [, divergent, rerun] = pickups
    expect(divergent.argv).toEqual([
      'pickup',
      'laptop/ws-three',
      '--resume',
      'sess-new',
      '--resume',
      'sess-old',
      '--progress',
      'ndjson',
      '--json'
    ])
    const choiceAt = rerun.argv.indexOf('--on-divergence')
    expect(rerun.argv[choiceAt + 1]).toBe('keep-local')
    expect(rerun.argv.toSpliced(choiceAt, 2)).toEqual(divergent.argv)
    expect(startWorktreeId).not.toBe(target.worktreeId)
    await assertWindowsStayHidden(electronApp)
  })
})
