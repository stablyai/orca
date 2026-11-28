// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { automationOwnerBot } from '../automations/hosts/automation-owner.test-fixture'
import type { AutomationRunsPage } from '../../../../shared/automations/history/automation-run'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { makeAutomation, makeRun } from '../automations/automations-page-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotAutomationPanel } from './BotAutomationPanel'
import { NativeChatAutomationCardDetails } from '../native-chat/NativeChatAutomationCardDetails'
import { AutomationDetailsController } from '../automations/details/automation-details-controller'
import { AUTOMATIONS_CHANGED_EVENT } from '../automations/events/automations-changed-window-event'
import { useAppStore } from '@/store'
import { setBotAutomationPlace } from './bot-automation-place'
import { openBotAutomation } from './bot-automation-open'
import type { Bot } from '../../../../shared/bot-types'
import { publishBots, setBotHostListing } from '@/lib/bot-catalog-snapshot'

const catalog = vi.hoisted(() => ({ bots: new Array<Bot>(), home: vi.fn() }))
vi.mock('@/lib/bot-catalog', () => ({
  useBotWebhooks: () => [],
  useBotsEnabled: () => true,
  useBots: () => catalog.bots,
  openBotHome: catalog.home
}))
vi.mock('@/lib/bot-host-views', () => ({ useBotHostOffline: () => false }))
vi.mock('./orca-cloud-signed-out', () => ({ useOrcaCloudSignedOut: () => false }))
vi.mock('./use-bot-host-label', () => ({ useBotHostLabel: () => 'This computer' }))
vi.mock('./AddConnectorDialog', () => ({ manageConnectors: vi.fn() }))
vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => null
}))
vi.mock('./ChatWorkersActivity', () => ({ ChatWorkersActivity: () => null }))
vi.mock('./BotGroupItemsPanel', () => ({ BotGroupItemsPanel: () => null }))
vi.mock('./settings-view/BotSettingsView', () => ({ BotSettingsView: () => null }))
vi.mock('./BotPanelHeader', () => ({ BotPanelHeader: () => null }))
vi.mock('./items/BotItemsSection', () => ({ BotItemsSection: () => null }))
vi.mock('./items/BotItemPane', () => ({ BotItemPane: () => null }))
vi.mock('./BotUpNextSection', () => ({ BotUpNextSection: () => null }))
vi.mock('./BotUpcomingSection', () => ({ BotUpcomingSection: () => null }))

const owner = { authority: { kind: 'desktop' }, selector: { kind: 'self' } } as const
const bot = automationOwnerBot('local', { name: 'Fixture Bot', folderWorkspaceId: 'home' })
const automation = makeAutomation({
  id: 'a',
  name: 'Fixture automation',
  bot: { botId: 'b', runsIn: 'new', resultsTo: 'none' }
})
const place = {
  bot,
  owner,
  automationId: 'a',
  runId: null,
  originRowKey: null,
  originScrollTop: null
}
function hold<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
let show = hold<{ automation: Automation }>()
let runs = hold<AutomationRunsPage>()
let showCall = 0
let runsCall = 0
const historyRun = makeRun({ id: 'history', automationId: 'a', title: 'Retained result' })
let newestRuns = [historyRun]
let refreshFailure: Error | null = null
beforeEach(() => {
  refreshFailure = null
  catalog.bots = [bot]
  newestRuns = [historyRun]
  setBotAutomationPlace(null)
  catalog.home.mockImplementation((selected: Bot) => {
    useAppStore.setState({
      activeWorktreeId: `folder:${selected.folderWorkspaceId}`,
      activeWorkspaceExecutionHostId: selected.hostId
    })
    return true
  })
  show = hold()
  runs = hold()
  showCall = 0
  runsCall = 0
  const call: typeof window.api.runtime.call = async ({ method, params }) => {
    const runId =
      params && typeof params === 'object' && 'runId' in params && typeof params.runId === 'string'
        ? params.runId
        : null
    if (method === 'automation.show') {
      return {
        id: 'fixture',
        _meta: { runtimeId: 'origin' },
        ok: true,
        result: await (++showCall === 1
          ? show.promise
          : refreshFailure
            ? Promise.reject(refreshFailure)
            : Promise.resolve({ automation }))
      }
    }
    if (method === 'automation.runs') {
      if (runId) {
        return {
          id: 'fixture',
          _meta: { runtimeId: 'origin' },
          ok: true,
          result: {
            run: makeRun({
              id: runId,
              automationId: 'a',
              title: runId === 'ack' ? 'Acknowledged run' : 'Pinned result'
            })
          }
        }
      }
      return {
        id: 'fixture',
        _meta: { runtimeId: 'origin' },
        ok: true,
        result: await (++runsCall === 1
          ? runs.promise
          : Promise.resolve({ runs: newestRuns, nextCursor: null }))
      }
    }
    throw new Error(`Unexpected fixture RPC: ${method}`)
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { runtime: { call } }
  })
})
afterEach(() => {
  cleanup()
  setBotAutomationPlace(null)
})
function Panel({ runId = null }: { runId?: string | null }) {
  const [opened, setOpened] = useState(true)
  return (
    <TooltipProvider>
      {opened ? (
        <BotAutomationPanel bot={bot} place={{ ...place, runId }} onBack={() => setOpened(false)} />
      ) : (
        <button onClick={() => setOpened(true)}>Reopen</button>
      )}
    </TooltipProvider>
  )
}

