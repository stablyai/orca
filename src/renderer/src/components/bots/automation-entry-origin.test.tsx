import {
  automationOwnerBot,
  automationOwnerEnvironment
} from '../automations/hosts/automation-owner.test-fixture'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { publishBots, setBotHostListing } from '@/lib/bot-catalog-snapshot'
import { readBotHostDefault } from './bot-host-read-default'
import { reuseEqualJson } from '../../../../shared/reuse-equal-json'
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import type { BotItemLinkView } from '../../../../shared/bots/bot-items'
import { makeAutomation } from '../automations/automations-page-fixtures'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { botItemWorkerRow } from '../../../../shared/bots/bot-item-link-rows'
import {
  captureBotAutomationOwners,
  captureBotRecordOwner,
  inheritBotRecordOwner
} from '../automations/hosts/bot-automation-row-owner'
import {
  captureNativeChatVisualOwner,
  NativeChatVisualOwnerContext
} from '../native-chat/media/visuals/native-chat-visual-owner'
import { NativeChatAutomationResultRow } from '../native-chat/automation-run/NativeChatAutomationResultRow'
import { NativeChatAutomationRunBody } from '../native-chat/automation-run/NativeChatAutomationRunBody'
import { NativeChatWaitRow } from '../native-chat/automation-run/NativeChatWaitRow'
import { useAutomationRunWording } from '../native-chat/automation-run/automation-run-wording'
import { openChat } from './BotChatTreeGroup'
import { botChatTreeWorkerOpen } from './BotChatTreeWorkerRow'
import { readBotAutomationPlace, setBotAutomationPlace } from './bot-automation-place'

const host = vi.hoisted(() => ({
  revision: 4,
  continued: false,
  home: vi.fn(),
  pane: vi.fn(),
  dispatch: vi.fn(),
  read: vi.fn(),
  bots: new Array<Bot>()
}))
vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => null
}))
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => host.bots,
  useBotsEnabled: () => true,
  openBotHome: host.home,
  openBotHomeTab: vi.fn()
}))
vi.mock('./bot-read-authority', () => ({ callBotRpcWithAuthority: host.read }))
vi.mock('@/lib/open-orchestration-worker', () => ({
  revealWorkerPane: host.pane,
  openOrchestrationWorker: host.dispatch
}))
vi.mock('../native-chat/markdown/NativeChatMarkdown', () => ({ NativeChatMarkdown: () => null }))
vi.mock('../native-chat/markdown/code/NativeChatCodeBlock', () => ({
  NativeChatCodeBlock: () => null
}))
vi.mock('./use-bot-activity', () => ({
  useBotActivity: () => ({
    automations: [{ automation: definition }],
    waits: [{ automation: definition }]
  }),
  useBotActivityRead: () => null
}))

