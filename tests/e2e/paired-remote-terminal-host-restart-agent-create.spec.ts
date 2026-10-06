/**
 * Repro probe: after a paired desktop host quits and relaunches (daemon survives), launching Claude
 * from the client's "New tab" menu must start exactly one agent on the host AND show that tab on the
 * client. Uses a fake `claude` on a sanitized PATH; the real CLI is never reachable.
 *
 * Run:
 *   ORCA_BACKGROUND_LAUNCH=1 pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-host-restart-agent-create.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { decodePairingOffer, encodePairingOffer } from '../../src/shared/pairing'
import { startFreezableTcpProxy, type FreezableTcpProxy } from './helpers/freezable-tcp-proxy'
import {
  holdWindowGraphPublication,
  releaseWindowGraphPublication
} from './helpers/hold-window-graph-publication'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __e2eToasts?: { type: string | null; text: string }[]
  }
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-agent-create-'))
const fakeBin = path.join(scratch, 'bin')
const launchLog = path.join(scratch, 'fake-claude-launches.log')
mkdirSync(fakeBin)
writeFileSync(
  path.join(fakeBin, 'claude'),
  [
    '#!/bin/sh',
    'case "$1" in --version|-v) echo "2.1.0 (Claude Code)"; exit 0;; esac',
    `echo "launch $$" >> '${launchLog}'`,
    "printf 'FAKE CLAUDE READY\\r\\n'",
    'exec cat'
  ].join('\n')
)
chmodSync(path.join(fakeBin, 'claude'), 0o755)
// Why: the inherited PATH can reach a developer's real `claude`; the host only sees the fake.
const SANITIZED_PATH = [
  fakeBin,
  path.dirname(process.execPath),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
].join(path.delimiter)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

function fakeClaudeLaunchCount(): number {
  try {
    return readFileSync(launchLog, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

type Census = {
  hostInventoryTabs: number
  hostWindowTabs: number
  clientTabs: number
  clientVisibleTabs: number
  launches: number
}

type InventoryTab = { type: string; parentTabId?: string; terminal?: string | null; title?: string }

async function hostInventory(
  client: PairedElectronClient,
  worktreeId: string
): Promise<InventoryTab[]> {
  return client.page.evaluate(
    async ({ environmentId, worktreeId }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'session.tabs.list',
        params: { worktree: `id:${worktreeId}` }
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only read of the RPC shape.
      return (response.result as { tabs: InventoryTab[] }).tabs
    },
    { environmentId: client.environmentId, worktreeId }
  )
}

async function census(
  host: Page,
  client: PairedElectronClient,
  worktreeId: string,
  includeInventory = true
): Promise<Census> {
  const inventory = includeInventory ? await hostInventory(client, worktreeId) : []
  const hostWindowTabs = await host.evaluate(
    (id) => window.__store?.getState().tabsByWorktree[id]?.length ?? 0,
    worktreeId
  )
  const mirror = await client.page.evaluate(
    (id) => ({
      clientTabs: window.__store?.getState().tabsByWorktree[id]?.length ?? 0,
      clientVisibleTabs: document.querySelectorAll('[data-testid="sortable-tab"]').length
    }),
    worktreeId
  )
  return {
    hostInventoryTabs: new Set(
      inventory.filter((tab) => tab.type === 'terminal').map((tab) => tab.parentTabId)
    ).size,
    hostWindowTabs,
    ...mirror,
    launches: fakeClaudeLaunchCount()
  }
}

async function readTerminalTail(client: PairedElectronClient, terminal: string): Promise<string> {
  return client.page.evaluate(
    async ({ environmentId, terminal }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'terminal.read',
        params: { terminal }
      })
      return JSON.stringify(response.ok ? response.result : response.error).slice(-1200)
    },
    { environmentId: client.environmentId, terminal }
  )
}

const resolvedClaudePath = path.join(scratch, 'resolved-claude.txt')

// Why: refuse to launch anything unless the host's own shell resolves `claude` to the fake.
async function assertHostResolvesFakeClaude(
  client: PairedElectronClient,
  worktreeId: string
): Promise<void> {
  // Why: a previous test's answer must not satisfy this check while the redirect truncates it.
  rmSync(resolvedClaudePath, { force: true })
  await client.page.evaluate(
    async ({ environmentId, worktreeId, command }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'session.tabs.createTerminal',
        params: {
          worktree: `id:${worktreeId}`,
          command,
          activate: false,
          select: false,
          navigation: 'caller'
        }
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
    },
    {
      environmentId: client.environmentId,
      worktreeId,
      command: `command -v claude > '${resolvedClaudePath}'`
    }
  )
  await expect
    .poll(
      () => (existsSync(resolvedClaudePath) ? readFileSync(resolvedClaudePath, 'utf8').trim() : ''),
      {
        timeout: 30_000,
        message: 'Host shell never reported where claude resolves'
      }
    )
    .toMatch(/\S/)
  const resolved = readFileSync(resolvedClaudePath, 'utf8').trim()
  if (resolved !== path.join(fakeBin, 'claude')) {
    throw new Error(`Refusing to launch: host shell resolves claude to ${resolved}, not the fake`)
  }
}

async function showWorktree(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((worktree) => worktree.id === id) ?? false,
          worktreeId
        ),
      { timeout: 60_000, message: 'Paired client never saw the host worktree' }
    )
    .toBe(true)
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    state?.setActiveView('terminal')
    state?.setActiveWorktree(id)
  }, worktreeId)
}

async function launchClaudeFromNewTabMenu(page: Page): Promise<void> {
  await openNewTabMenu(page)
  const claude = page.getByRole('menuitem', { name: /^Claude$/ }).first()
  try {
    await claude.waitFor({ timeout: 15_000 })
  } catch (error) {
    const options = await page.getByRole('option').allTextContents()
    const menu = await page
      .locator('[role="menu"], [role="dialog"], [role="listbox"]')
      .allTextContents()
    throw new Error(
      `No Claude option. options=${JSON.stringify(options)} menus=${JSON.stringify(menu).slice(0, 1500)}`,
      { cause: error }
    )
  }
  await claude.click()
}

async function expectLaunchMirrored(
  host: Page,
  client: PairedElectronClient,
  worktreeId: string,
  before: Census,
  label: string,
  options: { timeoutMs?: number; launchEvidenceOnly?: boolean } = {}
): Promise<Census> {
  let last = before
  try {
    await expect
      .poll(
        async () => {
          last = await census(host, client, worktreeId, !options.launchEvidenceOnly)
          return (
            last.launches === before.launches + 1 &&
            (options.launchEvidenceOnly ||
              last.hostInventoryTabs === before.hostInventoryTabs + 1) &&
            last.clientTabs === before.clientTabs + 1 &&
            last.clientVisibleTabs === before.clientVisibleTabs + 1
          )
        },
        { timeout: options.timeoutMs ?? 30_000 }
      )
      .toBe(true)
  } catch {
    const inventory = options.launchEvidenceOnly ? [] : await hostInventory(client, worktreeId)
    const tails: string[] = []
    for (const tab of inventory) {
      if (tab.type === 'terminal' && tab.terminal) {
        tails.push(`${tab.title}: ${await readTerminalTail(client, tab.terminal)}`)
      }
    }
    const clientTabs = await client.page.evaluate(
      (id) =>
        (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => ({
          id: tab.id,
          title: tab.title
        })),
      worktreeId
    )
    throw new Error(
      `${label}: Claude launch was not mirrored.\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(last)}\nclientTabs=${JSON.stringify(clientTabs)}\nhostInventory=${JSON.stringify(inventory)}\ntails=${tails.join('\n---\n')}`
    )
  }
  return last
}

test('a Claude tab launched from the client after a host relaunch appears on the client', async (// oxlint-disable-next-line no-empty-pattern -- This lifecycle test owns both host launches.
{}, testInfo) => {
  test.setTimeout(600_000)
  const repoPath = seededRepoPathOrSkip()
  // Why: macOS terminals launch through `login -f`, which restores the real HOME and shell rc (and
  // with them the real PATH); disabling it keeps the isolated HOME and sanitized PATH in the shell.
  const session = createRestartSession(testInfo, {
    PATH: SANITIZED_PATH,
    ORCA_DISABLE_MACOS_LOGIN_SHELL: '1'
  })
  let firstHost: ElectronApplication | null = null
  let secondHost: ElectronApplication | null = null
  let client: PairedElectronClient | null = null
  try {
    const first = await session.launch()
    firstHost = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(first.page),
      testInfo,
      'host-restart-agent-create'
    )
    await showWorktree(client.page, worktreeId)
    await expect(client.page.locator('[data-testid="sortable-tab"]').first()).toBeVisible({
      timeout: 60_000
    })

    await assertHostResolvesFakeClaude(client, worktreeId)
    // Control: the same launch mirrors before any restart.
    const beforeControl = await census(first.page, client, worktreeId)
    await launchClaudeFromNewTabMenu(client.page)
    await expectLaunchMirrored(first.page, client, worktreeId, beforeControl, 'before restart')

    await session.close(firstHost)
    firstHost = null
    const held = process.env.ORCA_E2E_AGENT_CREATE_NO_HOLD !== '1'
    const second = await session.launch(
      held ? { beforeFirstWindow: holdWindowGraphPublication } : {}
    )
    secondHost = second.app
    if (held) {
      await expect
        .poll(
          () =>
            client!.page.evaluate(
              () =>
                document
                  .querySelector('[data-pty-recovery-state]')
                  ?.getAttribute('data-pty-recovery-state') ?? null
            ),
          { timeout: 20_000 }
        )
        .toMatch(/ended|connected|disconnected/)
        .catch(() => undefined)
      expect(await releaseWindowGraphPublication(second.app)).toBe(0)
    }
    await second.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      undefined,
      { timeout: 30_000 }
    )
    await expect(
      client.page.locator('[data-terminal-remote-runtime-reconnect-banner]')
    ).toHaveCount(0, { timeout: 90_000 })
    // Optional sleep simulation: suspend the host and/or client process trees, then resume.
    const pause = process.env.ORCA_E2E_AGENT_CREATE_PAUSE
    if (pause) {
      const seconds = Number(process.env.ORCA_E2E_AGENT_CREATE_PAUSE_SECONDS ?? '90')
      const pids = [
        ...(pause.includes('host') ? [second.app.process().pid!] : []),
        ...(pause.includes('client') ? [client.app.process().pid!] : [])
      ]
      for (const pid of pids) {
        process.kill(pid, 'SIGSTOP')
      }
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
      for (const pid of pids) {
        process.kill(pid, 'SIGCONT')
      }
    }
    await showWorktree(client.page, worktreeId)
    // Settle: host and client agree on the existing tabs before the new launch.
    let settled = await census(second.page, client, worktreeId)
    await expect
      .poll(
        async () => {
          settled = await census(second.page, client!, worktreeId)
          return settled.hostInventoryTabs > 0 && settled.hostInventoryTabs === settled.clientTabs
        },
        { timeout: 30_000, message: 'Client never re-converged with the relaunched host' }
      )
      .toBe(true)
    await launchClaudeFromNewTabMenu(client.page)
    await expectLaunchMirrored(second.page, client, worktreeId, settled, 'after restart')
  } finally {
    if (client) {
      await client.dispose()
    }
    if (secondHost) {
      await session.close(secondHost)
    }
    if (firstHost) {
      await session.close(firstHost)
    }
    await session.dispose()
  }
})

type DeadReturnPath = {
  host: Page
  client: PairedElectronClient
  proxy: FreezableTcpProxy
  worktreeId: string
  settled: Census
}

/**
 * Pairs a client through a proxy, settles it, then silently drops every host→client byte on the
 * live socket (sleep, NAT, Wi-Fi change) while client→host still delivers.
 */
