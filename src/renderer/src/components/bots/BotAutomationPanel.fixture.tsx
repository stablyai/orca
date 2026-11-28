import { setBotHostListing, publishBots } from '@/lib/bot-catalog-snapshot'
import { useAppStore } from '@/store'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  BotPanelFrame,
  botPanelPage,
  fixtureCos,
  stubBotPanel
} from '../../component-fixtures/fixture-bot-panel'
import { makeAutomation, makeRun } from '../automations/automations-page-fixtures'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import { setBotAutomationPlace } from './bot-automation-place'

const now = Date.now()
const HOUR = 3_600_000
const tomorrowAt9 = new Date(now + 86_400_000).setHours(9, 0, 0, 0)

const digest = makeAutomation({
  id: 'a-digest',
  name: 'Daily PR digest',
  prompt:
    'Every weekday morning, look at the open pull requests in this project.\n\nGroup them by: ready to merge, waiting on review, and blocked. For each blocked PR say in one line what is blocking it and who should act.\n\nPost the digest to the results place. Keep it under 15 lines.',
  rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
  dtstart: now - 30 * 86_400_000,
  nextRunAt: tomorrowAt9,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  workspaceMode: 'existing',
  agentId: 'claude',
  bot: { botId: fixtureCos.id, runsIn: 'new', resultsTo: { channel: '#eng-updates' } },
  on: [{ id: 'e1', source: 'github', event: 'pr_opened', in: [] }]
})

const run = (id: string, title: string, hoursAgo: number, patch: Partial<AutomationRun> = {}) =>
  makeRun({
    id,
    automationId: digest.id,
    title,
    createdAt: now - hoursAgo * HOUR,
    startedAt: now - hoursAgo * HOUR,
    sessionKind: 'chat',
    outputSnapshot: {
      format: 'plain_text',
      content:
        'Ready to merge: #702, #698\nWaiting on review: #700\nBlocked: #695 (needs a rebase; Brennan)',
      capturedAt: now,
      truncated: false
    },
    ...patch
  })

const RUNS = [
  run('r1', 'Scheduled run', 2),
  run('r2', 'PR #702 opened', 26),
  run('r3', 'Scheduled run', 50, { status: 'skipped_missed', error: 'The computer was asleep' }),
  run('r4', 'Scheduled run', 74),
  run('r5', 'Scheduled run', 98)
]
const OLDER = run('r-old', 'Scheduled run', 24 * 16)

const ACTIVITY: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  automations: [],
  waits: []
}

type Scenario =
  | 'default'
  | 'failed'
  | 'running'
  | 'runningTerminal'
  | 'unconfirmed'
  | 'unconfirmedSsh'
  | 'offline'
  | 'update'
  | 'homeFails'
  | 'deleted'

