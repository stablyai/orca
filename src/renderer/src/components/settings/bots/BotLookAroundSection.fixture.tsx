// Look around's settings in each state the host can report, at a fixed "now" each state agrees with.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { publishBots, stampBotHost } from '@/lib/bot-catalog-snapshot'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotLookAround, UpNextState } from '../../../../../shared/bots/bot-look-around'
import { BotHoverLookLine } from '../../bots/BotHoverLookLine'
import { BotRow } from '../../bots/BotRow'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { BotLookAroundSection } from './BotLookAroundSection'

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
/** Wed Nov 11 2026 on this machine's clock. */
const at = (hour: number, minute = 0, day = 11) => new Date(2026, 10, day, hour, minute).getTime()
const MIN = 60_000

const SERVER = 'build-server'
const server: PublicKnownRuntimeEnvironment = {
  id: SERVER,
  name: SERVER,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: SERVER
}

const bot = (lookAround?: BotLookAround, paired = false): Bot =>
  stampBotHost(paired ? `runtime:${SERVER}` : 'local', localBot(lookAround))

const localBot = (lookAround?: BotLookAround): Bot => ({
  id: 'bot-cos',
  name: 'CoS',
  hostId: 'local',
  folder: 'cos',
  folderWorkspaceId: 'fw-cos',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: false, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: {},
  google: false,
  skillProjects: [],
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1,
  ...(lookAround ? { lookAround } : {})
})

const preset: BotLookAround = { on: true, every: 'every-4h', weekdaysOnly: true, focus: '' }
const custom: BotLookAround = {
  ...preset,
  every: 'custom',
  times: ['09:30', '14:00'],
  timezone: ZONE
}

type Case = {
  now: number
  setting?: BotLookAround
  state: Partial<UpNextState>
  failing?: number
  /** The host answers as one too old for custom times. */
  oldHost?: boolean
  readFailure?: boolean
  hostZone?: string
  /** On a paired server rather than this computer. */
  paired?: boolean
}

function stub(c: Case): Bot {
  if (c.readFailure) {
    const log = console.error
    console.error = (...args: unknown[]) => {
      if (args[0] !== 'Failed to read Look around:') {
        log(...args)
      }
    }
  }
  const subject = bot(c.setting, c.paired)
  // Every "Today at…" and "Next look" reads this clock.
  Date.now = () => c.now
  publishBots([subject], undefined, subject.hostId)
  const state: UpNextState = {
    running: false,
    seenAt: 0,
    timeZone: c.setting?.timezone ?? c.hostZone ?? ZONE,
    hostTimeZone: c.hostZone ?? ZONE,
    ...c.state
  }
  const answers: Record<string, unknown> = {
    'bots.list': { bots: [subject] },
    'bots.groups.list': { groups: [] },
    'bots.upNext.unseen': { unseen: {} },
    'bots.lookAround.failing': { unseen: c.failing ? { [subject.id]: c.failing } : {} },
    'bots.activity': {
      activity: {
        workers: [],
        inProgress: [],
        completed: [],
        automations: [],
        waits: [],
        upNext: { state, items: [1, 2, 3].map((n) => ({ id: `s${n}` })) }
      }
    },
    ...(c.oldHost ? {} : { 'bots.lookAround.get': { setting: subject.lookAround, upNext: state } })
  }
  const call = async ({ method }: { method: string }) =>
    c.readFailure && method === 'bots.lookAround.get'
      ? { ok: false, error: { code: 'runtime_unavailable', message: 'Computer unavailable' } }
      : method in answers
        ? { ok: true, result: answers[method] }
        : { ok: false, error: { code: 'method_not_found', message: method } }
  Reflect.set(window.api, 'runtime', { ...window.api.runtime, call })
  Reflect.set(window.api, 'runtimeEnvironments', {
    ...window.api.runtimeEnvironments,
    call: async ({ method }: { method: string }) =>
      method === 'status.get' ? createCompatibleRuntimeStatusResponse(SERVER) : call({ method })
  })
  return subject
}

