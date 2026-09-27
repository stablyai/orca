import path from 'node:path'
import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import type { FakeProviderFixture } from './cross-machine-recovery-fake-provider'

/** Where the recovery e2e screenshots land; the rendered-evidence tool points it at .bench-fixtures. */
export const RECOVERY_SCREENSHOT_DIR =
  process.env.ORCA_RECOVERY_RENDERED_DIR ??
  path.join(process.cwd(), 'validation-screenshots', 'cross-machine-recovery')

/** The machine name the fake provider reports for this computer. */
export const LOCAL_MACHINE = 'E2E Desk'

const SCENARIO_SELECTORS = {
  complete: 'laptop/ws-complete',
  partial: 'laptop/ws-partial',
  paused: 'mini/ws-paused',
  collision: 'laptop/ws-collision',
  divergence: 'laptop/ws-three'
} as const

/** One picker state the rendered-evidence spec captures on its own. */
export type RecoveryRenderedScenario = keyof typeof SCENARIO_SELECTORS

/** Every picker state the rendered-evidence spec captures, in capture order. */
export const RECOVERY_RENDERED_SCENARIOS = Object.keys(
  SCENARIO_SELECTORS
) as RecoveryRenderedScenario[]

type RecoveryTarget = { worktreeId: string; path: string }

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

function buildItems(): Record<string, unknown>[] {
  const laptop = { host: 'laptop', hostName: 'Work Laptop' }
  const mini = { host: 'mini', hostName: 'Studio Mini', reachable: false }
  return [
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
}

function fixtureOf(items: Record<string, unknown>[], target: RecoveryTarget): FakeProviderFixture {
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

/** The mixed provider fixture: every item kind in one list, plus scripted pickup outcomes. */
export function buildFixture(target: RecoveryTarget): FakeProviderFixture {
  return fixtureOf(buildItems(), target)
}

/** The provider fixture narrowed to the one item a rendered scenario shows. */
export function buildScenarioFixture(
  scenario: RecoveryRenderedScenario,
  target: RecoveryTarget
): FakeProviderFixture {
  return fixtureOf(
    buildItems().filter((candidate) => candidate.selector === SCENARIO_SELECTORS[scenario]),
    target
  )
}

/** Opens Recover Sessions through the Cmd-J palette without focusing the hidden window. */
export async function openRecoverSessionsFromJumpPalette(
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