function setup(
  runId: string | null,
  runs: AutomationRun[] = RUNS,
  scenario: Scenario = 'default'
): () => void {
  return () => {
    setBotHostListing({ hosts: [{ hostId: 'local', state: 'live' }], updateNeeded: [] })
    stubBotPanel(ACTIVITY)()
    publishBots([fixtureCos], { threadReplies: false, webhooks: true })
    if (scenario === 'offline') {
      setBotHostListing({ hosts: [{ hostId: 'local', state: 'offline' }], updateNeeded: [] })
    }
    const shownDigest =
      scenario === 'unconfirmedSsh'
        ? { ...digest, on: [], executionTargetType: 'ssh' }
        : scenario !== 'default' && scenario !== 'failed'
          ? { ...digest, on: [] }
          : digest
    const runtime = window.api.runtime
    const fallback = runtime.call
    Reflect.set(window.api, 'runtime', {
      ...runtime,
      call: async (request: Parameters<typeof fallback>[0]) => {
        if (request.method === 'pairedServerAsks.list') {
          return { ok: true, result: { cards: [] } }
        }
        const params: { runId?: string } =
          typeof request.params === 'object' && request.params !== null ? request.params : {}
        if (request.method === 'bots.items.owner.list') {
          return { ok: true, result: { items: [], counts: {}, seenEventId: '' } }
        }
        if (request.method === 'bots.items.owner.opened') {
          return { ok: true, result: {} }
        }
        if (request.method === 'bots.chat.open') {
          return { ok: true, result: { sessionId: 'chat-cos' } }
        }
        if (request.method === 'automation.show') {
          if (scenario === 'deleted') {
            return { ok: false, error: { code: 'runtime_error', message: 'Automation not found.' } }
          }
          return {
            ok: true,
            result: {
              automation: shownDigest
            }
          }
        }
        if (request.method === 'automation.update') {
          return {
            ok: false,
            error: { code: 'runtime_error', message: 'Could not save changes. Try again.' }
          }
        }
        if (request.method === 'automation.runNow') {
          throw new Error('socket closed')
        }
        if (request.method === 'automation.runs') {
          return params.runId
            ? scenario === 'update'
              ? { ok: true, result: { runs: [] } }
              : { ok: true, result: { run: OLDER } }
            : {
                ok: true,
                result: {
                  runs:
                    scenario === 'running' || scenario === 'runningTerminal'
                      ? [
                          run('r-live', 'Manual run', 0, {
                            status: 'dispatched',
                            trigger: 'manual',
                            chatSessionId: 'chat-live',
                            ...(scenario === 'runningTerminal'
                              ? {
                                  sessionKind: 'terminal',
                                  chatSessionId: null,
                                  terminalPaneKey: 'pane-live',
                                  workspaceId: 'workspace-live'
                                }
                              : {})
                          })
                        ]
                      : scenario === 'failed'
                        ? [
                            run('r-failed', 'Scheduled run', 1, {
                              status: 'dispatch_failed',
                              error: 'The agent could not start.'
                            })
                          ]
                        : runs,
                  nextCursor: runs.length > 1 ? 'more' : null
                }
              }
        }
        return fallback(request)
      }
    })
    setBotAutomationPlace({
      owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
      bot: { hostId: fixtureCos.hostId, id: fixtureCos.id },
      automationId: digest.id,
      runId: scenario === 'update' ? 'unsupported-run' : runId,
      originRowKey: `auto:${digest.id}`,
      originScrollTop: null
    })
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

export const at220 = defineFixture({
  width: 220,
  store: botPanelPage(true, null),
  setup: setup(null),
  interact: settle,
  render: () => <BotPanelFrame />
})

export const at280 = defineFixture({
  width: 280,
  store: botPanelPage(true, null),
  setup: setup(null),
  interact: settle,
  render: () => <BotPanelFrame />
})

export const pinnedOlderRun280 = defineFixture({
  width: 280,
  store: botPanelPage(true, null),
  setup: setup('r-old'),
  interact: settle,
  render: () => <BotPanelFrame />
})

export const instructionsAndSetup280 = defineFixture({
  width: 280,
  store: botPanelPage(true, null),
  setup: setup(null, RUNS.slice(0, 1)),
  interact: settle,
  render: () => <BotPanelFrame />
})

function scenarioFixture(scenario: Scenario, width: number) {
  return defineFixture({
    width,
    store: botPanelPage(true, null),
    setup: setup(null, RUNS.slice(0, 1), scenario),
    interact: async (frame) => {
      await settle()
      const button = (text: string) =>
        [...frame.querySelectorAll<HTMLButtonElement>('button')].find(
          (node) => node.textContent?.trim() === text
        )
      if (scenario === 'unconfirmed' || scenario === 'unconfirmedSsh') {
        button('Run now')?.click()
      }
      if (scenario === 'homeFails') {
        useAppStore.setState({
          fetchFolderWorkspaces: async () => {
            throw new Error('Home unavailable')
          }
        })
        button('Edit in chat')?.click()
      }
      if (scenario === 'failed') {
        button('+1 more')?.click()
      }
      await settle()
      if (scenario !== 'homeFails') {
        const scroller = frame.querySelector<HTMLElement>('[data-bot-automation-screen]')
        if (scroller) {
          scroller.scrollTop = 0
        }
      }
    },
    render: () => <BotPanelFrame />
  })
}
export const failed220 = scenarioFixture('failed', 220)
export const failed280 = scenarioFixture('failed', 280)
export const running220 = scenarioFixture('running', 220)
export const running280 = scenarioFixture('running', 280)
export const runningTerminal280 = scenarioFixture('runningTerminal', 280)
export const unconfirmed220 = scenarioFixture('unconfirmed', 220)
export const unconfirmed280 = scenarioFixture('unconfirmed', 280)
export const unconfirmedSsh280 = scenarioFixture('unconfirmedSsh', 280)
export const offline220 = scenarioFixture('offline', 220)
export const offline280 = scenarioFixture('offline', 280)
export const update220 = scenarioFixture('update', 220)
export const update280 = scenarioFixture('update', 280)
export const homeFails220 = scenarioFixture('homeFails', 220)
export const homeFails280 = scenarioFixture('homeFails', 280)
export const deleted220 = scenarioFixture('deleted', 220)
export const deleted280 = scenarioFixture('deleted', 280)

export const menu280 = defineFixture({
  width: 280,
  store: botPanelPage(true, null),
  setup: setup(null, RUNS.slice(0, 1)),
  interact: async (frame) => {
    await settle()
    frame
      .querySelector<HTMLButtonElement>('[aria-label="More actions for Daily PR digest"]')
      ?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
    await settle()
  },
  render: () => <BotPanelFrame />
})

export const pinnedCollapsed280 = defineFixture({
  width: 280,
  store: botPanelPage(true, null),
  setup: setup('r-old'),
  interact: async (frame) => {
    await settle()
    frame.querySelector<HTMLButtonElement>('[data-automation-run-row="r-old"]')?.click()
    await settle()
  },
  render: () => <BotPanelFrame />
})
