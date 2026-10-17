import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

type SeededCodexAccount = {
  id: string
  email: string
  managedHomePath: string
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

function seedCodexAccount(userData: string, id: string, email: string): SeededCodexAccount {
  const managedHomePath = path.join(userData, 'codex-accounts', id, 'home')
  mkdirSync(managedHomePath, { recursive: true })
  writeFileSync(path.join(managedHomePath, '.orca-managed-home'), `${id}\n`)
  writeFileSync(
    path.join(managedHomePath, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'e2e-placeholder' })
  )
  return { id, email, managedHomePath, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }
}

async function openTerminalTab(page: Page): Promise<{ tabId: string; ptyId: string }> {
  const tabId = await page.evaluate(() => {
    const state = window.__store!.getState()
    const tab = state.createTab(state.activeWorktreeId!)
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', state.activeWorktreeId ?? null)
    return tab.id
  })
  await waitForActiveTerminalManager(page)
  return { tabId, ptyId: await waitForActivePanePtyId(page) }
}

test.describe('Keeping a Codex agent on its account', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('a kept pane is not asked to restart when the selection moves', async ({
    electronApp,
    orcaPage
  }) => {
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const work = seedCodexAccount(userData, 'e2e-keep-work', 'work@example.com')
    const personal = seedCodexAccount(userData, 'e2e-keep-personal', 'personal@example.com')
    await orcaPage.evaluate(
      async ({ work, personal }) => {
        await window.__store!.getState().updateSettings({
          codexManagedAccounts: [work, personal],
          activeCodexManagedAccountId: work.id,
          activeCodexManagedAccountIdsByRuntime: { host: work.id, wsl: {} }
        })
      },
      { work, personal }
    )

    const keptPane = await openTerminalTab(orcaPage)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const controlPane = await openTerminalTab(orcaPage)

    // The host publishes the account once the pane's agent reports in.
    await emitCodexHookStatus(await readHookEndpoint(electronApp), {
      ...descriptor,
      state: 'working',
      prompt: 'Keep this on work',
      sessionId: 'e2e-kept-codex-session'
    })
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (paneKey) => window.__store!.getState().agentStatusByPaneKey[paneKey]?.runAccount ?? null,
          descriptor.paneKey
        )
      )
      .toMatchObject({ provider: 'codex', accountId: work.id, mode: 'follow' })

    const tab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${keptPane.tabId}"]`)
    await tab.click({ button: 'right' })
    const keep = orcaPage.getByRole('menuitemcheckbox', { name: 'Keep on work@example.com' })
    await expect(keep).toHaveAttribute('aria-checked', 'false')
    await keep.click()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (paneKey) => window.__store!.getState().agentStatusByPaneKey[paneKey]?.runAccount ?? null,
          descriptor.paneKey
        )
      )
      .toMatchObject({ accountId: work.id, mode: 'kept' })

    await orcaPage.evaluate(async (personalId) => {
      await window.__store!.getState().updateSettings({
        activeCodexManagedAccountId: personalId,
        activeCodexManagedAccountIdsByRuntime: { host: personalId, wsl: {} }
      })
    }, personal.id)

    const stalePtyIds = await orcaPage.evaluate(
      async (ptyIds) =>
        (await window.api.codexAccounts.listStalePanes({ ptyIds })).map((pane) => pane.ptyId),
      [keptPane.ptyId, controlPane.ptyId]
    )
    expect(stalePtyIds).toEqual([controlPane.ptyId])
  })
})
