import { _electron as electron, expect, test } from '@stablyai/playwright-test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'

// Why no event to await: startup hook reconciliation is fire-and-forget, so give it a bounded window.
const STARTUP_WRITE_WINDOW_MS = 15_000

const SEEDED_HOME_FILES: Record<string, string> = {
  '.claude/settings.json': '{\n  "hooks": {}\n}\n',
  '.codex/config.toml': 'model = "gpt-5"\n',
  '.codex/hooks.json': '{\n  "hooks": {}\n}\n',
  '.copilot/config.json': '{}\n'
}

// Why an allowlist: Chromium and child shells create caches under HOME; the contract covers agent
// CLIs' own config, trust files and credentials. ~/.orca is Orca's own data except agent-hooks, which
// agent configs reference.
const AGENT_CONFIG_ROOTS = [
  '.claude',
  '.claude.json',
  '.codex',
  '.cursor',
  '.copilot',
  '.gemini',
  '.factory',
  '.commandcode',
  '.hermes',
  '.kimi-code',
  '.grok',
  '.pi',
  '.prime',
  '.zcode',
  path.join('.config', 'amp'),
  path.join('.config', 'devin'),
  path.join('.config', 'opencode'),
  path.join('.orca', 'agent-hooks')
]

function changedAgentConfigPaths(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort()
}

// Why tolerate ENOENT: a file can vanish between readdir and read while the app is running.
function readIfPresent<T>(read: () => T): T | null {
  try {
    return read()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function snapshotAgentConfig(home: string): Map<string, string> {
  const files = new Map<string, string>()
  const visit = (relativePath: string): void => {
    const full = path.join(home, relativePath)
    const stats = readIfPresent(() => statSync(full))
    if (!stats) {
      return
    }
    if (stats.isDirectory()) {
      files.set(`${relativePath}/`, '')
      for (const entry of readIfPresent(() => readdirSync(full)) ?? []) {
        visit(path.join(relativePath, entry))
      }
      return
    }
    const contents = readIfPresent(() => readFileSync(full, 'utf-8'))
    if (contents !== null) {
      files.set(relativePath, contents)
    }
  }
  for (const root of AGENT_CONFIG_ROOTS) {
    visit(root)
  }
  return files
}

async function runOrcaAgainstSeededHome(isolated: boolean) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-isolation-'))
  const workspacePath = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-isolation-workspace-'))
  const profile = getE2ECompletedOnboardingProfile()
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(
      { ...profile, settings: { ...profile.settings, isolateExternalAgentConfig: isolated } },
      null,
      2
    )}\n`
  )
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const homeIsolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir
  })
  for (const [relativePath, contents] of Object.entries(SEEDED_HOME_FILES)) {
    const target = path.join(homeIsolation.isolatedHome, relativePath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  const before = snapshotAgentConfig(homeIsolation.isolatedHome)

  const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
  const app = await electron.launch({
    args: getOrcaElectronLaunchArgs(mainPath, false),
    env: {
      ...homeIsolation.env,
      NODE_ENV: 'development',
      ORCA_E2E_HEADLESS: '1',
      ORCA_BACKGROUND_LAUNCH: '1'
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (workspace) => {
      for (const preset of ['cursor', 'copilot', 'codex', 'antigravity'] as const) {
        await window.api.agentTrust.markTrusted({ preset, workspacePath: workspace })
      }
    }, workspacePath)
    await page.waitForTimeout(STARTUP_WRITE_WINDOW_MS)
    return { before, after: snapshotAgentConfig(homeIsolation.isolatedHome) }
  } finally {
    await closeElectronAppForE2E(app)
    await cleanupE2EDaemons(userDataDir)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(workspacePath, { recursive: true, force: true })
  }
}

test.describe('external agent config isolation', () => {
  test.describe.configure({ timeout: 120_000 })

  test('writes no agent config into HOME when isolated', async () => {
    const { before, after } = await runOrcaAgainstSeededHome(true)
    expect(changedAgentConfigPaths(before, after)).toEqual([])
  })

  test('negative control: writes agent config into HOME when not isolated', async () => {
    const { before, after } = await runOrcaAgainstSeededHome(false)
    expect(changedAgentConfigPaths(before, after)).not.toEqual([])
  })
})
