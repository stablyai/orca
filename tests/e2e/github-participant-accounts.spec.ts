import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import { expect, test as base } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

const fakeGhDirectory = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-member-gh-'))
const noGitHubCredentials = {
  GH_TOKEN: '',
  GITHUB_TOKEN: '',
  GH_ENTERPRISE_TOKEN: '',
  GITHUB_ENTERPRISE_TOKEN: ''
}
const fakeGhSource = `
const args = process.argv.slice(2)
if (args[0] === 'auth' && args[1] === 'status') {
  console.log('github.com')
  for (const user of ['owner-fixture', 'alice-fixture', 'bob-fixture']) {
    console.log('  Logged in to github.com account ' + user + ' (keyring)')
    console.log('  Active account: ' + (user === 'owner-fixture'))
    console.log('  Token scopes: repo, read:org, project')
  }
} else if (args[0] === 'auth' && args[1] === 'token') {
  console.log(args.includes('--help') ? '--user string --hostname string' : 'e2e-not-a-real-token')
} else if (args[0] === 'api' && args.includes('user')) {
  console.log(JSON.stringify({ login: 'owner-fixture' }))
} else if (args[0] === '--version') {
  console.log('gh version 2.80.0')
} else {
  console.error('Fixture GitHub command is not implemented')
  process.exitCode = 1
}
`

if (process.platform === 'win32') {
  writeFileSync(path.join(fakeGhDirectory, 'fake-gh.js'), fakeGhSource)
  writeFileSync(
    path.join(fakeGhDirectory, 'gh.cmd'),
    '@echo off\r\nnode "%~dp0\\fake-gh.js" %*\r\n'
  )
} else {
  const executable = path.join(fakeGhDirectory, 'gh')
  writeFileSync(executable, `#!/usr/bin/env node\n${fakeGhSource}`)
  chmodSync(executable, 0o755)
}

