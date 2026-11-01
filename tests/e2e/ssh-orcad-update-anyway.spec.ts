/** Prove Update defers on a running process, Update anyway preserves it across restart, and repeated deferrals keep one staged build (#34149). */
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { readPairedPaneContent } from './helpers/paired-host-terminal'
import { focusActiveTerminalInput } from './helpers/terminal'
import {
  activateManagedWorkspace,
  expectPaneText,
  expectTerminalAnswers,
  launchManagedWorkspace,
  ORCAD_TEMPLATE,
  relaunchManagedApp,
  selectTerminalTab,
  skipUnlessManagedDockerHost,
  openTerminalTab,
  terminalTabIds,
  typeInTerminal,
  waitForPane,
  withManagedHost
} from './helpers/orcad-managed-workspace'
import { makeOrcadTemplateVariant, readHostOrcadActivation } from './helpers/orcad-template-variant'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

const TICK = /AGENT_TICK_(\d+)/g

async function latestTick(page: Page, tabId: string): Promise<number> {
  const ticks = [...(await readPairedPaneContent(page, tabId)).matchAll(TICK)]
  return ticks.length === 0 ? -1 : Math.max(...ticks.map((match) => Number(match[1])))
}

test('Update anyway moves a managed host to the new build and keeps its running terminal', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(20 * 60_000)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-update-anyway-'))
  const templateDir = path.join(scratch, 'template')
  cpSync(ORCAD_TEMPLATE!, templateDir, { recursive: true })
  try {
    await withManagedHost(
      testInfo,
      async (fixture) => {
        const workspace = await launchManagedWorkspace(fixture)
        const { seeded, environmentId } = workspace
        const tab = await openTerminalTab(workspace.page, seeded.worktreeId)
        // Single quotes keep $$ for the inner bash: its pid is the long-running process itself.
        await typeInTerminal(
          workspace.page,
          tab,
          `bash -c 'echo AGENT_PID=$$; i=0; while :; do echo AGENT_TICK_$i; i=$((i+1)); sleep 1; done'`
        )
        await expectPaneText(workspace.page, tab, 'AGENT_TICK_2')
        const pid = /AGENT_PID=(\d+)/.exec(await readPairedPaneContent(workspace.page, tab))?.[1]
        expect(pid, 'the agent printed its pid').toBeTruthy()
        const deployed = readHostOrcadActivation(fixture.host.exec!)

        // An app update bundling a newer orcad; its connect defers over the running terminal.
        makeOrcadTemplateVariant(templateDir, 'B')
        const page = await relaunchManagedApp(fixture)
        await expect
          .poll(
            () =>
              page.evaluate(
                async (selector) =>
                  (await window.api.runtimeEnvironments.managedOrcad?.getStatus({ selector }))
                    ?.availableUpdate ?? null,
                environmentId
              ),
            { timeout: 4 * 60_000, intervals: [3_000] }
          )
          .toBeTruthy()
        expect(readHostOrcadActivation(fixture.host.exec!).active).toBe(deployed.active)

        await page.evaluate(() => {
          const state = window.__store!.getState()
          state.openSettingsTarget({ pane: 'servers', repoId: null })
          state.openSettingsPage()
        })
        const row = page.locator(`[data-settings-section="${environmentId}"]`)
        const update = row.getByRole('button', { name: 'Update', exact: true })
        await expect(update).toBeVisible({ timeout: 60_000 })
        await update.click()
        await expect(row.getByText(/keeps? running through the update/)).toBeVisible({
          timeout: 4 * 60_000
        })
        expect(readHostOrcadActivation(fixture.host.exec!).active).toBe(deployed.active)
        await page.screenshot({ path: testInfo.outputPath('update-anyway-confirm.png') })
        await row.getByRole('button', { name: 'Update anyway' }).click()

        await expect
          .poll(() => readHostOrcadActivation(fixture.host.exec!).active, {
            timeout: 6 * 60_000,
            intervals: [3_000]
          })
          .not.toBe(deployed.active)
        await expect(update).toHaveCount(0, { timeout: 2 * 60_000 })
        await page.screenshot({ path: testInfo.outputPath('update-anyway-done.png') })
        expect(fixture.host.exec!(`kill -0 ${pid} && echo alive`)).toContain('alive')

        // The same pane reattaches: its earlier output, the process still printing, then input.
        await activateManagedWorkspace(page, seeded.worktreeId, environmentId)
        expect(await terminalTabIds(page, seeded.worktreeId)).toContain(tab)
        await selectTerminalTab(page, tab)
        await waitForPane(page, tab)
        await expectPaneText(page, tab, `AGENT_PID=${pid}`, 2 * 60_000)
        const resumedAt = await latestTick(page, tab)
        await expect
          .poll(() => latestTick(page, tab), { timeout: 60_000 })
          .toBeGreaterThan(resumedAt + 2)
        await focusActiveTerminalInput(page)
        await page.keyboard.press('Control+C')
        await expectTerminalAnswers(page, tab)
        expect(fixture.host.exec!(`kill -0 ${pid} 2>/dev/null || echo gone`)).toContain('gone')
      },
      templateDir
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

function slotVersions(exec: (command: string) => string): string[] {
  return exec('cd /root/.orca-remote && ls -d orcad-0* 2>/dev/null || true')
    .split('\n')
    .map((line) => line.trim().replace(/^orcad-/, ''))
    .filter(Boolean)
    .sort()
}

function deferredCandidate(page: Page, environmentId: string): Promise<string | null> {
  return page.evaluate(
    async (selector) =>
      (await window.api.runtimeEnvironments.managedOrcad?.getStatus({ selector }))?.deferredUpdate
        ?.candidateVersion ?? null,
    environmentId
  )
}

test('a release deferred over running terminals replaces the build the last one staged', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  // Deploys a server, then relaunches through two app updates that each stage a build.
  test.setTimeout(20 * 60_000)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-deferred-slots-'))
  const templateDir = path.join(scratch, 'template')
  cpSync(ORCAD_TEMPLATE!, templateDir, { recursive: true })
  try {
    await withManagedHost(
      testInfo,
      async (fixture) => {
        const exec = fixture.host.exec!
        const workspace = await launchManagedWorkspace(fixture)
        const { environmentId } = workspace
        const tab = await openTerminalTab(workspace.page, workspace.seeded.worktreeId)
        await typeInTerminal(workspace.page, tab, `bash -c 'while :; do echo TICK; sleep 1; done'`)
        await expectPaneText(workspace.page, tab, 'TICK')
        const deployed = readHostOrcadActivation(exec).active!

        makeOrcadTemplateVariant(templateDir, 'B')
        let page = await relaunchManagedApp(fixture)
        await expect
          .poll(() => deferredCandidate(page, environmentId), { timeout: 4 * 60_000 })
          .not.toBeNull()
        const staged = (await deferredCandidate(page, environmentId))!
        expect(slotVersions(exec)).toEqual([deployed, staged].sort())

        // Releases come days apart; a build staged this recently could still be another desktop's.
        exec(`touch -d '5 days ago' /root/.orca-remote/orcad-${staged}/.install-complete`)
        makeOrcadTemplateVariant(templateDir, 'C')
        page = await relaunchManagedApp(fixture)
        let next: string | null = null
        await expect
          .poll(
            async () => {
              const candidate = await deferredCandidate(page, environmentId)
              next = candidate !== staged ? candidate : null
              return next
            },
            { timeout: 4 * 60_000 }
          )
          .not.toBeNull()
        expect(readHostOrcadActivation(exec).active).toBe(deployed)
        await expect
          .poll(() => slotVersions(exec), { timeout: 60_000 })
          .toEqual([deployed, next!].sort())
        // The prune must not touch the running terminal the deferral protected.
        expect(
          exec("pgrep -f '[w]hile :; do echo TICK' >/dev/null && echo alive || true")
        ).toContain('alive')
      },
      templateDir
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