const bot = automationOwnerBot('runtime:e')
const twin = automationOwnerBot('local', { name: 'Twin' })
const definition = makeAutomation({
  id: 'a',
  bot: { botId: 'b', runsIn: 'new', resultsTo: 'none' }
})
const worker: BotChatTreeWorker = {
  key: 'run',
  title: 'Run',
  state: 'done',
  startedAt: 1,
  run: { automationId: 'a', runId: 'r' }
}
const chat: BotChatTreeChat = {
  chatId: 'c',
  title: 'Run',
  origin: 'automation',
  live: 'idle',
  lastActiveAt: 1,
  unread: false,
  closed: false,
  running: [],
  runningTotal: 0,
  finished: [],
  finishedTotal: 0,
  failedTotal: 0,
  run: { automationId: 'a', runId: 'r' }
}
function revision(value: number) {
  host.revision = value
  replaceRuntimeEnvironmentRevisions([{ id: 'e', createdAt: 1, pairingRevision: value }], {
    retired: ['e'],
    sameHost: []
  })
  useAppStore.setState({
    runtimeEnvironments: [automationOwnerEnvironment('e', value)]
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  host.continued = false
  host.bots = [twin, bot]
  setBotHostListing({
    hosts: [
      { hostId: 'local', state: 'live' },
      { hostId: 'runtime:e', state: 'live' }
    ],
    updateNeeded: []
  })
  publishBots([twin], { threadReplies: false, webhooks: true })
  publishBots([bot], { threadReplies: false, webhooks: true }, 'runtime:e')
  host.home.mockReturnValue(true)
  revision(4)
  setBotAutomationPlace(null)
  useAppStore.getState().setPendingAutomationRunNavigation(null)
})
afterEach(() => {
  cleanup()
  setBotAutomationPlace(null)
})
function RunBody() {
  const wording = useAutomationRunWording(definition)
  return (
    <NativeChatAutomationRunBody
      messageId="m"
      run={{ runId: 'r', automation: definition, trigger: 'manual', instructionsLength: 0 }}
      state="not-started"
      instructions=""
      facts=""
      wording={wording}
      findQuery=""
    />
  )
}

it.each(['result', 'run', 'wait'] as const)(
  'carries the captured transcript owner through the real %s caller, including a same-workspace twin',
  (surface) => {
    const owner = captureNativeChatVisualOwner(
      { kind: 'environment', environmentId: 'e' },
      'chat',
      'folder:same'
    )
    const view = render(
      <TooltipProvider>
        <NativeChatVisualOwnerContext value={owner}>
          {surface === 'result' ? (
            <NativeChatAutomationResultRow
              note={{
                automationId: 'a',
                automationName: 'Digest',
                botName: 'Owner Bot',
                runId: 'r',
                trigger: 'schedule',
                outcome: 'finished',
                result: 'Result',
                at: 1
              }}
            />
          ) : surface === 'run' ? (
            <RunBody />
          ) : (
            <NativeChatWaitRow messageId="m" automation={definition} once={{}} timestamp={1} />
          )}
        </NativeChatVisualOwnerContext>
      </TooltipProvider>
    )

    if (surface !== 'run') {
      fireEvent.click(screen.getAllByRole('button')[0])
    }
    const open = screen.getByRole('button', {
      name: surface === 'result' ? 'Open run' : 'Open automation'
    })
    fireEvent.click(open)
    expect(readBotAutomationPlace()?.bot).toEqual({ hostId: 'runtime:e', id: 'b' })
    setBotAutomationPlace(null)
    revision(5)
    fireEvent.click(open)
    expect(readBotAutomationPlace()).toBeNull()
    host.continued = true
    replaceRuntimeEnvironmentRevisions([{ id: 'e', createdAt: 1, pairingRevision: 5 }], {
      retired: [],
      sameHost: [{ id: 'e', fromRevision: 4, toRevision: 5 }]
    })
    fireEvent.click(open)
    expect(readBotAutomationPlace()?.owner?.authority).toMatchObject({ pairingRevision: 5 })
    view.unmount()
  }
)

it('keeps old and replacement row IDs independently qualified after an equal-data publication', () => {
  const capture = captureBotAutomationOwners(bot)
  const first = capture({
    workers: [],
    inProgress: [],
    completed: [],
    automations: [{ key: 'a', automation: definition, failing: false }],
    waits: []
  })
  const qualify = captureBotRecordOwner(bot)
  const oldChat = qualify(chat)
  const oldWorker = qualify(worker)
  revision(5)
  const replacement = captureBotRecordOwner(bot)
  const freshChat = reuseEqualJson(oldChat, replacement(oldChat))
  const freshWorker = reuseEqualJson(oldWorker, replacement(oldWorker))
  openChat(bot, oldChat)
  botChatTreeWorkerOpen(bot, oldWorker)?.()
  expect(readBotAutomationPlace()).toBeNull()
  openChat(bot, freshChat)
  expect(readBotAutomationPlace()?.owner?.authority).toMatchObject({ pairingRevision: 5 })
  setBotAutomationPlace(null)
  botChatTreeWorkerOpen(bot, freshWorker)?.()
  expect(readBotAutomationPlace()?.owner?.authority).toMatchObject({ pairingRevision: 5 })
  expect(first.automations[0].automation).not.toBe(definition)
})

it('fences the real terminal fast path and derived item workers, including unknown origin', async () => {
  const qualify = captureBotRecordOwner(bot)
  const terminal = qualify({ ...chat, run: { ...chat.run!, worktreeId: 'same', paneKey: 'p' } })
  const link = qualify({
    kind: 'dispatch',
    ref: 'dispatch',
    state: 'completed',
    startedAt: 1,
    settledAt: 2,
    title: 'Linked worker',
    host: 'runtime:e',
    latest: null,
    report: null,
    pr: null
  } satisfies Extract<BotItemLinkView, { kind: 'dispatch' }>)
  const derived = inheritBotRecordOwner(link, botItemWorkerRow(link))
  revision(5)
  openChat(bot, terminal)
  botChatTreeWorkerOpen(bot, derived)?.()
  openChat(bot, { ...chat, run: { ...chat.run!, worktreeId: 'same', paneKey: 'p' } })
  await Promise.resolve()
  expect(host.pane).not.toHaveBeenCalled()
  expect(host.dispatch).not.toHaveBeenCalled()
  host.continued = true
  replaceRuntimeEnvironmentRevisions([{ id: 'e', createdAt: 1, pairingRevision: 5 }], {
    retired: [],
    sameHost: [{ id: 'e', fromRevision: 4, toRevision: 5 }]
  })
  openChat(bot, terminal)
  await Promise.resolve()
  expect(host.pane.mock.calls).toEqual([['same', 'p', 'runtime:e']])
  setBotAutomationPlace(null)
  botChatTreeWorkerOpen(bot, worker)?.()
  expect(readBotAutomationPlace()).toBeNull()
})

it('qualifies actual host-read publications before structural sharing without retagging a retained callback', async () => {
  const wire: BotActivity = {
    workers: [],
    inProgress: [],
    completed: [],
    automations: [{ key: 'a', automation: definition, failing: false }],
    waits: []
  }
  host.read.mockResolvedValue({
    result: wire,
    authority: { kind: 'environment', environmentId: 'e', pairingRevision: 4 }
  })
  const first = await readBotHostDefault(
    bot,
    'bots.activity',
    null,
    () => true,
    (value) => value,
    captureBotAutomationOwners
  )
  const equal = await readBotHostDefault(
    bot,
    'bots.activity',
    first,
    () => true,
    (value) => value,
    captureBotAutomationOwners
  )
  expect(equal).toBe(first)
  revision(5)
  const replacement = await readBotHostDefault(
    bot,
    'bots.activity',
    first,
    () => true,
    (value) => value,
    captureBotAutomationOwners
  )
  expect(replacement).not.toBe(first)
  const { openBotAutomation } = await import('./bot-automation-open')
  const { botAutomationRowOwner } = await import('../automations/hosts/bot-automation-row-owner')
  openBotAutomation({
    bot,
    owner: botAutomationRowOwner(first!.automations[0].automation),
    automationId: 'a',
    runId: null
  })
  expect(readBotAutomationPlace()).toBeNull()
  openBotAutomation({
    bot,
    owner: botAutomationRowOwner(replacement!.automations[0].automation),
    automationId: 'a',
    runId: null
  })
  expect(readBotAutomationPlace()?.owner?.authority).toMatchObject({ pairingRevision: 5 })
})

it('carries the admitted owner through the real page handoff and rejects replacement IDs at consumption', async () => {
  const { openBotAutomation } = await import('./bot-automation-open')
  const { admitAutomationNavigation } =
    await import('../automations/hosts/automation-navigation-owner')
  const owner = captureNativeChatVisualOwner(
    { kind: 'environment', environmentId: 'e' },
    'chat',
    'folder:same'
  ).automationOwner
  openBotAutomation({ bot, owner: owner ?? null, automationId: 'a', runId: 'r', intent: 'page' })
  const navigation = useAppStore.getState().pendingAutomationRunNavigation
  expect(navigation?.owner).toEqual(owner)
  expect(navigation).not.toBeNull()
  revision(5)
  expect(navigation && admitAutomationNavigation(navigation)).toBe(false)
  expect(useAppStore.getState().pendingAutomationRunNavigation).toBeNull()
})

it('keeps qualified bot-less sign-in rows navigable without inferring a new owner', async () => {
  const { StoppedForSignInRow } = await import('./BotNeedRow')
  const qualify = captureBotRecordOwner(bot)
  render(
    <TooltipProvider>
      <StoppedForSignInRow
        bot={null}
        row={{
          key: 'stopped',
          automation: qualify(definition),
          failing: true,
          latestRunId: 'r',
          hostId: 'runtime:e'
        }}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /Open run/ }))
  expect(useAppStore.getState().pendingAutomationRunNavigation).toMatchObject({
    automationId: 'a',
    runId: 'r',
    hostId: 'runtime:e',
    owner: { authority: { pairingRevision: 4 } }
  })
})

