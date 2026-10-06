// Real profile IPC uses detected synthetic CLIs; only native folder selection is substituted.
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test as base, expect } from './orca-app'

export const test = base.extend<{ profileRoot: string }>({
  profileRoot: async ({ registerPostElectronShutdownCleanup }, provide) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-agent-profiles-'))
    mkdirSync(join(root, 'bin'))
    for (const agent of ['claude', 'codex']) {
      const executable = join(root, 'bin', agent)
      copyFileSync(join(process.cwd(), 'tests/e2e/fixtures/profile-agent.cjs'), executable)
      chmodSync(executable, 0o755)
      for (const account of ['a', 'b', 'c']) {
        mkdirSync(join(root, `${agent}-${account}`))
      }
    }
    registerPostElectronShutdownCleanup(async () => rmSync(root, { recursive: true, force: true }))
    await provide(root)
  },
  launchEnv: async ({ profileRoot }, provide) => {
    await provide({
      PATH: `${join(profileRoot, 'bin')}${delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash'
    })
  }
})

export async function prepareProfileHome(
  app: ElectronApplication,
  root: string,
  mode: 'fallback' | 'literal' | 'launch' = 'fallback'
): Promise<void> {
  const paths = await app.evaluate(({ app }) => ({
    home: app.getPath('home'),
    userData: app.getPath('userData'),
    envHome: process.env.HOME
  }))
  expect(paths.home).toBe(join(paths.userData, 'home'))
  expect(paths.envHome).toBe(paths.home)
  expect(paths.home).not.toBe(tmpdir())
  const rc = [
    ...(mode === 'launch'
      ? [
          `export CLAUDE_CONFIG_DIR='${join(root, 'wrong-home')}'`,
          `export CODEX_HOME='${join(root, 'wrong-home')}'`
        ]
      : []),
    `alias claude_profile='CLAUDE_CONFIG_DIR="${join(root, 'claude-b')}" claude'`,
    `alias codex_profile='CODEX_HOME="${join(root, 'codex-b')}" codex'`,
    ...(mode === 'fallback' ? ['function unsupported_profile() { echo must-not-run; }'] : [])
  ].join('\n')
  writeFileSync(join(paths.home, '.bashrc'), rc)
  writeFileSync(join(paths.home, '.bash_profile'), mode === 'launch' ? '. "$HOME/.bashrc"\n' : '')
}

export async function openAgentSettings(page: Page, theme?: 'light' | 'dark'): Promise<void> {
  await page.evaluate(async (theme) => {
    const state = window.__store!.getState()
    if (theme) {
      await state.updateSettingsOrThrow({ theme, experimentalStructuredNativeChat: true })
    }
    state.openSettingsTarget({ pane: 'agents', repoId: null })
    state.openSettingsPage()
  }, theme)
}

export function profileSection(page: Page, agent: 'claude' | 'codex') {
  return page.getByRole('region', { name: 'Agent profiles' }).nth(agent === 'claude' ? 0 : 1)
}

export async function chooseProfileFolder(app: ElectronApplication, page: Page, folder: string) {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, folder)
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await expect(page.getByLabel('Configuration folder', { exact: true })).toHaveValue(folder)
}

export async function captureProfileWindow(page: Page, info: TestInfo, name: string) {
  const directory = process.env.ORCA_PROFILE_EVIDENCE_DIR
  const target = directory ? join(directory, `${name}.png`) : info.outputPath(`${name}.png`)
  await page.screenshot({ path: target, animations: 'disabled' })
  await info.attach(name, { path: target, contentType: 'image/png' })
}