const test = base.extend({
  launchEnv: {
    PATH: `${fakeGhDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    ...(process.platform === 'win32' ? {} : { SHELL: '/bin/bash' }),
    ...noGitHubCredentials
  }
})

test.afterAll(() => rmSync(fakeGhDirectory, { recursive: true, force: true }))

async function openProjectSettings(page: Page, repoId: string): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await page.evaluate((id) => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'repo', repoId: id })
    state.openSettingsPage()
  }, repoId)
  await expect(page.getByPlaceholder('Search settings')).toBeVisible()
}

async function devicesOnServer(page: Page, repo: string): Promise<string[]> {
  return page.evaluate(async (repo) => {
    const response = await window.api.runtime.call({
      method: 'github.participants.status',
      params: { repo }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const value = response.result
    if (
      !value ||
      typeof value !== 'object' ||
      !('devices' in value) ||
      !Array.isArray(value.devices)
    ) {
      throw new Error('Owner status did not return paired devices')
    }
    return value.devices.map((device: unknown) => {
      if (
        !device ||
        typeof device !== 'object' ||
        !('deviceId' in device) ||
        typeof device.deviceId !== 'string'
      ) {
        throw new Error('Invalid paired device')
      }
      return device.deviceId
    })
  }, repo)
}

test('the owner enrolls two devices as one member and each member selects only their own account', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  // Three isolated paired desktops initialize before exercising both owner and member settings.
  test.setTimeout(240_000)
  // Refresh the shell PATH cache from the disposable home so later CLI detection retains the fixture.
  if (process.platform !== 'win32') {
    const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
    writeFileSync(
      path.join(home, '.bash_profile'),
      `export PATH=${quotePosixShell(fakeGhDirectory)}:"$PATH"\n`
    )
    await orcaPage.evaluate(() => window.api.preflight.refreshAgents())
  }
  const fixtureRepo = await orcaPage.evaluate(() => {
    const repo = window.__store!.getState().repos[0]
    if (!repo) {
      throw new Error('Missing fixture project')
    }
    return { id: repo.id, path: repo.path }
  })
  const repoId = fixtureRepo.id
  const inventory = await orcaPage.evaluate(
    (repo) =>
      window.api.gh.listBindableAccounts({
        repoId: repo.id,
        repoPath: repo.path,
        refreshCapability: true
      }),
    fixtureRepo
  )
  expect(inventory).toMatchObject({
    capability: 'supported',
    accounts: expect.arrayContaining([
      expect.objectContaining({ user: 'owner-fixture', source: 'keyring' }),
      expect.objectContaining({ user: 'alice-fixture', source: 'keyring' }),
      expect.objectContaining({ user: 'bob-fixture', source: 'keyring' })
    ])
  })
  const clients: PairedElectronClient[] = []
  const pairedDeviceIds: string[] = []
  try {
    for (let index = 0; index < 3; index += 1) {
      const before = await devicesOnServer(orcaPage, repoId)
      const offer = await createRuntimeDesktopPairingOffer(orcaPage)
      clients.push(
        await launchPairedElectronClient(offer, testInfo, 'Shared member server', {
          extraEnv: noGitHubCredentials
        })
      )
      await expect
        .poll(async () => (await devicesOnServer(orcaPage, repoId)).length)
        .toBe(before.length + 1)
      const added = (await devicesOnServer(orcaPage, repoId)).find((id) => !before.includes(id))
      if (!added) {
        throw new Error('Pairing did not register a device')
      }
      pairedDeviceIds.push(added)
    }

    await openProjectSettings(orcaPage, repoId)
    const mode = orcaPage.getByRole('switch', { name: 'Use separate GitHub accounts for members' })
    await expect(mode).not.toBeChecked()
    await orcaPage.getByRole('button', { name: 'Refresh GitHub accounts' }).click()
    await expect(orcaPage.getByRole('combobox', { name: 'Account', exact: true })).toBeEnabled()
    await orcaPage.getByRole('combobox', { name: 'Account', exact: true }).click()
    await orcaPage.getByRole('option', { name: /owner-fixture/ }).click()
    await expect(orcaPage.getByRole('combobox', { name: 'Account', exact: true })).toContainText(
      'owner-fixture'
    )
    const sharedScreenshot = testInfo.outputPath('shared-project-account.png')
    await orcaPage.screenshot({ path: sharedScreenshot })
    await testInfo.attach('shared-project-account', {
      path: sharedScreenshot,
      contentType: 'image/png'
    })

    for (const [name, deviceIds, account] of [
      ['Alice', pairedDeviceIds.slice(0, 2), 'alice-fixture'],
      ['Bob', pairedDeviceIds.slice(2), 'bob-fixture']
    ] as const) {
      await orcaPage.getByRole('button', { name: 'Add member', exact: true }).click()
      const editor = orcaPage.locator('form').filter({ has: orcaPage.getByLabel('Member name') })
      await editor.getByLabel('Member name').fill(name)
      const deviceOrder = await devicesOnServer(orcaPage, repoId)
      const deviceChoices = editor
        .getByRole('group', { name: 'Paired devices' })
        .getByRole('checkbox')
      for (const id of deviceIds) {
        await deviceChoices.nth(deviceOrder.indexOf(id)).check()
      }
      await editor.getByRole('checkbox', { name: `${account} @ github.com` }).check()
      await editor.getByRole('button', { name: 'Save member', exact: true }).click()
      await expect(editor).toHaveCount(0)
      await expect(orcaPage.getByText(name, { exact: true })).toBeVisible()
    }
    await mode.check()
    await expect(mode).toBeChecked()
    const ownerScreenshot = testInfo.outputPath('owner-member-assignments.png')
    await orcaPage.screenshot({ path: ownerScreenshot })
    await testInfo.attach('owner-member-assignments', {
      path: ownerScreenshot,
      contentType: 'image/png'
    })

    for (const [index, client] of clients.entries()) {
      const name = index < 2 ? 'Alice' : 'Bob'
      const account = index < 2 ? 'alice-fixture' : 'bob-fixture'
      await openProjectSettings(client.page, repoId)
      await expect(client.page.getByText(`Member: ${name}`, { exact: true })).toBeVisible()
      await expect(
        client.page.getByRole('switch', { name: 'Use separate GitHub accounts for members' })
      ).toHaveCount(0)
      await expect(client.page.getByRole('combobox', { name: 'Account', exact: true })).toHaveCount(
        0
      )
      const picker = client.page.getByRole('combobox', {
        name: 'Your GitHub account for this project'
      })
      if (index === 1) {
        await expect(picker).toContainText('alice-fixture')
      }
      await picker.click()
      await expect(client.page.getByRole('option', { name: /owner-fixture/ })).toHaveCount(0)
      await expect(
        client.page.getByRole('option', { name: index < 2 ? /bob-fixture/ : /alice-fixture/ })
      ).toHaveCount(0)
      await client.page
        .getByRole('option', { name: `${account} @ github.com`, exact: true })
        .click()
      await expect(picker).toContainText(account)
    }

    const denied = await clients[2].page.evaluate(
      ({ repo, environmentId }) =>
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'repo.update',
          params: { repo, updates: { ghAccount: { host: 'github.com', user: 'bob-fixture' } } }
        }),
      { repo: repoId, environmentId: clients[2].environmentId }
    )
    expect(denied).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('instead of the shared project binding') }
    })

    const userDataDirectory = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const { activeProfileId } = await orcaPage.evaluate(() => window.api.orcaProfiles.list())
    const persisted = JSON.parse(
      readFileSync(
        path.join(userDataDirectory, 'profiles', activeProfileId, 'github-participants.json'),
        'utf8'
      )
    )
    expect(persisted).toMatchObject({
      enabledRepoIds: [repoId],
      participants: [
        {
          name: 'Alice',
          deviceIds: pairedDeviceIds.slice(0, 2),
          allowedAccounts: [{ host: 'github.com', user: 'alice-fixture' }]
        },
        {
          name: 'Bob',
          deviceIds: pairedDeviceIds.slice(2),
          allowedAccounts: [{ host: 'github.com', user: 'bob-fixture' }]
        }
      ],
      selections: expect.arrayContaining([
        expect.objectContaining({ repoId, account: { host: 'github.com', user: 'alice-fixture' } }),
        expect.objectContaining({ repoId, account: { host: 'github.com', user: 'bob-fixture' } })
      ])
    })

    await expect(orcaPage.getByRole('combobox', { name: 'Account', exact: true })).toContainText(
      'owner-fixture'
    )
    await expect(
      clients[0].page.getByRole('combobox', { name: 'Your GitHub account for this project' })
    ).toContainText('alice-fixture')
    const memberScreenshot = testInfo.outputPath('paired-member-personal-account.png')
    await clients[2].page.screenshot({ path: memberScreenshot })
    await testInfo.attach('paired-member-personal-account', {
      path: memberScreenshot,
      contentType: 'image/png'
    })
  } finally {
    for (const client of clients.toReversed()) {
      await client.dispose()
    }
  }
})
