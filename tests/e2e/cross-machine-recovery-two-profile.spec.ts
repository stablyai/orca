/**
 * Cross-machine recovery export from one Orca profile and import into another, end to end.
 *
 * Why two real profiles: the contract is the descriptor that crosses machines, so only a real
 * export read back by a second runtime proves layout, dormant bindings and single-launch resume.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../src/shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../src/shared/agent-session-record'
import type { SleepingAgentSessionRecord } from '../../src/shared/agent-session-resume'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import type {
  OrcaRecoveryDescriptorV1,
  RecoveryExportResult,
  RecoveryImportResult
} from '../../src/shared/cross-machine-recovery-descriptor'
import { formatOwnedEditorFileId } from '../../src/shared/owned-editor-file-id'
import { parsePaneKey } from '../../src/shared/stable-pane-id'
import { structuredAgentSessionTabId } from '../../src/shared/structured-agent-session-projection'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  agentSessionStorePath,
  saveAgentSessionStore
} from '../../src/main/runtime/agent-session-record-store-file'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { emitClaudeHookPayload, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { createSeededTestRepo } from './helpers/seeded-test-repo'
import { getActiveWorktreeId, waitForSessionReady } from './helpers/store'
import { createFakeClaudeCli } from './helpers/fake-claude-cli'
import {
  buildFakeAgentCommandOverride,
  FAKE_AGENT_WINDOWS_SHELL
} from './helpers/fake-agent-command-override'
import { captureHiddenRendererScreenshot } from './helpers/hidden-renderer-screenshot'
import { RECOVERY_SCREENSHOT_DIR } from './helpers/cross-machine-recovery-picker-fixtures'
import {
  recoveredSessionPlaceholder as placeholder,
  unusableParts
} from './helpers/recovered-session-placeholder'

const CLI_ENTRY = path.join(process.cwd(), 'out', 'cli', 'index.js')
const TERMINAL_TAB = 'e2e-agents-terminal'
const LIVE_LEAF = '11111111-1111-4111-8111-111111111111'
const SLEEP_A_LEAF = '22222222-2222-4222-8222-222222222222'
const SLEEP_B_LEAF = '33333333-3333-4333-8333-333333333333'
const LEFT_GROUP = 'e2e-group-left'
const RIGHT_GROUP = 'e2e-group-right'
const BROWSER_TAB = 'e2e-browser-tab'
const BROWSER_WORKSPACE = 'e2e-browser-workspace'
const BROWSER_PAGE = 'e2e-browser-page'
const STRUCTURED_SESSION = 'e2e-structured-session'
const STRUCTURED_TAB = structuredAgentSessionTabId(STRUCTURED_SESSION)
const PROVIDER = {
  live: 'sess-live',
  sleepA: 'sess-sleep-a',
  sleepB: 'sess-sleep-b',
  structured: 'sess-structured'
} as const
const STRUCTURED_OPTIONS = { model: 'opus', effort: 'high' }
const APPEND_SYSTEM_PROMPT = 'You were recovered from E2E Laptop; re-read the working tree first.'

type SourceWorktree = { worktreeId: string; path: string }

function seedSourceSession(
  state: Record<string, unknown>,
  source: SourceWorktree,
  peer: SourceWorktree
): void {
  const W = source.worktreeId
  const readme = path.join(source.path, 'README.md')
  const indexTs = path.join(source.path, 'src', 'index.ts')
  const scopedEditorId = formatOwnedEditorFileId(indexTs, W, null)
  const now = Date.now()
  const tab = (
    id: string,
    entityId: string,
    groupId: string,
    contentType: 'terminal' | 'editor' | 'browser' | 'agent-session',
    label: string,
    sortOrder: number
  ) => ({
    id,
    entityId,
    groupId,
    worktreeId: W,
    contentType,
    label,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: now + sortOrder,
    ...(contentType === 'agent-session' ? { agentSessionAgent: 'claude' as const } : {})
  })
  const sleeping = (leafId: string, id: string): SleepingAgentSessionRecord => ({
    paneKey: `${TERMINAL_TAB}:${leafId}`,
    tabId: TERMINAL_TAB,
    worktreeId: W,
    agent: 'claude',
    providerSession: { key: 'session_id', id },
    prompt: `prompt for ${id}`,
    state: 'done',
    capturedAt: now,
    updatedAt: now,
    origin: 'quit'
  })
  const browserPage = {
    id: BROWSER_PAGE,
    workspaceId: BROWSER_WORKSPACE,
    worktreeId: W,
    url: 'about:blank',
    title: 'Docs',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: now
  }
  const session = (state.workspaceSession ?? getDefaultWorkspaceSession()) as WorkspaceSessionState
  const sleepingRecords = [
    sleeping(SLEEP_A_LEAF, PROVIDER.sleepA),
    sleeping(SLEEP_B_LEAF, PROVIDER.sleepB)
  ]
  const seeded: WorkspaceSessionState = {
    ...session,
    unifiedTabs: {
      ...session.unifiedTabs,
      [W]: [
        tab(TERMINAL_TAB, TERMINAL_TAB, LEFT_GROUP, 'terminal', 'Agents', 0),
        tab(readme, readme, LEFT_GROUP, 'editor', 'README.md', 1),
        tab(scopedEditorId, scopedEditorId, LEFT_GROUP, 'editor', 'index.ts', 2),
        tab(BROWSER_TAB, BROWSER_WORKSPACE, RIGHT_GROUP, 'browser', 'Docs', 3),
        tab(STRUCTURED_TAB, STRUCTURED_TAB, RIGHT_GROUP, 'agent-session', 'Structured chat', 4)
      ]
    },
    tabGroups: {
      ...session.tabGroups,
      [W]: [
        {
          id: LEFT_GROUP,
          worktreeId: W,
          activeTabId: TERMINAL_TAB,
          tabOrder: [TERMINAL_TAB, readme, scopedEditorId]
        },
        {
          id: RIGHT_GROUP,
          worktreeId: W,
          activeTabId: BROWSER_TAB,
          tabOrder: [BROWSER_TAB, STRUCTURED_TAB]
        }
      ]
    },
    tabGroupLayouts: {
      ...session.tabGroupLayouts,
      [W]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.35,
        first: { type: 'leaf', groupId: LEFT_GROUP },
        second: { type: 'leaf', groupId: RIGHT_GROUP }
      }
    },
    activeGroupIdByWorktree: { ...session.activeGroupIdByWorktree, [W]: LEFT_GROUP },
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [W]: [
        {
          id: TERMINAL_TAB,
          ptyId: null,
          worktreeId: W,
          title: 'Agents',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: now
        }
      ]
    },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [TERMINAL_TAB]: {
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { type: 'leaf', leafId: LIVE_LEAF },
          second: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', leafId: SLEEP_A_LEAF },
            second: { type: 'leaf', leafId: SLEEP_B_LEAF }
          }
        },
        activeLeafId: LIVE_LEAF,
        expandedLeafId: null
      }
    },
    // Why the peer holds index.ts first: Orca scopes an editor id to its worktree only when another
    // owner already holds the plain path, and hydration drops a scoped tab no such owner explains.
    openFilesByWorktree: {
      ...session.openFilesByWorktree,
      [peer.worktreeId]: [
        {
          filePath: indexTs,
          relativePath: path.relative(peer.path, indexTs),
          worktreeId: peer.worktreeId,
          language: 'typescript',
          isPreview: false
        }
      ],
      [W]: [
        {
          filePath: readme,
          relativePath: 'README.md',
          worktreeId: W,
          language: 'markdown',
          isPreview: false
        },
        {
          filePath: indexTs,
          relativePath: 'src/index.ts',
          worktreeId: W,
          language: 'typescript',
          isPreview: false
        }
      ]
    },
    activeFileIdByWorktree: { ...session.activeFileIdByWorktree, [W]: scopedEditorId },
    browserTabsByWorktree: {
      ...session.browserTabsByWorktree,
      [W]: [{ ...browserPage, id: BROWSER_WORKSPACE, label: 'Docs', activePageId: BROWSER_PAGE }]
    },
    browserPagesByWorkspace: {
      ...session.browserPagesByWorkspace,
      [BROWSER_WORKSPACE]: [browserPage]
    },
    activeBrowserTabIdByWorktree: {
      ...session.activeBrowserTabIdByWorktree,
      [W]: BROWSER_WORKSPACE
    },
    activeTabTypeByWorktree: { ...session.activeTabTypeByWorktree, [W]: 'terminal' },
    activeTabIdByWorktree: { ...session.activeTabIdByWorktree, [W]: TERMINAL_TAB },
    sleepingAgentSessionsByPaneKey: {
      ...session.sleepingAgentSessionsByPaneKey,
      ...Object.fromEntries(sleepingRecords.map((record) => [record.paneKey, record]))
    }
  }
  state.workspaceSession = seeded
}

async function seedStructuredRecord(userDataPath: string, worktreeId: string): Promise<void> {
  const base = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId: STRUCTURED_SESSION })
  )
  const record: AgentSessionRecord = {
    ...base,
    location: { ...base.location, workspaceId: worktreeId },
    providerHandleChain: base.providerHandleChain.map((link) => ({
      ...link,
      handle: { provider: 'claude', sessionId: PROVIDER.structured, leafUuid: null }
    })),
    options: STRUCTURED_OPTIONS
  }
  await saveAgentSessionStore(
    agentSessionStorePath(path.join(userDataPath, 'agent-sessions')),
    {
      schemaVersion: AGENT_SESSION_STORE_SCHEMA_VERSION,
      hostId: 'local',
      records: new Map([[record.sessionId, record]]),
      operations: new Map(),
      retiredClaimKeys: [],
      unreadableRecords: new Map(),
      sessionTabs: null
    },
    { primaryStatus: 'unusable-or-absent' }
  )
}

function runRecoveryCli<T>(userDataPath: string, args: string[]): T {
  const result = spawnSync(process.execPath, [CLI_ENTRY, 'recovery', ...args, '--json'], {
    env: { ...process.env, ORCA_USER_DATA_PATH: userDataPath, ORCA_DEV_CLI_INVOCATION: '1' },
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(
      `orca recovery ${args[0]} exited ${result.status}: ${result.stderr}${result.stdout}`
    )
  }
  return (JSON.parse(result.stdout) as { result: T }).result
}

async function addRepo(page: Page, repoPath: string, worktreeCount: number): Promise<string> {
  const repoId = await page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, repoPath)
  await expect
    .poll(() =>
      page.evaluate(async (repoId) => {
        const store = window.__store!
        await store.getState().fetchRepos()
        const repo = store.getState().repos.find((candidate) => candidate.id === repoId)
        if (!repo) {
          return 0
        }
        await store.getState().updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
        await store.getState().fetchWorktrees(repoId)
        return store.getState().worktreesByRepo[repoId]?.length ?? 0
      }, repoId)
    )
    .toBeGreaterThanOrEqual(worktreeCount)
  return repoId
}

function userDataPathOf(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ app }) => app.getPath('userData'))
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = `two-profile-${name}.png`
  const body = await captureHiddenRendererScreenshot(page, path.join(RECOVERY_SCREENSHOT_DIR, file))
  await testInfo.attach(file, { body, contentType: 'image/png' })
}

function ptyCount(page: Page, tabId: string): Promise<number> {
  return page.evaluate(
    (tabId) => window.__store!.getState().ptyIdsByTabId[tabId]?.length ?? 0,
    tabId
  )
}

function dormantPaneKeys(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (worktreeId) =>
      Object.values(window.__store!.getState().sleepingAgentSessionsByPaneKey)
        .filter((record) => record.worktreeId === worktreeId && record.origin === 'recovery')
        .map((record) => record.paneKey)
        .sort(),
    worktreeId
  )
}

function tabCount(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate(
    (worktreeId) => window.__store!.getState().unifiedTabsByWorktree[worktreeId]?.length ?? 0,
    worktreeId
  )
}

function expectArgvRun(argv: readonly string[], run: readonly string[]): void {
  const at = argv.indexOf(run[0])
  expect(at, `${run[0]} in ${argv.join(' ')}`).toBeGreaterThanOrEqual(0)
  expect(argv.slice(at, at + run.length)).toEqual(run)
}

// oxlint-disable-next-line no-empty-pattern -- This test owns both hidden Electron profiles.
test('exports a workspace from one profile and imports it into another', async ({}, testInfo) => {
  test.setTimeout(300_000)
  const repoA = createSeededTestRepo()
  const profileA = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  const fakeClaude = createFakeClaudeCli(
    path.join(testInfo.outputDir, 'fake-claude'),
    process.env.PATH ?? ''
  )
  const profileB = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    PATH: fakeClaude.searchPath
  })
  const running = new Set<ElectronApplication>()
  const launch = async (profile: typeof profileA) => {
    const launched = await profile.launch()
    running.add(launched.app)
    return launched
  }
  const close = async (profile: typeof profileA, app: ElectronApplication) => {
    running.delete(app)
    await profile.close(app)
  }
  try {
    let a = await launch(profileA)
    await waitForSessionReady(a.page)
    const repoAId = await addRepo(a.page, repoA, 2)
    const { source, peer } = await a.page.evaluate((repoId) => {
      const worktrees = window.__store!.getState().worktreesByRepo[repoId]!
      const describe = (isMain: boolean) => {
        const worktree = worktrees.find((candidate) => candidate.isMainWorktree === isMain)!
        return { worktreeId: worktree.id, path: worktree.path }
      }
      return { source: describe(false), peer: describe(true) }
    }, repoAId)
    const userDataA = await userDataPathOf(a.app)
    await close(profileA, a.app)
    mutateStoppedProfileState(profileA.userDataDir, (state) =>
      seedSourceSession(state, source, peer)
    )
    await seedStructuredRecord(userDataA, source.worktreeId)

    a = await launch(profileA)
    await waitForSessionReady(a.page)
    await emitClaudeHookPayload(await readHookEndpoint(a.app), {
      paneKey: `${TERMINAL_TAB}:${LIVE_LEAF}`,
      worktreeId: source.worktreeId,
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: PROVIDER.live,
        prompt: 'Keep refactoring the parser'
      }
    })
    let descriptor: OrcaRecoveryDescriptorV1 | null = null
    await expect
      .poll(() => {
        descriptor = runRecoveryCli<RecoveryExportResult>(userDataA, [
          'export',
          '--worktree',
          `id:${source.worktreeId}`
        ]).descriptor
        return descriptor.bindings
          .map((binding) => `${binding.providerSession.id}:${binding.liveness}:${binding.surface}`)
          .sort()
      })
      .toEqual([
        `${PROVIDER.live}:live:terminal`,
        `${PROVIDER.sleepA}:sleeping:terminal`,
        `${PROVIDER.sleepB}:sleeping:terminal`,
        `${PROVIDER.structured}:sleeping:structured`
      ])
    const exported = descriptor!
    const readme = path.join(source.path, 'README.md')
    const indexTs = path.join(source.path, 'src', 'index.ts')
    expect(exported.layout.tabs.map((tab) => [tab.contentType, tab.id, tab.entityId])).toEqual([
      ['terminal', TERMINAL_TAB, TERMINAL_TAB],
      ['editor', readme, readme],
      ['editor', formatOwnedEditorFileId(indexTs, source.worktreeId, null), indexTs],
      ['browser', BROWSER_TAB, BROWSER_WORKSPACE],
      ['agent-session', STRUCTURED_TAB, STRUCTURED_TAB]
    ])
    expect(exported.layout.groupLayout).toMatchObject({ type: 'split', ratio: 0.35 })
    await close(profileA, a.app)

    const checkoutRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-recovery-b-')))
    const checkoutB = path.join(checkoutRoot, 'checkout')
    execFileSync('git', ['clone', '--quiet', repoA, checkoutB])
    const descriptorFile = path.join(testInfo.outputDir, 'descriptor.json')
    writeFileSync(descriptorFile, JSON.stringify(exported))
    const launchFile = path.join(testInfo.outputDir, 'recovery-launch.json')
    writeFileSync(
      launchFile,
      JSON.stringify({ [PROVIDER.live]: { appendSystemPrompt: APPEND_SYSTEM_PROMPT } })
    )

    let b = await launch(profileB)
    await waitForSessionReady(b.page)
    // Why an override on top of PATH: the pane's login shell rebuilds PATH from the user's rc
    // files, so a bare `claude` there resolves the machine's real CLI. The `--help` probe runs
    // in main and still reads the fake off PATH.
    await b.page.evaluate(
      async ({ agentCommand, terminalWindowsShell }) => {
        await window.__store!.getState().updateSettings({
          agentCmdOverrides: { claude: agentCommand },
          terminalWindowsShell
        })
      },
      {
        agentCommand: buildFakeAgentCommandOverride(path.join(fakeClaude.binDir, 'claude')),
        terminalWindowsShell: FAKE_AGENT_WINDOWS_SHELL
      }
    )
    await addRepo(b.page, checkoutB, 1)
    const userDataB = await userDataPathOf(b.app)
    await screenshot(b.page, testInfo, '1-before-import')
    const importArgs = [
      'import',
      '--descriptor',
      descriptorFile,
      '--checkout',
      checkoutB,
      '--checkpoint',
      'ckpt-e2e-1',
      '--resume',
      PROVIDER.live,
      '--recovery-launch-file',
      launchFile,
      '--activate'
    ]
    const imported = runRecoveryCli<RecoveryImportResult>(userDataB, importArgs)
    expect(imported.disposition).toBe('imported')
    const bound = Object.fromEntries(
      imported.bindings.map((binding) => [binding.sourceProviderSessionId, binding])
    )
    expect(
      Object.fromEntries(Object.entries(bound).map(([id, binding]) => [id, binding.status]))
    ).toEqual({
      [PROVIDER.live]: 'resumed',
      [PROVIDER.sleepA]: 'dormant',
      [PROVIDER.sleepB]: 'dormant',
      [PROVIDER.structured]: 'dormant'
    })
    const worktreeB = imported.worktreeId
    const terminalTab = parsePaneKey(bound[PROVIDER.live].localPaneKey)!.tabId
    const structuredPane = bound[PROVIDER.structured].localPaneKey
    const structuredTab = parsePaneKey(structuredPane)!.tabId

    await expect.poll(() => getActiveWorktreeId(b.page)).toBe(worktreeB)
    expect(
      await b.page.evaluate(
        (worktreeId) =>
          window
            .__store!.getState()
            .unifiedTabsByWorktree[worktreeId]!.filter((tab) => tab.contentType === 'editor')
            .map((tab) => tab.entityId),
        worktreeB
      )
    ).toEqual([path.join(checkoutB, 'README.md'), path.join(checkoutB, 'src', 'index.ts')])
    await expect.poll(() => fakeClaude.launches().length).toBe(1)
    expectArgvRun(fakeClaude.launches()[0].argv, [
      '--resume',
      PROVIDER.live,
      '--append-system-prompt',
      APPEND_SYSTEM_PROMPT
    ])
    await expect(placeholder(b.page, bound[PROVIDER.sleepA].localPaneKey)).toBeVisible()
    await expect(placeholder(b.page, bound[PROVIDER.sleepB].localPaneKey)).toBeVisible()
    await expect(placeholder(b.page, bound[PROVIDER.live].localPaneKey)).toHaveCount(0)
    await expect.poll(() => ptyCount(b.page, terminalTab)).toBe(1)
    await screenshot(b.page, testInfo, '2-imported-layout')

    await b.page.evaluate((tabId) => window.__store!.getState().activateTab(tabId), structuredTab)
    await expect(placeholder(b.page, structuredPane)).toBeVisible()
    expect(await ptyCount(b.page, structuredTab)).toBe(0)
    expect(await dormantPaneKeys(b.page, worktreeB)).toEqual(
      [
        bound[PROVIDER.sleepA].localPaneKey,
        bound[PROVIDER.sleepB].localPaneKey,
        structuredPane
      ].sort()
    )
    expect(fakeClaude.launches()).toHaveLength(1)
    for (const paneKey of [
      bound[PROVIDER.sleepA].localPaneKey,
      bound[PROVIDER.sleepB].localPaneKey,
      structuredPane
    ]) {
      expect(await unusableParts(placeholder(b.page, paneKey), 'pane')).toEqual([])
    }
    await screenshot(b.page, testInfo, '3-structured-placeholder')

    await placeholder(b.page, structuredPane).getByRole('button', { name: 'Resume' }).click()
    await expect.poll(() => fakeClaude.launches().length).toBe(2)
    const structuredLaunch = fakeClaude.launches()[1].argv
    expectArgvRun(structuredLaunch, ['--resume', PROVIDER.structured])
    expectArgvRun(structuredLaunch, ['--model', STRUCTURED_OPTIONS.model])
    expect(structuredLaunch).not.toContain('--append-system-prompt')
    await expect(placeholder(b.page, structuredPane)).toHaveCount(0)
    await expect.poll(() => ptyCount(b.page, structuredTab)).toBe(1)

    const shellPane = bound[PROVIDER.sleepA].localPaneKey
    await b.page.evaluate((tabId) => window.__store!.getState().activateTab(tabId), terminalTab)
    await placeholder(b.page, shellPane)
      .getByRole('button', { name: 'Start shell instead' })
      .click()
    await expect(placeholder(b.page, shellPane)).toHaveCount(0)
    await expect.poll(() => ptyCount(b.page, terminalTab)).toBe(2)
    await expect
      .poll(() => dormantPaneKeys(b.page, worktreeB))
      .toEqual([bound[PROVIDER.sleepB].localPaneKey])
    await expect(placeholder(b.page, bound[PROVIDER.sleepB].localPaneKey)).toBeVisible()
    expect(fakeClaude.launches()).toHaveLength(2)
    await screenshot(b.page, testInfo, '4-after-resume-and-shell')

    const tabsBeforeReplay = await tabCount(b.page, worktreeB)
    const replayed = runRecoveryCli<RecoveryImportResult>(userDataB, importArgs)
    expect(replayed.disposition).toBe('replayed')
    expect(replayed.importKey).toBe(imported.importKey)
    expect(await tabCount(b.page, worktreeB)).toBe(tabsBeforeReplay)
    expect(await dormantPaneKeys(b.page, worktreeB)).toEqual([bound[PROVIDER.sleepB].localPaneKey])
    expect(fakeClaude.launches()).toHaveLength(2)

    const checkoutC = path.join(checkoutRoot, 'checkout-c')
    execFileSync('git', ['-C', checkoutB, 'worktree', 'add', '--quiet', checkoutC, '-b', 'e2e-c'])
    const bindingLessFile = path.join(testInfo.outputDir, 'descriptor-binding-less.json')
    writeFileSync(bindingLessFile, JSON.stringify({ ...exported, bindings: [] }))
    const bindingLessArgs = [
      'import',
      '--descriptor',
      bindingLessFile,
      '--checkout',
      checkoutC,
      '--checkpoint',
      'ckpt-e2e-2'
    ]
    const landed = runRecoveryCli<RecoveryImportResult>(userDataB, bindingLessArgs)
    expect(landed.disposition).toBe('imported')
    const landedTabs = await tabCount(b.page, landed.worktreeId)
    expect(landedTabs).toBeGreaterThan(0)
    await close(profileB, b.app)
    // Why: a crash after the layout write but before the provenance write leaves exactly this.
    mutateStoppedProfileState(profileB.userDataDir, (state) => {
      const meta = (state.worktreeMeta as Record<string, { recoveryProvenance?: unknown }>)[
        landed.worktreeId
      ]
      expect(meta.recoveryProvenance).toMatchObject({ importKey: landed.importKey })
      delete meta.recoveryProvenance
    })
    b = await launch(profileB)
    await waitForSessionReady(b.page)
    const retried = runRecoveryCli<RecoveryImportResult>(userDataB, bindingLessArgs)
    expect(retried.disposition).toBe('replayed')
    expect(retried.importKey).toBe(landed.importKey)
    expect(await tabCount(b.page, landed.worktreeId)).toBe(landedTabs)
    expect(fakeClaude.launches()).toHaveLength(2)
    expect(
      await b.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
      )
    ).toBe(true)
    await close(profileB, b.app)
  } finally {
    for (const app of running) {
      await closeElectronAppForE2E(app)
    }
    await profileA.dispose()
    await profileB.dispose()
  }
})