it.each(['panel', 'Saved'] as const)(
  'keeps successful history and separate retries on the %s root in both definition-failure response orders',
  async (root) => {
    for (const definitionFirst of [true, false]) {
      show = hold()
      runs = hold()
      showCall = 0
      runsCall = 0
      const view = render(
        root === 'panel' ? (
          <Panel />
        ) : (
          <NativeChatAutomationCardDetails
            automation={automation}
            environmentId={null}
            onEditInChat={null}
          />
        )
      )
      if (definitionFirst) {
        await act(async () => {
          show.reject(new Error('offline'))
        })
      }
      await act(async () => {
        runs.resolve({ runs: [historyRun], nextCursor: null })
      })
      expect(await screen.findByRole('button', { name: /Retained result/ })).toBeTruthy()
      if (!definitionFirst) {
        await act(async () => {
          show.reject(new Error('offline'))
        })
      }
      expect(screen.getByRole('button', { name: /Retained result/ })).toBeTruthy()
      expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0)
      expect(screen.queryByText('This automation was deleted')).toBeNull()
      view.unmount()
    }
  }
)

it('collapses and re-expands the pinned older run without unpinning or moving keyboard focus', async () => {
  render(<Panel runId="older" />)
  await act(async () => {
    show.resolve({ automation })
    runs.resolve({ runs: [historyRun], nextCursor: null })
  })
  const row = await screen.findByRole('button', { name: /Pinned result/ })
  row.focus()
  expect(row.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(row, { detail: 0 })
  expect(document.activeElement).toBe(row)
  expect(row.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('button', { name: /Pinned result/ })).toBe(row)
  fireEvent.click(row, { detail: 0 })
  expect(document.activeElement).toBe(row)
  expect(row.getAttribute('aria-expanded')).toBe('true')
})

it.each(['panel', 'Saved'] as const)(
  'keeps good settings and a history retry on the %s root in either response order',
  async (root) => {
    for (const historyFirst of [true, false]) {
      show = hold()
      runs = hold()
      showCall = 0
      runsCall = 0
      const view = render(
        root === 'panel' ? (
          <Panel />
        ) : (
          <NativeChatAutomationCardDetails
            automation={automation}
            environmentId={null}
            onEditInChat={null}
          />
        )
      )
      if (historyFirst) {
        await act(async () => {
          runs.reject(new Error('history offline'))
        })
      }
      await act(async () => {
        show.resolve({ automation })
      })
      if (!historyFirst) {
        await act(async () => {
          runs.reject(new Error('history offline'))
        })
      }
      expect(screen.getByText('When')).toBeTruthy()
      expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0)
      view.unmount()
    }
  }
)

it('keeps the newest-history retry visible beside a successfully pinned older run', async () => {
  render(<Panel runId="older" />)
  await act(async () => {
    show.resolve({ automation })
    runs.reject(new Error('newest unavailable'))
  })
  expect(await screen.findByRole('button', { name: /Pinned result/ })).toBeTruthy()
  const retry = screen.getByRole('button', { name: 'Retry' })
  fireEvent.click(retry)
  expect(await screen.findByRole('button', { name: /Retained result/ })).toBeTruthy()
})

it.each(['panel', 'Saved'] as const)(
  'shows capacity recovery rather than empty history at the %s root',
  async (root) => {
    const resident = new AutomationDetailsController(owner, 'resident', 5, {
      showAutomation: async () => makeAutomation({ id: 'resident' }),
      listRunsPage: async () => ({
        runs: [
          makeRun({
            outputSnapshot: {
              format: 'plain_text',
              content: 'x'.repeat(10 * 1024 * 1024),
              capturedAt: 1,
              truncated: false
            }
          })
        ],
        nextCursor: null
      }),
      readRun: async () => ({ kind: 'run-missing' }),
      evaluateOwner: () => ({ status: 'same', owner })
    })
    try {
      await act(async () => resident.start())
      render(
        root === 'panel' ? (
          <Panel />
        ) : (
          <NativeChatAutomationCardDetails
            automation={automation}
            environmentId={null}
            onEditInChat={null}
          />
        )
      )
      await act(async () => {
        show.resolve({ automation })
        runs.resolve({
          runs: [
            makeRun({
              ...historyRun,
              outputSnapshot: {
                format: 'plain_text',
                content: 'x'.repeat(3 * 1024 * 1024),
                capturedAt: 1,
                truncated: false
              }
            })
          ],
          nextCursor: null
        })
      })
      expect(screen.queryByText('No runs yet')).toBeNull()
      const retry = screen.getByRole('button', { name: 'Retry' })
      resident.dispose()
      fireEvent.click(retry)
      expect(await screen.findByRole('button', { name: /Retained result/ })).toBeTruthy()
    } finally {
      resident.dispose()
    }
  }
)

