/**
 * Layout rework P3 baseline: an old phone paired straight to the current `orca serve`. Not the
 * released app: a capability-list client that advertises mobile-android-v0.0.52's capabilities
 * and sends that release's request shapes. It creates, activates, renames, focuses and closes
 * terminals (one of them pinned on the host), opens a file, and reads its own selection again
 * after the server restarts. Each step records the phone's and
 * the server's tab lists; the shapes are compared with main's.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { pairMobileClient, type PairedMobileClient } from './helpers/paired-mobile-client'
import {
  expectLayoutCompatBaseline,
  IdLabels,
  readSessionTabs,
  readSettled,
  readUntil,
  sessionTabsBaseline
} from './helpers/layout-compat-baseline'
import type { RuntimeCapability } from '../../src/shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-terminal-contracts'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'

/** What mobile-android-v0.0.52 advertises (its mobile-runtime-client-capabilities.ts). */
const OLD_PHONE_CAPABILITIES: readonly RuntimeCapability[] = [
  'agent-session.background-task-stop.v1',
  'agent-session.background-task-row-stop.v1',
  'agent-session.turn-item.v1',
  'session-tabs.close-intent.v1',
  'session-tabs.authoritative-inventory.v1',
  'agent-session.session-boundary.v1',
  'skills.install-result.v2',
  'worktree.github-pr-suppression.v1',
  'worktree.visibility-defaults.v1',
  'worktree.visibility-source-defaults.v1',
  'automation.owner-fencing.v1',
  'agent-session.structured.v1',
  'agent-session.pending-send-result.v1',
  'agent-session.structured.hold.v1',
  'agent-session.structured.claude.v1',
  'session-tabs.split-group-placement.v1',
  'agent.launch.v2'
]

// A layout-owner build's main opens the file itself, so the open succeeds and the tab is listed.
const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)

// Set until the restarted host hears from its paired hosts, or a deadline passes: timing, not shape.
const TRANSIENT_FIELDS = new Set(['clientHostedPagesUnreconciled'])

function fieldsOf(value: unknown): string[] {
  return value && typeof value === 'object'
    ? Object.keys(value)
        .filter((key) => !TRANSIENT_FIELDS.has(key))
        .sort()
    : []
}

/** A reply as the baseline keeps it: success and the result's fields, or the refusal code. */
async function reply(phone: PairedMobileClient, method: string, params: unknown) {
  const response = await phone.request<unknown>(method, params)
  if (!response.ok) {
    // runtime_error is generic; its message names the actual refusal.
    return response.error.code === 'runtime_error'
      ? { ok: false, error: response.error.code, message: response.error.message }
      : { ok: false, error: response.error.code }
  }
  return { ok: true, fields: fieldsOf(response.result) }
}

async function phoneTerminals(phone: PairedMobileClient, worktree: string) {
  return (await phone.call<RuntimeTerminalListResult>('terminal.list', { worktree })).terminals
}

/** The first snapshot of the phone's own tab stream: what the session strip is built from. */
async function firstSnapshot(
  phone: PairedMobileClient,
  worktree: string
): Promise<RuntimeMobileSessionTabsResult> {
  let snapshot: RuntimeMobileSessionTabsResult | null = null
  const subscription = await phone.subscribe<{ type: string } & RuntimeMobileSessionTabsResult>(
    'session.tabs.subscribe',
    { worktree },
    {
      onResponse: (response) => {
        if (response.ok && response.result.type === 'snapshot' && !snapshot) {
          snapshot = response.result
        }
      },
      onError: () => {}
    },
    30_000
  )
  try {
    await expect.poll(() => snapshot !== null, { timeout: 30_000 }).toBe(true)
    return snapshot!
  } finally {
    subscription.close()
  }
}

