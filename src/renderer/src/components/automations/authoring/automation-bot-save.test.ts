import { describe, expect, it, vi } from 'vitest'
import type { AutomationBotTarget } from '../../../../../shared/automation-bot-target'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import type { AutomationDraft } from './AutomationEditorDialog'
import type { AutomationSaveContext } from './automation-save-context'
import type * as BotCatalog from '@/lib/bot-catalog'
import { botHostUnavailableNotice, saveBotAutomation } from './automation-bot-save'
import { automationCreateHostStableKey } from './automation-create-destination'

const mocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('./automation-orca-save-operations', () => ({
  createAutomationOnDestination: mocks.create,
  saveExistingAutomation: vi.fn()
}))
vi.mock('./automation-save-completion', () => ({ completeAutomationSave: vi.fn() }))
// The same bot id listed on two hosts, the local one first.
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof BotCatalog>()),
  readBots: () => [
    { id: 'bot-1', hostId: 'local' },
    { id: 'bot-1', hostId: 'runtime:env-1' }
  ]
}))

function serverEntry(overrides: Partial<AutomationHostCatalogEntry>): AutomationHostCatalogEntry {
  return {
    stableRef: {
      authority: { kind: 'runtime', environmentId: 'env-1' },
      selector: { kind: 'self' }
    },
    owner: null,
    stableKey: 'runtime:env-1|self',
    label: 'Studio',
    authorityLabel: 'Studio',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

describe('saveBotAutomation', () => {
  it("creates on the picked bot's host, not the first host listing its id", async () => {
    mocks.create.mockResolvedValue({ ok: false, notice: { message: 'x' } })
    const local = serverEntry({
      stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
      stableKey: automationCreateHostStableKey('local') ?? '',
      owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
    })
    const server = serverEntry({
      stableKey: automationCreateHostStableKey('runtime:env-1') ?? '',
      owner: {
        authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 1 },
        selector: { kind: 'self' }
      }
    })
    const bot: AutomationBotTarget = { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }
    const draft: AutomationDraft = {
      name: 'n',
      prompt: 'p',
      agentId: 'claude',
      extraAgentArgs: '',
      bot,
      botHostId: 'runtime:env-1',
      projectId: '',
      workspaceMode: 'existing',
      workspaceId: '',
      baseBranch: '',
      reuseSession: false,
      precheckCommand: '',
      precheckTimeoutSeconds: '60',
      preset: 'weekdays',
      time: '09:00',
      dayOfWeek: '1',
      customSchedule: '',
      missedRunGraceMinutes: '720',
      savedSchedule: null,
      scheduleWarning: null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a create reads only these parts of the page state.
    const context = {
      local: {
        draft,
        editingAutomationId: null,
        editingRowKey: null,
        setEditorNotice: vi.fn(),
        setEditorNoticeHost: vi.fn()
      },
      destination: {
        createDestination: { control: { entries: [local, server] } },
        invalidateWrittenHost: vi.fn()
      }
    } as unknown as AutomationSaveContext
    await saveBotAutomation(context, bot, { hour: 9, minute: 0, now: 0 })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create.mock.calls[0][0]).toEqual({
      kind: 'runtime',
      environmentId: 'env-1',
      pairingRevision: 1
    })
  })
})

describe('botHostUnavailableNotice', () => {
  it('asks for a server update, not Retry, when the bot server is too old', () => {
    const notice = botHostUnavailableNotice(serverEntry({ querySupport: 'incompatible' }))
    expect(notice.recovery).toBe('update-server')
    expect(notice.message).toBe(
      'Update the Orca server on Studio so its bots can have automations.'
    )
  })

  it('asks for a server update when the server lists automations without host scoping', () => {
    const notice = botHostUnavailableNotice(
      serverEntry({ querySupport: 'legacy-unscoped', scopeGap: 'authority-unscoped' })
    )
    expect(notice.recovery).toBe('update-server')
  })

  it('keeps Retry while the bot host is not in the catalog yet', () => {
    expect(botHostUnavailableNotice(null).recovery).toBe('retry')
  })

  it('offers Reconnect when the bot server is unreachable', () => {
    expect(botHostUnavailableNotice(serverEntry({ authorityHealth: 'unavailable' })).recovery).toBe(
      'reconnect'
    )
  })
})
