import type { ElectronApplication } from '@stablyai/playwright-test'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'

// oxlint-disable-next-line no-empty-pattern -- Owns an isolated profile and a deterministic local CLI process.
test('explicit team bindings launch once without changing existing settings', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Windows command-shim integration')
  test.setTimeout(180_000)
  const folder = testInfo.outputPath('project')
  const bin = testInfo.outputPath('bin')
  const marker = testInfo.outputPath('launches.jsonl')
  await mkdir(folder, { recursive: true })
  await mkdir(bin, { recursive: true })
  const fake = join(bin, 'fake-agent.cjs')
  await writeFile(
    fake,
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log('TEAM_READY:reviewer'); setInterval(()=>{},1000)`
  )
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`)
  const session = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    PATH: bin + delimiter + process.env.PATH
  })
  const config = join(session.userDataDir, 'team.json')
  const registry = join(session.userDataDir, 'project-teams.json')
  await writeFile(join(session.userDataDir, 'role.md'), 'Review only. Do not change project files.')
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      name: 'Review team',
      roles: [
        {
          id: 'reviewer',
          title: 'Review team agent',
          provider: 'codex',
          model: 'test-model',
          effort: 'medium',
          instructions: ['role.md']
        }
      ]
    })
  )
  const binding = { config, projectRoot: folder, enabled: false }
  await writeFile(registry, JSON.stringify({ version: 1, teams: [binding] }))
  let active: ElectronApplication | undefined
  try {
    const launched = await session.launch()
    active = launched.app
    await waitForSessionReady(launched.page)
    await launched.page.evaluate(async (folder) => {
      const result = await window.api.repos.add({ path: folder, kind: 'folder' })
      if ('error' in result) {
        throw new Error(result.error)
      }
      await window
        .__store!.getState()
        .fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
      await window.__store!.getState().fetchWorktrees(result.repo.id)
      await window.__store!.getState().updateSettingsOrThrow({ terminalFontSize: 19 })
    }, folder)
    await expect(launched.page.getByText('Review team agent', { exact: true })).toHaveCount(0)
    await launched.page.screenshot({ path: testInfo.outputPath('team-before-enable.png') })
    await writeFile(
      registry,
      JSON.stringify({ version: 1, teams: [{ ...binding, enabled: true }] })
    )
    await expect
      .poll(async () => readFile(marker, 'utf8').catch(() => ''), { timeout: 60000 })
      .toContain('TEAM_READY:reviewer')
    await expect
      .poll(async () =>
        readFile(join(session.userDataDir, 'project-team-runtime.json'), 'utf8').catch(() => '')
      )
      .toMatch(/"status": "started"|"code": "team_existing_role_requires_attention"/)
    const beforeReload = JSON.parse(
      await readFile(join(session.userDataDir, 'project-team-runtime.json'), 'utf8')
    ).checkedAt
    const nextRegistry = join(session.userDataDir, 'project-teams.next.json')
    await writeFile(
      nextRegistry,
      JSON.stringify({ version: 1, teams: [{ ...binding, enabled: true }] }, null, 2)
    )
    await rename(nextRegistry, registry)
    await expect
      .poll(async () => {
        const data = JSON.parse(
          await readFile(join(session.userDataDir, 'project-team-runtime.json'), 'utf8')
        )
        return data.checkedAt !== beforeReload ? data.teams[0]?.roles[0]?.status : null
      })
      .toBe('blocked')
    const report = JSON.parse(
      await readFile(join(session.userDataDir, 'project-team-runtime.json'), 'utf8')
    )
    // The fake child is deliberately not a recognized provider: preserve it, never restart it.
    expect(report.teams[0].roles[0].code).toBe('team_existing_role_requires_attention')
    await launched.page.getByRole('option', { name: /Active project project/ }).click()
    await expect(
      launched.page.getByText('Review team agent', { exact: true }).first()
    ).toBeVisible()
    await launched.page.screenshot({ path: testInfo.outputPath('team-after-enable.png') })
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(
      await launched.page.evaluate(() => window.__store!.getState().settings?.terminalFontSize)
    ).toBe(19)
    expect(
      await active.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  } finally {
    await session.dispose(active)
  }
})