async function runOverDeadReturnPath(
  testInfo: Parameters<Parameters<typeof test>[2]>[1],
  label: string,
  body: (path: DeadReturnPath) => Promise<void>
): Promise<void> {
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo, {
    PATH: SANITIZED_PATH,
    ORCA_DISABLE_MACOS_LOGIN_SHELL: '1'
  })
  let host: ElectronApplication | null = null
  let client: PairedElectronClient | null = null
  let proxy: FreezableTcpProxy | null = null
  try {
    const launched = await session.launch()
    host = launched.app
    const worktreeId = await attachRepoAndOpenTerminal(launched.page, repoPath)
    // Why a proxy: it can silently drop host→client bytes on the live socket while client→host
    // still delivers, which no in-process fault can express.
    const offer = await createRuntimeDesktopPairingOffer(launched.page)
    const decoded = decodePairingOffer(offer.pairingUrl)
    const endpoint = new URL(decoded.endpoint)
    proxy = await startFreezableTcpProxy(endpoint.hostname, Number(endpoint.port))
    endpoint.port = String(proxy.port)
    client = await launchPairedElectronClient(
      { pairingUrl: encodePairingOffer({ ...decoded, endpoint: endpoint.toString() }) },
      testInfo,
      label
    )
    await showWorktree(client.page, worktreeId)
    await expect(client.page.locator('[data-testid="sortable-tab"]').first()).toBeVisible({
      timeout: 60_000
    })
    await assertHostResolvesFakeClaude(client, worktreeId)
    let settled = await census(launched.page, client, worktreeId)
    await expect
      .poll(
        async () => {
          settled = await census(launched.page, client!, worktreeId)
          return settled.hostInventoryTabs > 0 && settled.hostInventoryTabs === settled.clientTabs
        },
        { timeout: 30_000 }
      )
      .toBe(true)
    await observeToasts(client.page)
    expect(proxy.freezeExisting('to-client'), 'client must hold a live socket').toBeGreaterThan(0)
    await body({ host: launched.page, client, proxy, worktreeId, settled })
  } finally {
    await proxy?.close()
    if (client) {
      await client.dispose()
    }
    if (host) {
      await session.close(host)
    }
    await session.dispose()
  }
}

