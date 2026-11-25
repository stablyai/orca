// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  automationOwnerBot,
  automationOwnerEnvironment
} from '../automations/hosts/automation-owner.test-fixture'
import type {
  AutomationRun,
  AutomationRunsPage
} from '../../../../shared/automations/history/automation-run'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { makeAutomation, makeRun } from '../automations/automations-page-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotAutomationPanel } from './BotAutomationPanel'
import { NativeChatAutomationCardDetails } from '../native-chat/NativeChatAutomationCardDetails'
import { automationRunAttempts } from '../automations/details/automation-run-attempts'

vi.mock('@/lib/bot-catalog', () => ({ useBotWebhooks: () => [], openBotHomeTab: vi.fn() }))
vi.mock('@/lib/bot-host-views', () => ({ useBotHostOffline: () => false }))
vi.mock('./orca-cloud-signed-out', () => ({ useOrcaCloudSignedOut: () => false }))
vi.mock('./use-bot-host-label', () => ({ useBotHostLabel: () => 'This computer' }))
vi.mock('./AddConnectorDialog', () => ({ manageConnectors: vi.fn() }))
vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => null
}))

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
let attempt = hold<{ run: AutomationRun }>()
let showCall = 0
let runsCall = 0
let runCalls = 0
const historyRun = makeRun({ id: 'history', automationId: 'a', title: 'Retained result' })
beforeEach(() => {
  show = hold()
  runs = hold()
  attempt = hold()
  showCall = 0
  runsCall = 0
  runCalls = 0
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
        result: await (++showCall === 1 ? show.promise : Promise.resolve({ automation }))
      }
    }
    if (method === 'automation.runNow') {
      runCalls++
      return {
        id: 'fixture',
        _meta: { runtimeId: 'origin' },
        ok: true,
        result: await attempt.promise
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
          : Promise.resolve({ runs: [historyRun], nextCursor: null }))
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
  automationRunAttempts.retire(owner, 'a')
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

it.each(['Back', 'Escape'] as const)(
  'keeps a held Run now in custody across %s and remount, then exposes lost-reply recovery',
  async (navigation) => {
    render(<Panel />)
    await act(async () => {
      show.resolve({ automation })
      runs.resolve({ runs: [], nextCursor: null })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    await waitFor(() => expect(runCalls).toBe(1))
    if (navigation === 'Back') {
      fireEvent.click(screen.getByRole('button', { name: 'Back to Activity' }))
    } else {
      fireEvent.keyDown(screen.getByRole('region', { name: 'Fixture automation' }), {
        key: 'Escape'
      })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    const pending = await screen.findByRole('button', { name: /Starting/ })
    fireEvent.click(pending)
    expect(runCalls).toBe(1)
    await act(async () => {
      attempt.reject(new Error('reply lost'))
    })
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Activity' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeTruthy()
    expect(runCalls).toBe(1)
  }
)

it('publishes a successful held reply into the remounted panel without starting another request', async () => {
  render(<Panel />)
  await act(async () => {
    show.resolve({ automation })
    runs.resolve({ runs: [], nextCursor: null })
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
  await waitFor(() => expect(runCalls).toBe(1))
  fireEvent.click(screen.getByRole('button', { name: 'Back to Activity' }))
  await act(async () => {
    attempt.resolve({
      run: makeRun({
        id: 'ack',
        automationId: 'a',
        title: 'Acknowledged run',
        status: 'dispatched'
      })
    })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
  expect(await screen.findByRole('button', { name: /Acknowledged run/ })).toBeTruthy()
  expect(runCalls).toBe(1)
})

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

it('keeps unknown-attempt recovery visible ahead of an earlier dispatch failure', async () => {
  render(<Panel />)
  await act(async () => {
    show.resolve({ automation })
    runs.resolve({
      runs: [makeRun({ ...historyRun, status: 'dispatch_failed', error: 'Earlier failure' })],
      nextCursor: null
    })
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
  await act(async () => {
    attempt.reject(new Error('reply lost'))
  })
  expect(await screen.findByRole('button', { name: 'Check again' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
})

it('hides Edit in chat for a foreign definition on the actual panel root', async () => {
  render(<Panel />)
  await act(async () => {
    show.resolve({ automation: { ...automation, bot: { ...automation.bot!, botId: 'other' } } })
    runs.resolve({ runs: [], nextCursor: null })
  })
  expect(screen.queryByRole('button', { name: 'Edit in chat' })).toBeNull()
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
      expect(screen.getByRole('button', { name: 'Run now' })).toBeTruthy()
      expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0)
      view.unmount()
    }
  }
)

it('hides Edit in chat while the captured computer is being checked, and distinguishes retirement from deletion', async () => {
  const { replaceRuntimeEnvironmentRevisions } =
    await import('@/runtime/rpc/environment-revisions/runtime-environment-revision')
  const { createCompatibleRuntimeStatusResponse } =
    await import('@/runtime/rpc/testing/runtime-compatibility-test-fixture')
  const { useAppStore } = await import('@/store')
  const environment = automationOwnerEnvironment('check-host', 1)
  useAppStore.setState({ runtimeEnvironments: [environment] })
  replaceRuntimeEnvironmentRevisions([environment])
  const local = window.api.runtime.call
  window.api.runtimeEnvironments = {
    ...window.api.runtimeEnvironments,
    call: async (request) =>
      request.method === 'status.get'
        ? createCompatibleRuntimeStatusResponse('origin')
        : local({ method: request.method, params: request.params })
  }
  const remoteOwner = {
    authority: { kind: 'runtime', environmentId: 'check-host', pairingRevision: 1 },
    selector: { kind: 'self' }
  } as const
  const remoteBot = automationOwnerBot('runtime:check-host', { name: bot.name })
  render(
    <TooltipProvider>
      <BotAutomationPanel
        bot={remoteBot}
        place={{ ...place, bot: remoteBot, owner: remoteOwner }}
        onBack={() => {}}
      />
    </TooltipProvider>
  )
  await act(async () => {
    show.resolve({ automation })
    runs.resolve({ runs: [], nextCursor: null })
  })
  expect(await screen.findByRole('button', { name: 'Edit in chat' })).toBeTruthy()
  await act(async () => {
    replaceRuntimeEnvironmentRevisions([{ ...environment, pairingRevision: 2 }], {
      retired: [],
      sameHost: [],
      pending: [{ id: environment.id, fromRevision: 1 }]
    })
  })
  expect(screen.queryByRole('button', { name: 'Edit in chat' })).toBeNull()
  expect(screen.getByText(/Checking Fixture Bot/)).toBeTruthy()
  await act(async () => {
    replaceRuntimeEnvironmentRevisions([{ ...environment, pairingRevision: 2 }], {
      retired: [environment.id],
      sameHost: []
    })
  })
  expect(screen.getByText(/Fixture Bot's computer changed/)).toBeTruthy()
  expect(screen.queryByText('This automation was deleted')).toBeNull()
})

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