function section(c: Case, width = 420, interact?: (frame: HTMLElement) => Promise<void>) {
  let subject = bot(c.setting, c.paired)
  return defineFixture({
    width,
    ...(c.paired ? { store: { runtimeEnvironments: [server] } } : {}),
    setup: () => {
      subject = stub(c)
    },
    render: () => (
      <div className="bg-background p-4">
        <BotLookAroundSection bot={subject} update={async () => subject} />
      </div>
    ),
    ...(interact ? { interact } : {})
  })
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Types `hour` into the hour digits of look time `row` (1-based), then leaves the list. */
async function typeHour(frame: HTMLElement, row: number, hour: string, blur = true): Promise<void> {
  const group = frame.querySelectorAll('li[role="group"]')[row - 1]
  const input = group?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) {
    return
  }
  input.focus()
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, hour)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await pause(50)
  if (blur) {
    input.blur()
  }
  await pause(100)
}

const lastLook = { lastLookedAt: at(8, 1), tookMs: MIN }

export const defaultPreset = section({
  now: at(10, 12),
  state: { ...lastLook, nextAt: at(12) }
})

export const customTimes = section({
  now: at(10, 12),
  setting: custom,
  state: { lastLookedAt: at(9, 31), tookMs: MIN, nextAt: at(14) }
})

export const customNarrow = section(
  {
    now: at(10, 12),
    setting: custom,
    state: { lastLookedAt: at(9, 31), tookMs: MIN, nextAt: at(14) }
  },
  320
)

const rawDraftCase: Case = {
  now: at(8, 12),
  setting: custom,
  state: { ...lastLook, nextAt: at(9, 30) }
}
export const rawDraft = section(rawDraftCase, 420, (frame) => typeHour(frame, 1, '7', false))
export const rawDraftNarrow = section(rawDraftCase, 320, (frame) => typeHour(frame, 1, '7', false))

export const validation = section(
  {
    now: at(10, 12),
    setting: { ...custom, times: ['09:30', '11:00'] },
    state: { lastLookedAt: at(9, 31), tookMs: MIN, nextAt: at(11) }
  },
  420,
  (frame) => typeHour(frame, 2, '10')
)

export const nextSkipped = section({
  now: at(11, 45),
  state: {
    lastLookedAt: at(11, 32),
    tookMs: 2 * MIN,
    nextAt: at(16),
    nextSkipped: { at: at(12), lookedAt: at(11, 30) }
  }
})

export const heldForWake = section({
  now: at(12, 1),
  state: { ...lastLook, nextAt: at(12), dueNow: true, nextHeld: true, nextGraceEndsAt: at(13) }
})

export const ranLate = section({
  now: at(10, 12),
  state: { lastLookedAt: at(8, 4), tookMs: MIN, lastLateFor: at(8), nextAt: at(12) }
})

export const failing = section({
  now: at(10, 12),
  failing: 3,
  state: {
    ...lastLook,
    nextAt: at(12),
    failedInARow: 3,
    error: 'The last look was stopped after 10 min.'
  }
})

export const missedFallbackCopy = section({
  now: at(10, 12),
  state: { lastLookedAt: at(20, 1, 10), tookMs: MIN, nextAt: at(12), missedAt: at(8) }
})

export const missedCatchUpCopy = section({
  now: at(10, 12),
  state: {
    lastLookedAt: at(20, 1, 10),
    tookMs: MIN,
    nextAt: at(12),
    missedAt: at(8),
    catchUp: true
  }
})

export const missedThreeDays = section({
  now: at(10, 12),
  failing: 3,
  state: {
    lastLookedAt: at(20, 1, 10),
    tookMs: MIN,
    nextAt: at(12),
    missedAt: at(8),
    repeatTrouble: { scheduledFor: at(8), failed: 0, missed: 3, of: 3 }
  }
})

/** Monday morning after the 8:00 AM look went unrun Wednesday to Friday: the weekend doesn't clear it. */
export const missedThroughWeekend = section({
  now: at(7, 30, 16),
  failing: 3,
  state: {
    lastLookedAt: at(12, 1, 13),
    tookMs: MIN,
    nextAt: at(8, 0, 16),
    repeatTrouble: { scheduledFor: at(8, 0, 13), failed: 0, missed: 3, of: 3 }
  }
})

export const turnedOff = section({
  now: at(10, 12),
  setting: { ...custom, on: false },
  failing: 10,
  state: {}
})

export const offShowsSchedule = section({
  now: at(10, 12),
  setting: { ...custom, on: false },
  state: {}
})

