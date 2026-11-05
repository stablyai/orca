import { existsSync, readFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { SUPPORTED, createChatOnHost, test } from './helpers/structured-claude-stub'
import { resolveCliCommand } from '../../src/shared/node-cli-command-resolution'
import { claudeSessionIdForOrcaSession } from '../../src/main/claude/structured/claude-structured-session-id'
import { buildClaudeModelListArgs } from '../../src/shared/claude-model-list-probe'

type ChatTab = { id: string; entityId: string }

function readChatTabs(page: Page, worktreeId: string): Promise<ChatTab[]> {
  return page.evaluate(
    (wt) =>
      (window.__store?.getState().unifiedTabsByWorktree[wt] ?? [])
        .filter((tab) => tab.contentType === 'agent-session')
        .map((tab) => ({ id: tab.id, entityId: tab.entityId })),
    worktreeId
  )
}

async function waitForChatTab(page: Page, worktreeId: string, sessionId: string): Promise<string> {
  let tabId: string | undefined
  await expect
    .poll(
      async () => {
        tabId = (await readChatTabs(page, worktreeId)).find((tab) => tab.entityId === sessionId)?.id
        return tabId
      },
      { timeout: 30_000 }
    )
    .toBeTruthy()
  return tabId!
}

function tabInStrip(page: Page, tabId: string) {
  return page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
}

/** Every Claude process Orca started, as the stub recorded it. */
function readStubLaunches(launchLog: string): { pid: number; args: string[] }[] {
  if (!existsSync(launchLog)) {
    return []
  }
  return readFileSync(launchLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const entry: unknown = JSON.parse(line)
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('pid' in entry) ||
        typeof entry.pid !== 'number' ||
        !('args' in entry) ||
        !Array.isArray(entry.args)
      ) {
        throw new Error(`unreadable stub launch: ${line}`)
      }
      return { pid: entry.pid, args: entry.args.map(String) }
    })
}

function readStubRequests(launchLog: string, pid: number) {
  const file = `${launchLog}.requests.jsonl`
  if (!existsSync(file)) {
    return []
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const entry: unknown = JSON.parse(line)
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('pid' in entry) ||
        !('type' in entry) ||
        !('subtype' in entry)
      ) {
        throw new Error(`unreadable stub request: ${line}`)
      }
      return entry.pid === pid ? [{ type: entry.type, subtype: entry.subtype }] : []
    })
}

test.describe('structured chat tabs', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('open from the host and the New tab menu, show in the tab bar, and close', async ({
    orcaPage: page,
    electronApp,
    claudeStub
  }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(page)
    const worktreeId = await waitForActiveWorktree(page)
    // An absolute Command setting is used as-is or refuses the start; it never falls back.
    await page.evaluate(async (command) => {
      await window.__store?.getState().updateSettings({
        nativeChatProviders: { claude: true, codex: true },
        defaultTuiAgent: 'claude',
        agentCmdOverrides: { claude: command }
      })
    }, buildFakeAgentCommandOverride(claudeStub.command))

    const first = await createChatOnHost(page, worktreeId)
    const firstTab = await waitForChatTab(page, worktreeId, first)
    await expect(tabInStrip(page, firstTab)).toBeVisible()
    const second = await createChatOnHost(page, worktreeId)
    const secondTab = await waitForChatTab(page, worktreeId, second)
    await expect(tabInStrip(page, secondTab)).toBeVisible()
    await expect(tabInStrip(page, firstTab)).toBeVisible()

    // The window closes one chat from its tab; the host closes the other.
    await tabInStrip(page, firstTab).locator('[data-tab-close-button="true"]').click()
    await expect(tabInStrip(page, firstTab)).toHaveCount(0)
    await expect(tabInStrip(page, secondTab)).toBeVisible()
    const closed = await page.evaluate(
      ({ wt, tabId }) =>
        window.api.runtime.call({
          method: 'session.tabs.close',
          params: { worktree: `id:${wt}`, tabId, reason: 'user' }
        }),
      { wt: worktreeId, tabId: `agent-session:${second}` }
    )
    expect(closed, JSON.stringify(closed)).toMatchObject({ ok: true })
    await expect(tabInStrip(page, secondTab)).toHaveCount(0)

    // A chat the window opens from the New tab menu.
    await page.getByRole('button', { name: 'New tab' }).click({ force: true })
    const claudeOption = page.getByRole('menuitem', {
      name: 'Claude Configure Claude',
      exact: true
    })
    await expect(claudeOption).toBeVisible({ timeout: 15_000 })
    await claudeOption.click({ force: true })
    let opened: ChatTab | undefined
    await expect
      .poll(
        async () => {
          opened = (await readChatTabs(page, worktreeId))[0]
          return opened?.entityId
        },
        { timeout: 30_000 }
      )
      .toBeTruthy()
    await expect(tabInStrip(page, opened!.id)).toBeVisible()

    // Orca's own lookup, on its shell-hydrated PATH and isolated HOME, lands on the stub.
    const mainEnv = await electronApp.evaluate(() => ({
      pathEnv: process.env.PATH ?? null,
      homePath: process.env.HOME
    }))
    expect(resolveCliCommand('claude', mainEnv)).toBe(claudeStub.command)
    // Only this stub's version/catalog probes or one of these exact conversations may start.
    const providerIds = [first, second, opened!.entityId].map((id) =>
      claudeSessionIdForOrcaSession(id)
    )
    await expect.poll(() => readStubLaunches(claudeStub.launchLog).length).toBeGreaterThan(0)
    for (const { pid, args } of readStubLaunches(claudeStub.launchLog)) {
      if (providerIds.some((id) => args.includes(id))) {
        continue
      }
      if (args[0] === '--version') {
        expect(args).toEqual(['--version'])
        continue
      }
      expect(args).toEqual([
        ...buildClaudeModelListArgs(),
        '--setting-sources',
        'user,project,local'
      ])
      await expect
        .poll(() => readStubRequests(claudeStub.launchLog, pid))
        .toEqual([
          { type: 'control_request', subtype: 'list_models' },
          { type: 'control_request', subtype: 'get_settings' }
        ])
    }

    await tabInStrip(page, opened!.id).locator('[data-tab-close-button="true"]').click()
    await expect(tabInStrip(page, opened!.id)).toHaveCount(0)
  })
})
