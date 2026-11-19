import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { runProcess } from '@orca/process-host'
import { PNG } from 'pngjs'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { orcaCliResult } from './helpers/compiled-orca-cli'
import { getAllWorktreeIds, switchToWorktree, waitForActiveWorktree } from './helpers/store'

test.skip(
  process.platform !== 'darwin' || process.env.ORCA_IOS_PANE_E2E !== '1',
  'Dedicated macOS simulator job only'
)
test.setTimeout(15 * 60_000)

type AxNode = {
  role: string
  value: string
  label: string
  frame: { x: number; y: number; width: number; height: number }
  children: AxNode[]
}

type SimulatorRuntime = {
  identifier: string
  isAvailable: boolean
  supportedDeviceTypes?: { identifier: string; productFamily?: string }[]
}

async function simctl(...args: string[]): Promise<string> {
  const result = await runProcess({
    program: 'xcrun',
    args: ['simctl', ...args],
    timeoutMs: 180_000
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`simctl ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

function flatten(nodes: AxNode[]): AxNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])])
}

async function ax(userData: string, worktree: string): Promise<AxNode[]> {
  return orcaCliResult<AxNode[]>(userData, ['emulator', 'ax', '--worktree', `id:${worktree}`])
}

async function waitForSearch(userData: string, worktree: string): Promise<AxNode> {
  let field: AxNode | undefined
  await expect
    .poll(
      async () => {
        try {
          field = flatten(await ax(userData, worktree)).find(
            (node) => node.role === 'search text field' && node.frame.width > 0
          )
          return Boolean(field)
        } catch {
          return false
        }
      },
      { timeout: 45_000 }
    )
    .toBe(true)
  return field!
}

async function waitForValue(userData: string, worktree: string, value: string): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return flatten(await ax(userData, worktree)).some(
            (node) =>
              node.role === 'search text field' && node.value.toLowerCase() === value.toLowerCase()
          )
        } catch {
          return false
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true)
}

async function openPane(page: Page, deviceName: string): Promise<Locator> {
  await page
    .getByRole('button', { name: 'New tab', exact: true })
    .filter({ visible: true })
    .first()
    .click()
  await page.getByRole('button', { name: 'New Mobile Emulator', exact: true }).click()
  const pane = page.locator('[data-emulator-pane]').filter({ visible: true })
  await pane.getByRole('combobox', { name: 'Choose emulator' }).click()
  await page.getByPlaceholder('Search devices…').fill(deviceName)
  await page.getByRole('option', { name: new RegExp(deviceName) }).click()
  await expect(pane.getByText('Connected', { exact: true })).toBeVisible({ timeout: 120_000 })
  const screen = pane.getByRole('application', { name: /Emulator screen/ })
  await expect(screen).toBeVisible()
  const dismiss = pane.getByRole('button', { name: 'Not now' })
  if (await dismiss.isVisible()) {
    await dismiss.click()
  }
  return screen
}

async function luminance(screen: Locator): Promise<number> {
  const image = PNG.sync.read(await screen.screenshot())
  let total = 0
  let samples = 0
  for (let y = 0.3; y < 0.8; y += 0.05) {
    for (let x = 0.2; x < 0.8; x += 0.05) {
      const offset = (Math.floor(y * image.height) * image.width + Math.floor(x * image.width)) * 4
      total += (image.data[offset] + image.data[offset + 1] + image.data[offset + 2]) / 3
      samples += 1
    }
  }
  return total / samples
}

async function clickSearch(screen: Locator, field: AxNode): Promise<void> {
  const box = await screen.boundingBox()
  if (!box) {
    throw new Error('Emulator screen has no bounds')
  }
  await screen.click({
    position: {
      x: box.width * (field.frame.x + field.frame.width / 2),
      y: box.height * (field.frame.y + field.frame.height / 2)
    }
  })
}

async function cleanupSimulators(owned: string[]): Promise<void> {
  const failures: string[] = []
  for (const device of owned) {
    await simctl('shutdown', device).catch((error: Error) => failures.push(error.message))
    await simctl('delete', device).catch((error: Error) => failures.push(error.message))
  }
  if (failures.length) {
    throw new Error(`Simulator cleanup failed: ${failures.join('; ')}`)
  }
}

test('separate workspace panes keep their selected iOS simulator', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const manifest = process.env.ORCA_IOS_OWNED_DEVICES_FILE
  if (!manifest) {
    throw new Error('ORCA_IOS_OWNED_DEVICES_FILE is required for cleanup')
  }
  const runtimes = JSON.parse(await simctl('list', 'runtimes', '-j')) as {
    runtimes: SimulatorRuntime[]
  }
  const runtime = runtimes.runtimes.find(
    (item) => item.isAvailable && item.identifier.includes('.iOS-')
  )
  const type =
    runtime?.supportedDeviceTypes?.find((item) => item.identifier.endsWith('.iPhone-17')) ??
    runtime?.supportedDeviceTypes?.find((item) => item.productFamily === 'iPhone')
  if (!runtime || !type) {
    throw new Error('An available iOS runtime and iPhone device type are required')
  }
  console.log(`Using simulator runtime ${runtime.identifier}, device type ${type.identifier}`)
  const owned: string[] = []
  const suffix = randomUUID().slice(0, 8)
  const nameA = `OrcaPaneA-${suffix}`
  const nameB = `OrcaPaneB-${suffix}`
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const first = await waitForActiveWorktree(orcaPage)
  const second = (await getAllWorktreeIds(orcaPage)).find((id) => id !== first)
  if (!second) {
    throw new Error('The seeded second workspace is missing')
  }
  await orcaPage.setViewportSize({ width: 1440, height: 900 })
  await orcaPage.evaluate(async () => {
    await window
      .__store!.getState()
      .updateSettings({ mobileEmulatorEnabled: true, mobileEmulatorOpeningMode: 'ask' })
  })
  try {
    for (const name of [nameA, nameB]) {
      const udid = await simctl('create', name, type.identifier, runtime.identifier)
      if (!/^[0-9A-F-]{36}$/i.test(udid)) {
        throw new Error(`Invalid created simulator UDID: ${udid}`)
      }
      owned.push(udid)
      appendFileSync(manifest, `${udid}\n`)
      console.log(`Created task-owned simulator ${name}: ${udid}`)
    }
    const [deviceA, deviceB] = owned
    await simctl('boot', deviceA)
    await simctl('boot', deviceB)
    for (const device of owned) {
      await simctl('bootstatus', device)
      await simctl('spawn', device, 'notifyutil', '-s', 'com.apple.coredevice.dtuhidd.active', '0')
      await simctl('spawn', device, 'launchctl', 'kickstart', '-k', 'system/com.apple.backboardd')
      await simctl('launch', device, 'com.apple.Preferences')
    }
    await simctl('ui', deviceA, 'appearance', 'light')
    await simctl('ui', deviceB, 'appearance', 'dark')
    const screenA = await openPane(orcaPage, nameA)
    const listA = await orcaCliResult<{ sessions: { deviceUdid: string }[] }>(userData, [
      'emulator',
      'list',
      '--worktree',
      `id:${first}`
    ])
    expect(listA.sessions.map((session) => session.deviceUdid)).toContain(deviceA)
    const fieldA = await waitForSearch(userData, first)
    await expect.poll(() => luminance(screenA), { timeout: 45_000 }).toBeGreaterThan(150)
    await screenA.screenshot({ path: testInfo.outputPath('workspace-a-light.png') })
    await clickSearch(screenA, fieldA)
    await orcaPage.keyboard.type('wifi', { delay: 100 })
    await waitForValue(userData, first, 'wifi')
    await switchToWorktree(orcaPage, second)
    const screenB = await openPane(orcaPage, nameB)
    const listB = await orcaCliResult<{ sessions: { deviceUdid: string }[] }>(userData, [
      'emulator',
      'list',
      '--worktree',
      `id:${second}`
    ])
    expect(listB.sessions.map((session) => session.deviceUdid)).toContain(deviceB)
    const fieldB = await waitForSearch(userData, second)
    await expect
      .poll(
        async () => {
          const value = await luminance(screenB)
          return value > 8 && value < 110
        },
        { timeout: 45_000 }
      )
      .toBe(true)
    await screenB.screenshot({ path: testInfo.outputPath('workspace-b-dark.png') })
    expect(fieldB.value.toLowerCase()).not.toBe('wifi')
    await clickSearch(screenB, fieldB)
    await orcaPage.keyboard.type('display', { delay: 100 })
    await waitForValue(userData, second, 'display')
    await waitForValue(userData, first, 'wifi')
    const focusedB = await waitForSearch(userData, second)
    const x = focusedB.frame.x + focusedB.frame.width / 2
    const y = focusedB.frame.y + focusedB.frame.height / 2
    await orcaCliResult(userData, [
      'emulator',
      'tap',
      String(x),
      String(y),
      '--worktree',
      `id:${second}`
    ])
    await orcaCliResult(userData, ['emulator', 'type', 'cli', '--worktree', `id:${second}`])
    await waitForValue(userData, second, 'displaycli')
    await waitForValue(userData, first, 'wifi')
    for (const [worktree, device] of [
      [first, deviceA],
      [second, deviceB]
    ]) {
      const log = await orcaCliResult<{ events: { device: string }[] }>(userData, [
        'emulator',
        'exec',
        '--command',
        'event-log --json',
        '--worktree',
        `id:${worktree}`
      ])
      expect(log.events.length).toBeGreaterThan(0)
      expect(log.events.every((event) => event.device === device)).toBe(true)
    }
    await simctl('io', deviceA, 'screenshot', testInfo.outputPath('simulator-a-after-b.png'))
    await simctl('io', deviceB, 'screenshot', testInfo.outputPath('simulator-b-after-b.png'))
    await orcaCliResult(userData, ['emulator', 'kill', '--worktree', `id:${second}`])
    await waitForValue(userData, first, 'wifi')
    await orcaCliResult(userData, ['emulator', 'attach', deviceB, '--worktree', `id:${second}`])
    await waitForValue(userData, first, 'wifi')
    await waitForValue(userData, second, 'displaycli')
    await switchToWorktree(orcaPage, first)
    await expect.poll(() => luminance(screenA), { timeout: 45_000 }).toBeGreaterThan(150)
    await screenA.screenshot({ path: testInfo.outputPath('workspace-a-after-b-restart.png') })
    await switchToWorktree(orcaPage, second)
    await expect
      .poll(
        async () => {
          const value = await luminance(screenB)
          return value > 8 && value < 110
        },
        { timeout: 45_000 }
      )
      .toBe(true)
    await screenB.screenshot({ path: testInfo.outputPath('workspace-b-after-restart.png') })
  } finally {
    await cleanupSimulators(owned)
  }
})
