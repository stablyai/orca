import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'

const STUB_AGENT_DIR = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'golden-stub-agent')
const LAUNCH_ENV = { PATH: `${STUB_AGENT_DIR}${path.delimiter}${process.env.PATH ?? ''}` }

function grokConfigPath(userDataDir: string): string {
  return path.join(userDataDir, 'home', '.grok', 'hooks', 'orca-status.json')
}

async function waitForManagedConfig(configPath: string): Promise<void> {
  await expect
    .poll(
      () => {
        if (!existsSync(configPath)) {
          return false
        }
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
          hooks?: Record<string, unknown>
        }
        return Boolean(config.hooks?.SessionStart && config.hooks?.UserPromptSubmit)
      },
      { timeout: 30_000, message: 'Orca did not install the managed Grok hook config' }
    )
    .toBe(true)
}

test('removes the managed Grok hook config on quit', async (// oxlint-disable-next-line no-empty-pattern -- this test owns its Electron launch.
{}, testInfo) => {
  test.skip(process.platform !== 'win32', 'POSIX hooks are pane-guarded and stay installed')
  const session = createRestartSession(testInfo, LAUNCH_ENV)
  const configPath = grokConfigPath(session.userDataDir)
  let app: ElectronApplication | null = null
  try {
    const launch = await session.launch()
    app = launch.app
    await waitForManagedConfig(configPath)

    await session.close(app)
    app = null

    expect(existsSync(configPath)).toBe(false)
  } finally {
    if (app) {
      await session.close(app).catch(() => undefined)
    }
    await session.dispose()
  }
})

test('preserves a user-cleared Grok config through quit and relaunch', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
{}, testInfo) => {
  const session = createRestartSession(testInfo, LAUNCH_ENV)
  const configPath = grokConfigPath(session.userDataDir)
  const userClearedConfig = '{  "hooks" : {}  }\n'
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForManagedConfig(configPath)
    writeFileSync(configPath, userClearedConfig)

    await session.close(app)
    app = null
    expect(readFileSync(configPath, 'utf8')).toBe(userClearedConfig)

    const second = await session.launch()
    app = second.app
    await expect
      .poll(() => readFileSync(configPath, 'utf8'), { timeout: 10_000 })
      .toBe(userClearedConfig)

    await session.close(app)
    app = null
    expect(readFileSync(configPath, 'utf8')).toBe(userClearedConfig)
  } finally {
    if (app) {
      await session.close(app).catch(() => undefined)
    }
    await session.dispose()
  }
})
