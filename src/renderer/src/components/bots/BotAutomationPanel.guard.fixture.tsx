// A bot on a paired computer, by what that computer said about the write-time save guard: still
// asking, answered without it (with a run going), and a save it refused. Synthetic data only.
import { TooltipProvider } from '@/components/ui/tooltip'
import { publishBots, setBotHostListing } from '@/lib/bot-catalog-snapshot'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { fixtureCos } from '../../component-fixtures/fixture-bot-panel'
import type { Bot } from '../../../../shared/bot-types'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import { AUTOMATION_UPDATE_GUARD_RUNTIME_CAPABILITY } from '../../../../shared/automations/automation-runtime-capabilities'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { makeAutomation, makeRun } from '../automations/automations-page-fixtures'
import { BotAutomationPanel } from './BotAutomationPanel'
import { clearRetainedBotAutomationDrafts } from './bot-automation-drafts'

const ENV = 'studio'
const HOST = `runtime:${ENV}` as const
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bots type their host as this computer; a paired one is stamped at runtime the same way.
const bot = { ...fixtureCos, hostId: HOST } as unknown as Bot

const now = Date.now()
const HOUR = 3_600_000

const digest = makeAutomation({
  id: 'a-digest',
  name: 'Daily PR digest',
  prompt: 'Every weekday morning, summarize the open pull requests and post the digest.',
  rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
  dtstart: now - 30 * 86_400_000,
  nextRunAt: new Date(now + 86_400_000).setHours(9, 0, 0, 0),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  workspaceMode: 'existing',
  agentId: 'claude',
  bot: { botId: bot.id, runsIn: 'new', resultsTo: { channel: '#eng-updates' } },
  on: []
})

const run = (id: string, hoursAgo: number, patch: Partial<AutomationRun> = {}): AutomationRun =>
  makeRun({
    id,
    automationId: digest.id,
    title: 'Scheduled run',
    createdAt: now - hoursAgo * HOUR,
    startedAt: now - hoursAgo * HOUR,
    sessionKind: 'chat',
    chatSessionId: `chat-${id}`,
    ...patch
  })

function environment(): PublicKnownRuntimeEnvironment & { pairingRevision: number } {
  return {
    id: ENV,
    name: 'Studio Mac',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [],
    preferredEndpointId: ENV,
    pairingRevision: 1
  }
}

/** `pending`: the guard question is never answered. `old`: answered without the guard, a run going.
 *  `refused`: the first answer never came, so Edit stays on; Save then finds an Orca without it. */
type Scenario = 'pending' | 'old' | 'refused'

function status(withGuard: boolean): unknown {
  const { result } = createCompatibleRuntimeStatusResponse(ENV)
  return {
    ...result,
    capabilities: withGuard
      ? result.capabilities
      : result.capabilities?.filter((cap) => cap !== AUTOMATION_UPDATE_GUARD_RUNTIME_CAPABILITY)
  }
}

function setup(scenario: Scenario): () => void {
  return () => {
    clearRetainedBotAutomationDrafts()
    replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 1, pairingRevision: 1 }])
    setBotHostListing({ hosts: [{ hostId: HOST, state: 'live' }], updateNeeded: [] })
    publishBots([bot], { threadReplies: false, webhooks: true }, HOST)
    const runs =
      scenario === 'old'
        ? [run('r-live', 0, { status: 'dispatched' }), run('r1', 26)]
        : [run('r1', 2)]
    let guardAsks = 0
    const environments: unknown = window.api.runtimeEnvironments
    Reflect.set(window.api, 'runtimeEnvironments', {
      ...(typeof environments === 'object' ? environments : {}),
      call: async ({ method }: { method: string }) => {
        if (method === 'status.get') {
          guardAsks += 1
          if (scenario === 'pending' && guardAsks > 1) {
            return await new Promise(() => {})
          }
          if (scenario === 'refused' && guardAsks === 2) {
            return { ok: false, error: { code: 'runtime_unavailable', message: ENV } }
          }
          return { ok: true, result: status(scenario === 'pending') }
        }
        if (method === 'automation.show') {
          return { ok: true, result: { automation: digest } }
        }
        if (method === 'automation.runs') {
          return { ok: true, result: { runs, nextCursor: null } }
        }
        return { ok: false, error: { code: 'runtime_error', message: method } }
      }
    })
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250))

function guardFixture(scenario: Scenario, width: number) {
  return defineFixture({
    width,
    store: { runtimeEnvironments: [environment()] },
    setup: setup(scenario),
    interact: async (frame) => {
      await settle()
      if (scenario !== 'refused') {
        return
      }
      frame.querySelector<HTMLButtonElement>('[aria-label="Edit where results go"]')?.click()
      await settle()
      const input = frame.querySelector<HTMLInputElement>('[aria-label="Channel"]')
      if (input) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          '#changed-channel'
        )
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await settle()
      ;[...frame.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent?.trim() === 'Save')
        ?.click()
      await settle()
    },
    render: () => (
      <TooltipProvider>
        <div className="flex min-h-[640px] flex-col border-l border-border bg-sidebar">
          <BotAutomationPanel
            bot={bot}
            place={{
              bot: { hostId: HOST, id: bot.id },
              automationId: digest.id,
              runId: null,
              originRowKey: null,
              originScrollTop: null
            }}
            onBack={() => {}}
            onDeleted={() => {}}
          />
        </div>
      </TooltipProvider>
    )
  })
}

export const guardPending280 = guardFixture('pending', 280)
export const guardOldHostRunning220 = guardFixture('old', 220)
export const guardOldHostRunning280 = guardFixture('old', 280)
export const guardRefusedSave280 = guardFixture('refused', 280)