// Why an observer: toasts auto-dismiss, so a point-in-time count can miss one.
async function observeToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: { type: string | null; text: string }[] = []
    window.__e2eToasts = seen
    new MutationObserver(() => {
      for (const toast of document.querySelectorAll('[data-sonner-toast]')) {
        const text = toast.textContent ?? ''
        if (!seen.some((entry) => entry.text === text)) {
          seen.push({ type: toast.getAttribute('data-type'), text })
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}

async function seenToasts(page: Page): Promise<unknown> {
  return page.evaluate(() => window.__e2eToasts)
}

const pendingTabs = (page: Page): Locator => page.locator('[data-pending-remote-terminal-tab]')

/**
 * Picks a "New tab" menu entry once. Why retry only a failed click: a click can land while a
 * previous menu is closing or re-rendering, but re-clicking after one registered would create twice.
 */
async function chooseFromNewTabMenu(page: Page, item: RegExp): Promise<void> {
  const before = await pendingTabs(page).count()
  await expect(async () => {
    if ((await page.getByRole('menu').count()) === 0) {
      await page.getByRole('button', { name: 'New tab' }).first().click({ timeout: 2_000 })
    }
    await page.getByRole('menuitem', { name: item }).first().click({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(pendingTabs(page)).toHaveCount(before + 1, { timeout: 2_000 })
}

// Why retry: a second click right after the first can land while the previous menu is closing.
async function openNewTabMenu(page: Page): Promise<void> {
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(async () => {
    if ((await page.getByRole('menu').count()) === 0) {
      await page.getByRole('button', { name: 'New tab' }).first().click()
    }
    await expect(page.getByRole('menu')).toHaveCount(1, { timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

/**
 * What the user sees over a dead return path: a pending tab on each click, one host create per
 * click (a second click during the gap included), each settling into its real tab, and no error.
 */
async function expectCreatesSettleOverDeadReturnPath(
  path: DeadReturnPath,
  menuItem: RegExp,
  hostCreates: () => Promise<number>
): Promise<void> {
  const { client, proxy, worktreeId, settled } = path
  const hostBefore = await hostCreates()
  // Why: keep the network down until both clicks land, so a slow runner cannot settle the first
  // create before the second click and the gap is the same on every machine.
  proxy.refuseNew(true)
  // Why: while new connections are refused, any further close is a frozen socket being dropped.
  const eventsBeforeClick = proxy.events.length
  const clickedAt = Date.now()
  // 1. Feedback right after the click, not after the host round-trip.
  await chooseFromNewTabMenu(client.page, menuItem)
  await expect(pendingTabs(client.page).first()).toBeVisible({ timeout: 1_000 })
  // The user clicks again while nothing has appeared yet; that is a second create, not a retry.
  await chooseFromNewTabMenu(client.page, menuItem)
  await expect(pendingTabs(client.page)).toHaveCount(2)
  // The send probe, not the 25s idle liveness, must drop the silent socket.
  await expect
    .poll(() => proxy.events.slice(eventsBeforeClick).some((event) => event.includes(' close#')), {
      timeout: 12_000
    })
    .toBe(true)
  test.info().annotations.push({
    type: 'deadSocketDroppedAfterMs',
    description: String(Date.now() - clickedAt)
  })
  const releasedAt = Date.now()
  proxy.refuseNew(false)

  // 2 + 3. Exactly one host create per click, and both settle into their real tabs.
  await expect
    .poll(
      async () => ({
        hostCreates: (await hostCreates()) - hostBefore,
        clientTabs:
          (await client.page.evaluate(
            (id) => window.__store?.getState().tabsByWorktree[id]?.length ?? 0,
            worktreeId
          )) - settled.clientTabs,
        pending: await pendingTabs(client.page).count()
      }),
      { timeout: 60_000 }
    )
    .toEqual({ hostCreates: 2, clientTabs: 2, pending: 0 })
  test.info().annotations.push({
    type: 'settledAfterReconnectMs',
    description: String(Date.now() - releasedAt)
  })
  // A late replay would show up as a third create.
  await client.page.waitForTimeout(3_000)
  expect((await hostCreates()) - hostBefore).toBe(2)
  // 4. A create the host performed is never reported as failed or unconfirmed.
  expect(await seenToasts(client.page), 'client reported a host-accepted create').toEqual([])
}

test('a Claude launch the host accepted over a dead return path is not reported as failed', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its host launch.
{}, testInfo) => {
  test.setTimeout(300_000)
  await runOverDeadReturnPath(testInfo, 'dead-return-path-agent-create', async (path) => {
    await expectCreatesSettleOverDeadReturnPath(path, /^Claude$/, async () =>
      fakeClaudeLaunchCount()
    )
  })
})

test('a plain terminal created over a dead return path shows pending and settles once', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its host launch.
{}, testInfo) => {
  test.setTimeout(300_000)
  await runOverDeadReturnPath(testInfo, 'dead-return-path-terminal-create', async (path) => {
    await expectCreatesSettleOverDeadReturnPath(path, /^New Terminal/, () =>
      path.host.evaluate(
        (id) => window.__store?.getState().tabsByWorktree[id]?.length ?? 0,
        path.worktreeId
      )
    )
    // Plain shells must not start an agent.
    expect(fakeClaudeLaunchCount()).toBe(path.settled.launches)
  })
})