test('old-phone-on-new-server: create, activate, rename, focus, close, open a file, reconnect', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({
    pairingScope: 'mobile',
    pinnedServePort: true
  })
  const phone = pairMobileClient(host.offer, OLD_PHONE_CAPABILITIES)
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
      'worktree.ps',
      { limit: 1_000 }
    )
    const worktreeId = worktrees.find((row) => row.path === testRepoPath)?.worktreeId ?? ''
    expect(worktreeId, 'the phone lists the server workspace').not.toBe('')
    const worktree = `id:${worktreeId}`

    const labels = new IdLabels()
    const steps: unknown[] = []
    const record = async (step: string, sent?: unknown): Promise<void> => {
      const observed = await readSettled(async () => ({
        phone: sessionTabsBaseline(
          await phone.call<RuntimeMobileSessionTabsResult>('session.tabs.list', { worktree }),
          labels
        ),
        server: sessionTabsBaseline(await readSessionTabs(host.client, worktree), labels)
      }))
      steps.push({ step, ...(sent ? { reply: sent } : {}), ...observed })
    }
    const create = (n: number) =>
      phone.call<{ tab: { id: string; parentTabId: string } }>('session.tabs.createTerminal', {
        worktree,
        clientMutationId: `old-phone-create-${n}`,
        activate: false,
        select: true,
        navigation: 'caller'
      })

    const first = (await create(1)).tab
    const second = (await create(2)).tab
    // Name tabs in creation order, so the recorded shape reads tab1, tab2.
    labels.label('tab', first.parentTabId)
    labels.label('tab', second.parentTabId)
    await record('phone creates two terminals')

    const activated = await reply(phone, 'session.tabs.activate', {
      worktree,
      tabId: first.id,
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
    await record('phone activates the first', activated)

    const handleOf = async (tabId: string) =>
      (await phoneTerminals(phone, worktree)).find((terminal) => terminal.tabId === tabId)
        ?.handle ?? ''
    const renamed = await reply(phone, 'terminal.rename', {
      terminal: await handleOf(first.parentTabId),
      title: 'phone-renamed'
    })
    await record('phone renames the first', renamed)

    const focused = await reply(phone, 'terminal.focus', {
      terminal: await handleOf(second.parentTabId),
      navigation: 'host'
    })
    await record('phone focuses the second', focused)

    // A desktop pins the second tab; the old phone has no pin control and closes it anyway.
    await host.client.call('session.tabs.setTabProps', {
      worktree,
      tabId: second.parentTabId,
      isPinned: true
    })
    await record('host pins the second')
    const closedPinned = await reply(phone, 'session.tabs.close', {
      worktree,
      tabId: second.id,
      reason: 'user'
    })
    await record('phone closes the pinned tab', closedPinned)

    // A headless server refuses with runtime_error "renderer_unavailable" (no window to open in),
    // except in a layout-owner build, whose main opens it: the README tab is listed from the restart.
    const opened = await reply(phone, 'files.open', { worktree, relativePath: 'README.md' })
    await record('phone opens a file', opened)

    const selectedBefore = sessionTabsBaseline(await firstSnapshot(phone, worktree), labels)
    const tabsOf = (terminals: { tabId: string }[]) =>
      JSON.stringify(terminals.map((terminal) => terminal.tabId).sort())
    const tabsBefore = tabsOf(await phoneTerminals(phone, worktree))
    await host.restartServeProcess()
    const selectedAfter = sessionTabsBaseline(await firstSnapshot(phone, worktree), labels)
    // Linux: the server lists every terminal again shortly after it answers. macOS (no baseline):
    // in this harness the list stayed empty for the 60 s measured, with the tabs still listed.
    const listedAfter = await readUntil(
      () => phoneTerminals(phone, worktree),
      (terminals) => tabsOf(terminals) === tabsBefore
    )
    steps.push({
      step: 'phone reconnects after a server restart',
      snapshotBefore: selectedBefore,
      snapshotAfter: selectedAfter,
      terminalsAfter: listedAfter
        .map((terminal) => ({
          tab: labels.label('tab', terminal.tabId),
          pty: labels.pty(terminal.ptyId)
        }))
        .sort((a, b) => String(a.tab).localeCompare(String(b.tab)))
    })

    const snapshot = await firstSnapshot(phone, worktree)
    const firstHandle = await handleOf(first.parentTabId)
    const closedLast = firstHandle
      ? await reply(phone, 'terminal.close', { terminal: firstHandle })
      : { ok: false, error: 'no terminal.list row for the tab' }
    await record('phone closes the first terminal', closedLast)

    const scenario = LAYOUT_OWNER_BUILD
      ? 'old-phone-on-new-server.layout-owner'
      : 'old-phone-on-new-server'
    await expectLayoutCompatBaseline(testInfo, scenario, {
      steps,
      // The payload the old phone parses: its snapshot and terminal-row fields.
      snapshotFields: fieldsOf(snapshot),
      terminalRowFields: [
        ...new Set(snapshot.tabs.flatMap((tab) => (tab.type === 'terminal' ? fieldsOf(tab) : [])))
      ].sort()
    })
  } finally {
    phone.dispose()
    await host.dispose()
  }
})
