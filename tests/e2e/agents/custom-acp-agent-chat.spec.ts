import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import {
  attachRepoAndOpenTerminal,
  createRestartSession
} from '../desktop/electron-fixtures/orca-restart'
import { createSeededTestRepo } from '../workspaces/repository-fixtures/seeded-test-repo'

const STUB_AGENT = path.join(__dirname, 'session-fixtures', 'stub-acp-agent.mjs')

// A host reads its custom ACP agents when it starts, so the profile carries them before launch.
test('a custom ACP agent from settings opens as a chat from the + menu', async () => {
  const session = createRestartSession(test.info())
  const profilePath = path.join(session.userDataDir, 'orca-data.json')
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  profile.settings.customAcpAgents = [
    { id: 'stub', name: 'Stub Agent', command: process.execPath, args: [STUB_AGENT], env: {} }
  ]
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`)
  const { app, page } = await session.launch()
  try {
    await attachRepoAndOpenTerminal(page, createSeededTestRepo())
    await page.getByRole('button', { name: 'New tab' }).click({ force: true })
    const item = page.getByRole('menuitem', { name: 'Stub Agent' })
    await expect(item).toBeVisible({ timeout: 30_000 })
    await item.click()
    // The new chat is named after the agent until its first message names it.
    await expect(page.getByText('Start a chat with Stub Agent')).toBeVisible({ timeout: 30_000 })
    const composer = page.locator('.ProseMirror').last()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.click()
    await page.keyboard.type('hello')
    await page.keyboard.press('Enter')
    await expect(page.getByText('stub agent heard: hello', { exact: true })).toBeVisible({
      timeout: 30_000
    })
  } finally {
    await session.dispose(app)
  }
})
