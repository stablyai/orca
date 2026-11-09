// A first Claude launch on a signed-out paired host holds its prompt behind the inline sign-in card;
// the browser's localhost redirect reaches the host's login through the client's callback forward.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { writeAgentSignInFakeClaude } from './helpers/agent-sign-in-fake-claude'
import { writeAgentSignInFakeCodex } from './helpers/agent-sign-in-fake-codex'

const PROMPT = 'Fix the flaky retry test in api/client.test.ts'
// A recorded run holds each step long enough to read; plain runs don't wait.
const RECORDING = process.env.ORCA_E2E_RECORD_VIDEO === '1'

async function proofStep(page: Page, outputDir: string | null, name: string): Promise<void> {
  if (RECORDING && outputDir) {
    // ast-grep-ignore: test-no-real-time-wait -- holds a settled frame so the recorded video can be read; plain runs skip it.
    await page.waitForTimeout(1_500)
    await page.screenshot({ path: `${outputDir}/${name}.png` })
  }
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a TCP server bound to a port reports AddressInfo.
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
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

const AGENTS = [
  { agent: 'claude', site: 'claude.ai', callbackPath: '/callback', proof: true },
  { agent: 'codex', site: 'auth.openai.com', callbackPath: '/auth/callback', proof: false }
] as const

for (const { agent, site, callbackPath, proof } of AGENTS) {
  test(`a signed-out host holds the ${agent} launch until the browser sign-in finishes`, async (// oxlint-disable-next-line no-empty-pattern -- This test owns its host launch.
  {}, testInfo) => {
    test.skip(process.platform === 'win32', 'host sign-in runs on macOS and Linux hosts')
    // Two Electron apps (host and client) start per run.
    test.setTimeout(240_000)
    const repoPath = existsSync(TEST_REPO_PATH_FILE)
      ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
      : ''
    test.skip(!repoPath, 'Global setup did not produce a seeded test repo')
    const fakeDir = writeAgentSignInFakeClaude()
    writeAgentSignInFakeCodex(fakeDir)
    const callbackPort = await freePort()
    const host = await launchHeadlessPairedRuntimeHost({
      extraEnv: {
        PATH: `${fakeDir}:${process.env.PATH ?? ''}`,
        FAKE_CLAUDE_CALLBACK_PORT: String(callbackPort),
        FAKE_CODEX_CALLBACK_PORT: String(callbackPort)
      }
    })
    try {
      const client = await launchPairedElectronClient(host.offer, testInfo, 'agent-host-sign-in')
      try {
        const { page, environmentId } = client
        // The system browser stands in as this list; the test plays its redirect below.
        await client.app.evaluate(({ shell }) => {
          const opened: string[] = []
          Object.assign(globalThis, { __openedUrls: opened })
          shell.openExternal = async (url: string) => {
            opened.push(url)
          }
        })
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
        const tabId = await page.evaluate(
          ({ worktreeId, prompt, agent }) => {
            const state = window.__store?.getState()
            if (!state) {
              throw new Error('store unavailable')
            }
            state.setActiveView('terminal')
            state.setActiveWorktree(worktreeId)
            const tab = state.createTab(worktreeId, undefined, undefined, { launchAgent: agent })
            state.queueTabStartupCommand(tab.id, {
              command: `${agent} ${JSON.stringify(prompt)}`,
              launchAgent: agent,
              initialAgentStatus: { agent, prompt }
            })
            state.setActiveTab(tab.id)
            return tab.id
          },
          { worktreeId, prompt: PROMPT, agent }
        )

        const card = page.locator('[data-agent-sign-in]')
        await expect(card).toHaveAttribute('data-agent-sign-in', 'need', { timeout: 60_000 })
        await expect(card).toContainText(PROMPT)
        // Workspace activation may seed its own shell tab after ours; bring the agent's back.
        await page.evaluate((id) => window.__store?.getState().setActiveTab(id), tabId)
        await proofStep(page, proof ? testInfo.outputDir : null, '1-needs-sign-in')
        await card.getByRole('button', { name: 'Sign in with browser' }).click()
        await expect(card).toHaveAttribute('data-agent-sign-in', 'waiting', { timeout: 60_000 })
        await proofStep(page, proof ? testInfo.outputDir : null, '2-waiting-for-browser')

        const opened = await client.app.evaluate(() => {
          const urls: unknown = Object.getOwnPropertyDescriptor(globalThis, '__openedUrls')?.value
          return Array.isArray(urls) ? urls.map(String) : []
        })
        const signInUrl = new URL(opened.at(-1) ?? '')
        expect(signInUrl.hostname).toBe(site)
        expect(new URL(signInUrl.searchParams.get('redirect_uri') ?? '').port).toBe(
          String(callbackPort)
        )

        // The browser's redirect lands on this computer and must reach the host's login.
        const redirect = await fetch(
          `http://127.0.0.1:${callbackPort}${callbackPath}?code=fake&state=fake`,
          {
            redirect: 'manual'
          }
        )
        expect(redirect.status).toBe(302)

        if (RECORDING && proof) {
          await expect(card).toHaveAttribute('data-agent-sign-in', 'signed', { timeout: 60_000 })
          await page.screenshot({ path: `${testInfo.outputDir}/3-signed-in.png` })
        }
        await expect(card).toHaveCount(0, { timeout: 60_000 })
        await proofStep(page, proof ? testInfo.outputDir : null, '4-agent-running')
        const report = await callRuntime<{ agents: { agent: string; state: string }[] }>(
          page,
          environmentId,
          'accounts.agentSignInStatus',
          { force: true }
        )
        expect(report.agents.find((entry) => entry.agent === agent)?.state).toBe('signedIn')
      } finally {
        await client.dispose()
      }
    } finally {
      await host.dispose()
      rmSync(fakeDir, { recursive: true, force: true })
    }
  })
}