it('preserves the keyboard-focused pinned row through recent admission and its page handoff', async () => {
  render(<Panel runId="older" />)
  await act(async () => {
    show.resolve({ automation })
    runs.resolve({ runs: [historyRun], nextCursor: null })
  })
  const row = await screen.findByRole('button', { name: /Pinned result/ })
  row.focus()
  newestRuns = [makeRun({ id: 'older', automationId: 'a', title: 'Pinned result' }), historyRun]
  await act(async () => {
    window.dispatchEvent(new CustomEvent(AUTOMATIONS_CHANGED_EVENT))
  })
  expect(screen.getByRole('button', { name: /Pinned result/ })).toBe(row)
  expect(document.activeElement).toBe(row)
  expect(row.getAttribute('aria-expanded')).toBe('true')
  fireEvent.pointerDown(screen.getByRole('button', { name: /More actions/ }), {
    button: 0,
    ctrlKey: false
  })
  fireEvent.click(await screen.findByRole('menuitem', { name: /Open in Automations/ }))
  expect(useAppStore.getState().pendingAutomationRunNavigation?.runId).toBe('older')
})

it('keeps a stale definition readable without any panel action or draft path', async () => {
  render(<Panel />)
  await act(async () => {
    show.resolve({ automation })
    runs.resolve({ runs: [historyRun], nextCursor: null })
  })
  refreshFailure = new Error('settings offline')
  await act(async () => {
    window.dispatchEvent(new CustomEvent(AUTOMATIONS_CHANGED_EVENT))
  })
  expect(screen.getByRole('region', { name: 'Fixture automation' })).toBeTruthy()
  expect(screen.getByText("Couldn't read the latest settings.")).toBeTruthy()
  expect(
    screen.queryByRole('button', { name: /Run now|Run again|Edit in chat|Check again|Dismiss/ })
  ).toBeNull()
  expect(screen.queryByRole('switch')).toBeNull()
})

it.each([true, false])(
  'resolves the real Activity root on the selected host in both catalog orders (%s)',
  async (remoteFirst) => {
    const { default: BotActivityPanel } = await import('./BotActivityPanel')
    const remote = automationOwnerBot('runtime:e', {
      folderWorkspaceId: 'home',
      name: 'Remote owner'
    })
    const twin = { ...bot, name: 'Local twin' }
    catalog.bots = remoteFirst ? [remote, twin] : [twin, remote]
    setBotHostListing({
      hosts: [
        { hostId: 'local', state: 'live' },
        { hostId: 'runtime:e', state: 'live' }
      ],
      updateNeeded: []
    })
    publishBots([twin], { threadReplies: false, webhooks: false })
    publishBots([remote], { threadReplies: false, webhooks: false }, 'runtime:e')
    const { replaceRuntimeEnvironmentRevisions } =
      await import('@/runtime/rpc/environment-revisions/runtime-environment-revision')
    const { automationOwnerEnvironment } =
      await import('../automations/hosts/automation-owner.test-fixture')
    const { createCompatibleRuntimeStatusResponse } =
      await import('@/runtime/rpc/testing/runtime-compatibility-test-fixture')
    const environment = automationOwnerEnvironment('e', 1)
    replaceRuntimeEnvironmentRevisions([environment])
    useAppStore.setState({ runtimeEnvironments: [environment] })
    window.api.runtimeEnvironments = {
      ...window.api.runtimeEnvironments,
      call: async (request) =>
        request.method === 'status.get'
          ? createCompatibleRuntimeStatusResponse('origin')
          : window.api.runtime.call({ method: request.method, params: request.params })
    }
    openBotAutomation({
      bot: remote,
      owner: {
        authority: { kind: 'runtime', environmentId: 'e', pairingRevision: 1 },
        selector: { kind: 'self' }
      },
      automationId: 'a',
      runId: null
    })
    render(
      <TooltipProvider>
        <BotActivityPanel />
      </TooltipProvider>
    )
    await act(async () => {
      show.resolve({ automation })
      runs.resolve({ runs: [], nextCursor: null })
    })
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('runtime:e')
    expect(screen.getByText('Remote owner')).toBeTruthy()
    expect(await screen.findByRole('region', { name: 'Fixture automation' })).toBeTruthy()
    expect(screen.queryByText('Local twin')).toBeNull()
  }
)

it('opens the general Automations page from unknown-origin recovery without forwarding stale IDs', async () => {
  const { useAppStore } = await import('@/store')
  useAppStore
    .getState()
    .setPendingAutomationRunNavigation({ automationId: 'stale', runId: 'stale' })
  render(
    <TooltipProvider>
      <BotAutomationPanel bot={bot} place={{ ...place, owner: undefined }} onBack={() => {}} />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Open in Automations' }))
  expect(useAppStore.getState().pendingAutomationRunNavigation).toBeNull()
  expect(useAppStore.getState().activeView).toBe('automations')
})