it('holds a page handoff while checking, then admits a proven same-computer continuation', async () => {
  const { openBotAutomation } = await import('./bot-automation-open')
  const { admitAutomationNavigation, useAutomationNavigationRevision } =
    await import('../automations/hosts/automation-navigation-owner')
  const owner = captureNativeChatVisualOwner(
    { kind: 'environment', environmentId: 'e' },
    'chat',
    'folder:same'
  ).automationOwner
  openBotAutomation({ bot, owner: owner ?? null, automationId: 'a', runId: 'r', intent: 'page' })
  const navigation = useAppStore.getState().pendingAutomationRunNavigation
  if (!navigation) {
    throw new Error('Missing fixture navigation')
  }
  await act(async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'e', createdAt: 1, pairingRevision: 5 }], {
      retired: [],
      sameHost: [],
      pending: [{ id: 'e', fromRevision: 4 }]
    })
    useAppStore.setState({ runtimeEnvironments: [automationOwnerEnvironment('e', 5)] })
  })
  const proof = renderHook(() => useAutomationNavigationRevision(navigation))
  expect(admitAutomationNavigation(navigation)).toBe(false)
  expect(useAppStore.getState().pendingAutomationRunNavigation).toBe(navigation)
  expect(proof.result.current).toContain('checking')
  await act(async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'e', createdAt: 1, pairingRevision: 5 }], {
      retired: [],
      sameHost: [{ id: 'e', fromRevision: 4, toRevision: 5 }]
    })
  })
  expect(proof.result.current).toContain('continued')
  expect(admitAutomationNavigation(navigation)).toBe(true)
})
