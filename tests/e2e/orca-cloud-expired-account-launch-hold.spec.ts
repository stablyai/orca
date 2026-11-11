// RA-1: on Orca Cloud (a paired web host), a Claude launch from the real New tab menu holds on the
// account-recovery strip when the Orca-account sign-in expired; the agent never starts on the host.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { writeAgentSignInFakeClaude } from './helpers/agent-sign-in-fake-claude'

const CLAUDE_MENU_ITEM = /^Claude(?:\s|$)/i

const EXPIRED_STATUS = {
  credentials: {
    claude: { state: 'expired' },
    codex: { state: 'none' },
    providerEnabled: { claude: true, codex: true },
    providerState: { claude: 'on', codex: 'on' }
  },
  sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
}

async function callRuntime<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only RPC result shape.
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  ) as Promise<TResult>
}

/** The paired host stands in for an Orca Cloud sandbox: the shape the desktop recognises. */
async function markEnvironmentAsOrcaCloud(page: Page, environmentId: string): Promise<boolean> {
  return page.evaluate(async (id) => {
    const store = window.__store
    if (!store) {
      return false
    }
    const list = await window.api.runtimeEnvironments.list()
    store
      .getState()
      .setRuntimeEnvironments(
        list.map((entry) =>
          entry.id === id
            ? { ...entry, source: 'ephemeral-vm', name: 'e2e sandbox abcd1234' }
            : entry
        )
      )
    return (
      store
        .getState()
        .runtimeEnvironments?.some((entry) => entry.id === id && entry.source === 'ephemeral-vm') ??
      false
    )
  }, environmentId)
}

function hostClaudeTabs(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate(
    (id) =>
      (window.__store?.getState().tabsByWorktree[id] ?? []).filter(
        (tab) => tab.launchAgent === 'claude'
      ).length,
    worktreeId
  )
}

test('an expired Orca-account sign-in holds a cloud Claude launch on the strip', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its host launch.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'paired hosts run on macOS and Linux here')
  // Two Electron apps (host and client) start per run.
  test.setTimeout(240_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath, 'Global setup did not produce a seeded test repo')
  const fakeDir = writeAgentSignInFakeClaude()
  const host = await launchHeadlessPairedRuntimeHost({
    extraEnv: { PATH: `${fakeDir}:${process.env.PATH ?? ''}` }
  })
  try {
    const client = await launchPairedElectronClient(host.offer, testInfo, 'cloud-expired-hold')
    try {
      const { page, environmentId } = client
      // The control plane says the Claude account credential expired (revoked at egress).
      await client.app.evaluate(({ ipcMain }, status) => {
        ipcMain.removeHandler('orcaCloudAgents:status')
        ipcMain.handle('orcaCloudAgents:status', () => ({ ok: true, value: status }))
      }, EXPIRED_STATUS)
      const added = await callRuntime<{ repo: { id: string } }>(page, environmentId, 'repo.add', {
        path: repoPath,
        kind: 'git'
      })
      const findWorktreeId = (): Promise<string | null> =>
        page.evaluate(
          (repoId) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => worktree.repoId === repoId)?.id ?? null,
          added.repo.id
        )
      await expect.poll(findWorktreeId, { timeout: 60_000 }).not.toBeNull()
      const worktreeId = (await findWorktreeId()) ?? ''
      await expect.poll(() => markEnvironmentAsOrcaCloud(page, environmentId)).toBe(true)
      await page.evaluate((id) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(id)
      }, worktreeId)

      // The real launch path: New tab → Claude (host-published on a paired web host).
      await page.getByRole('button', { name: 'New tab' }).click({ force: true })
      const launchOption = page.getByRole('menuitem', { name: CLAUDE_MENU_ITEM }).first()
      await expect(launchOption).toBeVisible({ timeout: 30_000 })
      await launchOption.click({ force: true })

      const strip = page.locator('[data-cloud-sign-in-strip]')
      await expect(strip).toBeVisible({ timeout: 60_000 })
      await expect(strip).toContainText('Your Claude sign-in expired')
      await page.screenshot({ path: testInfo.outputPath('cloud-claude-expired-strip.png') })
      // Held: the host never opened a Claude terminal.
      expect(await hostClaudeTabs(page, worktreeId)).toBe(0)

      // Cancel leaves the plain shell and still no Claude.
      await strip.getByRole('button', { name: /Cancel/ }).click()
      await expect(strip).toHaveCount(0, { timeout: 30_000 })
      expect(await hostClaudeTabs(page, worktreeId)).toBe(0)
    } finally {
      await client.dispose()
    }
  } finally {
    await host.dispose()
    rmSync(fakeDir, { recursive: true, force: true })
  }
})
