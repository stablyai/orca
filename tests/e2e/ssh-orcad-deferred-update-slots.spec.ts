/** A host that defers every release over its running terminals keeps one staged build, not one per release (#34149). */
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  expectPaneText,
  launchManagedWorkspace,
  ORCAD_TEMPLATE,
  openTerminalTab,
  relaunchManagedApp,
  skipUnlessManagedDockerHost,
  typeInTerminal,
  withManagedHost
} from './helpers/orcad-managed-workspace'
import { makeOrcadTemplateVariant, readHostOrcadActivation } from './helpers/orcad-template-variant'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

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