export const pairedHostAsksZone = section(
  {
    now: at(10, 12),
    setting: { ...custom, timezone: undefined },
    hostZone: 'UTC',
    paired: true,
    // 9:30 AM and 2 PM in UTC: from 10:12 AM Pacific (18:12 UTC) the next is tomorrow 9:30 UTC.
    state: {
      lastLookedAt: Date.UTC(2026, 10, 11, 14, 1),
      tookMs: MIN,
      nextAt: Date.UTC(2026, 10, 12, 9, 30)
    }
  },
  420,
  async (frame) => {
    const add = [...frame.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Add time')
    )
    add?.click()
    await pause(100)
  }
)

export const olderHostPresetsOnly = section(
  { now: at(10, 12), oldHost: true, state: { ...lastLook, nextAt: at(12) } },
  420,
  async (frame) => {
    frame.querySelector<HTMLElement>('[aria-label="How often"]')?.click()
    await pause(150)
  }
)

function hoverCard(c: Case, setting: BotLookAround = preset, width = 340) {
  return defineFixture({
    width,
    setup: () => {
      stub({ ...c, setting })
    },
    render: () => (
      <div className="bg-background p-3">
        <div className="rounded-lg border border-border bg-popover p-3 text-popover-foreground">
          <div className="text-[13px] font-semibold">CoS</div>
          <div className="text-xs text-muted-foreground">Idle</div>
          <BotHoverLookLine bot={bot(setting)} />
        </div>
      </div>
    )
  })
}

/** The sidebar card's look line: next look, ran late, a failing streak, and turned off. */
export const hoverCardNext = hoverCard({ now: at(10, 12), state: { nextAt: at(12) } })
export const hoverCardCustomRanLate = hoverCard(
  { now: at(10, 12), state: { nextAt: at(14), lastLateFor: at(9, 30) } },
  custom
)
/** A streak can clear on its own: plain text, no Needs you. */
export const hoverCardFailing = hoverCard({
  now: at(10, 12),
  failing: 3,
  state: { nextAt: at(12), failedInARow: 3 }
})

/** The 8:00 AM look keeps not running, with no failed look at all. */
export const hoverCardMissed = hoverCard({
  now: at(10, 12),
  failing: 3,
  state: { nextAt: at(12), repeatTrouble: { scheduledFor: at(8), failed: 0, missed: 3, of: 3 } }
})

/** Turned itself off: the one state that needs the owner. */
export const hoverCardTurnedOff = hoverCard(
  { now: at(10, 12), failing: 10, state: {} },
  { ...preset, on: false }
)

function sidebarRow(setting: BotLookAround, failing: number) {
  return defineFixture({
    width: 280,
    store: {
      folderWorkspaces: [
        makeFolderWorkspace({ id: 'fw-cos', name: 'CoS', folderPath: '/Users/owner/bots/cos' })
      ]
    },
    setup: () => {
      stub({ now: at(10, 12), setting, failing, state: { nextAt: at(12), failedInARow: failing } })
    },
    render: () => (
      <ConfirmationDialogProvider>
        <div className="flex flex-col rounded-lg border border-border bg-worktree-sidebar py-1 pr-1.5 text-worktree-sidebar-foreground">
          <BotRow
            bot={bot(setting)}
            home={makeFolderWorkspace({
              id: 'fw-cos',
              name: 'CoS',
              folderPath: '/Users/owner/bots/cos'
            })}
            isActive={false}
            onOpen={() => {}}
          />
        </div>
      </ConfirmationDialogProvider>
    )
  })
}

/** Sidebar rows: the badge only once Look around turned itself off; a streak leaves the row quiet. */
export const sidebarRowTurnedOff = sidebarRow({ ...preset, on: false }, 10)
export const sidebarRowStreak = sidebarRow(preset, 3)

export const unavailableHost = section({ now: at(10, 12), readFailure: true, state: {} }, 320)
export const unreadableZone = section(
  {
    now: at(10, 12),
    setting: { ...custom, timezone: 'Mars/Olympus' },
    state: { timeZone: ZONE, zoneUnreadable: true, nextAt: at(14) }
  },
  320
)
export const invalidStoredTimes = section(
  { now: at(10, 12), setting: { ...custom, times: ['09:00', '09:30'] }, state: {} },
  320
)
export const hoverCardMissedNarrow = hoverCard(
  {
    now: at(10, 12),
    failing: 3,
    state: { nextAt: at(12), repeatTrouble: { scheduledFor: at(8), failed: 0, missed: 3, of: 3 } }
  },
  preset,
  320
)
export const hoverCardTurnedOffNarrow = hoverCard(
  { now: at(10, 12), failing: 10, state: {} },
  { ...preset, on: false },
  260
)
