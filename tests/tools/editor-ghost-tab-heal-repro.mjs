#!/usr/bin/env node
/**
 * Background repro for duplicate / mis-owned editor records in a persisted workspace session.
 *
 * A store written before the editor write-path dedupe can hold several OpenFile records for one
 * (worktree, path), and several editor tabs pointing at them. Closing such a tab leaves a sibling
 * behind, and the tab comes back on Ctrl+Tab or at the next restart. Hydration now heals those
 * records once. This tool proves that on a real store instead of a fixture: it copies an
 * orca-data.json into an isolated user-data dir, launches the built app hidden, and records what
 * the heal did, what closing the tabs did, and whether anything came back.
 *
 * Build first, then run:
 *   npx electron-vite build --mode e2e
 *   ORCA_BACKGROUND_LAUNCH=1 node tests/tools/editor-ghost-tab-heal-repro.mjs --data <copy-of-orca-data.json>
 *
 * Options:
 *   --data <file>      orca-data.json to replay. Defaults to the `local-default` profile under the
 *                      platform's Orca userData directory.
 *   --worktree <key>   Workspace key to inspect. Default: the auto-detected worktree with the most
 *                      affected paths.
 *   --path <file>      Absolute file path to track; repeatable. Default: every affected path the
 *                      scan found in the chosen worktree.
 *   --presses <n>      tab.previousRecent presses after closing (default 5).
 *   --keep             Keep the temporary run directory (it is kept on failure regardless).
 *
 * The source orca-data.json is only ever READ, and the copy the app launches from is sanitized
 * first. Every write goes to a fresh mkdtemp run directory, so the developer's profile cannot be
 * touched. Three things leave the copy: persisted terminal tabs lose `launchAgent`, so a tab whose
 * PTY is gone cannot relaunch an agent CLI; persisted editor rows lose `dirtyDraftContent` and
 * `lastKnownDiskSignature`; and `editorAutoSave` is forced off. The last two matter because the
 * copied rows keep ABSOLUTE file paths — a restored dirty draft would otherwise be autosaved
 * straight into the developer's real file. This tool investigates tab identity, not drafts.
 *
 * Stripping the drafts changes what the heal does with duplicates: a drafted record would otherwise
 * win `pickSurvivor`, and the divergent-draft branch that keeps two rows apart never runs here. The
 * identity repro is unaffected — every shape it tracks is decided by (worktree, owner, path).
 *
 * Tabs are matched to paths through `editorEntityPath`, because a healed record's tab carries the
 * owned `editor:<worktree>:<runtime>:<path>` id rather than the bare path.
 *
 * Exit codes: 0 healed and nothing came back, 1 a tracked path survived, 2 nothing to repro.
 */

import { _electron as electron } from '@stablyai/playwright-test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EDITOR_ENTITY_PATH_INIT_SCRIPT,
  editorEntityPath,
  persistedShape,
  printScanTable,
  scanWorkspaceSession
} from './editor-ghost-tab-session-scan.mjs'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Requires ORCA_BACKGROUND_LAUNCH=1')
}

const PROFILE_ID = 'local-default'
const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const MAIN_ENTRY = path.join(REPO_ROOT, 'out', 'main', 'index.js')

function argValues(name) {
  const prefix = `--${name}`
  const values = []
  for (const [index, arg] of process.argv.entries()) {
    if (arg === prefix) {
      values.push(process.argv[index + 1])
    } else if (arg.startsWith(`${prefix}=`)) {
      values.push(arg.slice(prefix.length + 1))
    }
  }
  return values.filter((value) => typeof value === 'string' && value.length > 0)
}

function argValue(name, fallback = null) {
  return argValues(name).at(-1) ?? fallback
}

/** Mirrors src/cli/runtime/metadata.ts getDefaultUserDataPath so both find the same profile. */
function defaultUserDataPath(platform = process.platform, homeDir = os.homedir()) {
  if (process.env.ORCA_USER_DATA_PATH) {
    return process.env.ORCA_USER_DATA_PATH
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'orca')
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) {
      throw new Error(
        'APPDATA is not set, so the Orca profile path cannot be resolved; pass --data'
      )
    }
    return path.join(appData, 'orca')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'orca')
}

function defaultDataFile() {
  return path.join(defaultUserDataPath(), 'profiles', PROFILE_ID, 'orca-data.json')
}

/** Runs in the renderer against the dev-exposed store; returns only the fields under test. */
const readStore = ({ worktreeId, paths }) => {
  const state = window.__store?.getState()
  if (!state) {
    return { storeReady: false }
  }
  const repoId = worktreeId.split('::')[0]
  const records = (state.openFiles ?? []).filter(
    (file) => file.worktreeId === worktreeId && paths.includes(file.filePath)
  )
  const allTabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  const entityPath = window.__editorEntityPath
  const tabs = allTabs.filter((tab) => paths.includes(entityPath(tab.entityId)))
  const tabEntityById = new Map(allTabs.map((tab) => [tab.id, tab.entityId]))
  return {
    storeReady: true,
    workspaceSessionReady: state.workspaceSessionReady,
    activeWorktreeId: state.activeWorktreeId,
    activeFileId: state.activeFileId,
    activeTabType: state.activeTabType,
    worktreeCatalogRows: (state.worktreesByRepo?.[repoId] ?? [])
      .filter((row) => row.id === worktreeId)
      .map((row) => ({
        hostId: row.hostId ?? null,
        runtimeOwnerEnvironmentId: row.runtimeOwnerEnvironmentId ?? null
      })),
    detectedWorktreeRows: (state.detectedWorktreesByRepo?.[repoId]?.worktrees ?? [])
      .filter((row) => row.id === worktreeId)
      .map((row) => ({ hostId: row.hostId ?? null })),
    openFileRecords: records.map((file) => ({
      id: file.id,
      filePath: file.filePath,
      runtimeEnvironmentId: file.runtimeEnvironmentId?.trim() || null,
      isDirty: file.isDirty === true
    })),
    openFileCountByPath: Object.fromEntries(
      paths.map((p) => [p, records.filter((file) => file.filePath === p).length])
    ),
    editorTabsForPaths: tabs.map((tab) => ({
      id: tab.id,
      entityId: tab.entityId,
      executionHostId: tab.executionHostId ?? null,
      contentType: tab.contentType,
      groupId: tab.groupId
    })),
    totalTabCount: allTabs.length,
    tabsByContentType: allTabs.reduce((counts, tab) => {
      counts[tab.contentType] = (counts[tab.contentType] ?? 0) + 1
      return counts
    }, {}),
    groups: (state.groupsByWorktree?.[worktreeId] ?? []).map((group) => ({
      id: group.id,
      activeTabId: group.activeTabId,
      tabOrder: group.tabOrder ?? [],
      recentTabIds: group.recentTabIds ?? [],
      // A group entry still naming a tracked path is a ghost the tab strip can bring back.
      pathReferences: [...(group.tabOrder ?? []), ...(group.recentTabIds ?? [])]
        .map((id) => ({ id, path: entityPath(tabEntityById.get(id) ?? id) }))
        .filter((reference) => paths.includes(reference.path))
    })),
    recentlyClosedEditorTabs: (state.recentlyClosedEditorTabsByWorktree?.[worktreeId] ?? []).map(
      (snapshot) => snapshot.filePath ?? null
    )
  }
}

/**
 * Walk the MRU through every tracked editor tab and then a terminal tab, so the editor tabs sit
 * directly behind the active tab — the slot tab.previousRecent targets, and the one a ghost
 * would return from.
 */
const walkMostRecentlyUsed = async ({ worktreeId, paths }) => {
  const store = window.__store
  const steps = []
  for (const filePath of paths) {
    const tab = (store.getState().unifiedTabsByWorktree?.[worktreeId] ?? []).find(
      (candidate) => window.__editorEntityPath(candidate.entityId) === filePath
    )
    if (!tab) {
      steps.push({ filePath, activated: false })
      continue
    }
    store.getState().setActiveFile(tab.entityId)
    store.getState().activateTab?.(tab.id)
    store.getState().setActiveTabType('editor')
    await new Promise((resolve) => setTimeout(resolve, 300))
    steps.push({ filePath, activated: true })
  }
  const terminalTab = (store.getState().unifiedTabsByWorktree?.[worktreeId] ?? []).find(
    (tab) => tab.contentType === 'terminal'
  )
  if (terminalTab) {
    store.getState().setActiveTab(terminalTab.entityId)
    store.getState().activateTab?.(terminalTab.id)
    store.getState().setActiveTabType('terminal')
    await new Promise((resolve) => setTimeout(resolve, 300))
    steps.push({ terminalTabId: terminalTab.id, activated: true })
  }
  const group = (store.getState().groupsByWorktree?.[worktreeId] ?? [])[0]
  return { steps, recentTabIds: group?.recentTabIds ?? [], activeTabId: group?.activeTabId ?? null }
}

const closeTrackedFiles = ({ worktreeId, paths }) => {
  const ids = (window.__store.getState().openFiles ?? [])
    .filter((file) => file.worktreeId === worktreeId && paths.includes(file.filePath))
    .map((file) => file.id)
  for (const id of ids) {
    window.__store.getState().closeFile(id)
  }
  return ids
}

const readActiveTab = (worktreeId) => {
  const state = window.__store.getState()
  const group = (state.groupsByWorktree?.[worktreeId] ?? [])[0]
  return {
    groupActiveTabId: group?.activeTabId ?? null,
    activeFileId: state.activeFileId,
    activeTabType: state.activeTabType
  }
}

const PROFILE_INDEX = {
  schemaVersion: 1,
  activeProfileId: PROFILE_ID,
  profiles: [
    {
      id: PROFILE_ID,
      name: 'Personal',
      avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
      kind: 'local',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now()
    }
  ]
}

function makeUserDataDir(runRoot, name, data) {
  const userDataDir = path.join(runRoot, name)
  const profileDir = path.join(userDataDir, 'profiles', PROFILE_ID)
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(path.join(userDataDir, 'home'), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(profileDir, 'orca-data.json'), `${JSON.stringify(data)}\n`)
  writeFileSync(
    path.join(userDataDir, 'orca-profile-index.json'),
    `${JSON.stringify(PROFILE_INDEX, null, 2)}\n`
  )
  return { userDataDir, dataFile: path.join(profileDir, 'orca-data.json') }
}

/** A restored tab whose PTY died must not relaunch an agent CLI in someone's checkout. */
function stripLaunchAgents(data) {
  let stripped = 0
  const sessions = [data.workspaceSession, ...Object.values(data.workspaceSessionsByHostId ?? {})]
  for (const session of sessions) {
    for (const tabs of Object.values(session?.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        if (tab.launchAgent) {
          delete tab.launchAgent
          stripped++
        }
      }
    }
  }
  return stripped
}

/** The copy keeps absolute paths, so a restored draft is a draft over the developer's real file. */
function stripPersistedEditorDrafts(data) {
  let stripped = 0
  const sessions = [data.workspaceSession, ...Object.values(data.workspaceSessionsByHostId ?? {})]
  for (const session of sessions) {
    for (const files of Object.values(session?.openFilesByWorktree ?? {})) {
      for (const file of files) {
        if (file.dirtyDraftContent !== undefined) {
          delete file.dirtyDraftContent
          stripped++
        }
        delete file.lastKnownDiskSignature
      }
    }
  }
  return stripped
}

/** Second lock on the same door: nothing typed during the run reaches disk either. */
function disableEditorAutoSave(data) {
  data.settings = { ...data.settings, editorAutoSave: false }
  return true
}

/**
 * Quit without hanging. App quit deliberately leaves the terminal daemon alive for warm reattach,
 * and that detached process keeps Playwright's `close()` waiting on inherited pipes forever, so the
 * daemon this run started is stopped by pid — the same contract as cleanupE2EDaemons in tests/e2e.
 */
async function shutdown(app, userDataDir) {
  // Read the pid first: once close() resolves, Playwright disposes the app and process() throws.
  let appPid = null
  try {
    appPid = app.process()?.pid ?? null
  } catch {
    // The app is already gone.
  }
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 15_000))
  ])
  const daemonDir = path.join(userDataDir, 'daemon')
  const pidFiles = existsSync(daemonDir)
    ? readdirSync(daemonDir).filter((entry) => entry.endsWith('.pid'))
    : []
  for (const entry of pidFiles) {
    const raw = readFileSync(path.join(daemonDir, entry), 'utf8').trim()
    let pid = Number(raw)
    try {
      pid = Number(JSON.parse(raw).pid)
    } catch {
      // A bare pid file, already parsed above.
    }
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
  if (appPid) {
    try {
      process.kill(appPid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

async function launchHidden(userDataDir, healLines) {
  const {
    ELECTRON_RUN_AS_NODE: _runAsNode,
    HOME: _home,
    USERPROFILE: _userProfile,
    ...cleanEnv
  } = process.env
  const isolatedHome = realpathSync.native(path.join(userDataDir, 'home'))
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...cleanEnv,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      ORCA_E2E_HOME_DIR: isolatedHome,
      ORCA_E2E_USER_DATA_DIR: userDataDir,
      ORCA_E2E_HEADLESS: '1',
      ORCA_BACKGROUND_LAUNCH: '1',
      NODE_ENV: 'development'
    }
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.addInitScript(EDITOR_ENTITY_PATH_INIT_SCRIPT)
  await page.evaluate(EDITOR_ENTITY_PATH_INIT_SCRIPT)
  page.on('console', (message) => {
    const text = message.text()
    if (text.includes('[editor-hydration]')) {
      healLines.push(text)
      console.error(`[heal-repro] ${text}`)
    }
  })
  const resolvedHome = await app.evaluate(({ app }) => app.getPath('home'))
  if (path.resolve(resolvedHome) !== path.resolve(isolatedHome)) {
    throw new Error('Electron HOME escaped the disposable profile boundary')
  }
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 60_000 })
  await page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    {
      timeout: 120_000
    }
  )
  await page.waitForTimeout(4_000)
  return { app, page }
}

const dataFile = argValue('data', defaultDataFile())
const pressCount = Number(argValue('presses', '5'))
const keepRunRoot = process.argv.includes('--keep')
const source = JSON.parse(readFileSync(dataFile, 'utf8'))
const affectedByWorktree = scanWorkspaceSession(source.workspaceSession)
const requestedWorktree = argValue('worktree')
const requestedPaths = argValues('path')

if (affectedByWorktree.size === 0 && !requestedWorktree) {
  console.error(
    `[heal-repro] no duplicate or mis-owned editor records in ${dataFile}; nothing to reproduce.`
  )
  process.exit(2)
}
printScanTable(affectedByWorktree)

const worktreeId =
  requestedWorktree ??
  [...affectedByWorktree.entries()].sort((a, b) => b[1].length - a[1].length)[0][0]
const trackedPaths =
  requestedPaths.length > 0
    ? requestedPaths
    : (affectedByWorktree.get(worktreeId) ?? []).map((entry) => entry.filePath)
if (trackedPaths.length === 0) {
  console.error(`[heal-repro] no affected paths for ${worktreeId}; pass --path to force one.`)
  process.exit(2)
}
console.error(`[heal-repro] worktree: ${worktreeId}`)
console.error(`[heal-repro] tracking ${trackedPaths.length} path(s)`)

const runRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-editor-heal-'))
const evidenceDir = path.join(runRoot, 'evidence')
mkdirSync(evidenceDir, { recursive: true })
const writeEvidence = (name, value) =>
  writeFileSync(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`)

const readArg = { worktreeId, paths: trackedPaths }
const report = {
  dataFile,
  worktreeId,
  trackedPaths,
  runRoot,
  evidenceDir,
  strippedLaunchAgents: stripLaunchAgents(source),
  sanitized: {
    draftsStripped: stripPersistedEditorDrafts(source),
    autosaveDisabled: disableEditorAutoSave(source)
  },
  scan: Object.fromEntries(affectedByWorktree),
  baseline: persistedShape(source, worktreeId, trackedPaths)
}
writeEvidence('0-baseline.json', report.baseline)

const pass1 = makeUserDataDir(runRoot, 'user-data', source)
let firstApp = null
let secondApp = null
let exitCode = 0
try {
  report.healLines = []
  const first = await launchHidden(pass1.userDataDir, report.healLines)
  firstApp = first.app
  report.afterHydration = await first.page.evaluate(readStore, readArg)
  writeEvidence('1-after-hydration.json', report.afterHydration)

  const cdp = await first.page.context().newCDPSession(first.page)
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  report.screenshot = path.join(evidenceDir, 'after-hydration.png')
  writeFileSync(report.screenshot, Buffer.from(screenshot.data, 'base64'))

  report.mruWalk = await first.page.evaluate(walkMostRecentlyUsed, readArg)
  await first.page.waitForTimeout(500)
  report.beforeClose = await first.page.evaluate(readStore, readArg)
  writeEvidence('2-before-close.json', report.beforeClose)

  report.closedFileIds = await first.page.evaluate(closeTrackedFiles, readArg)
  await first.page.waitForTimeout(1_000)
  report.afterClose = await first.page.evaluate(readStore, readArg)
  writeEvidence('3-after-close.json', report.afterClose)

  // Real window keydown, and the active tab is read around every press so a no-op press cannot
  // be mistaken for "the ghost did not return".
  report.previousRecentPresses = []
  for (let press = 0; press < pressCount; press++) {
    const before = await first.page.evaluate(readActiveTab, worktreeId)
    await first.page.keyboard.press('Control+Tab')
    await first.page.waitForTimeout(600)
    const after = await first.page.evaluate(readActiveTab, worktreeId)
    report.previousRecentPresses.push({
      press: press + 1,
      before,
      after,
      switched: before.groupActiveTabId !== after.groupActiveTabId
    })
  }
  await first.page.waitForTimeout(1_500)
  report.afterPreviousRecent = await first.page.evaluate(readStore, readArg)
  writeEvidence('4-after-previous-recent.json', report.afterPreviousRecent)

  await first.page.evaluate(() => window.api.session.flush())
  await first.page.waitForTimeout(1_500)
  const flushed = JSON.parse(readFileSync(pass1.dataFile, 'utf8'))
  report.persistedAfterFlush = persistedShape(flushed, worktreeId, trackedPaths)
  writeEvidence('5-persisted-after-flush.json', report.persistedAfterFlush)

  // Restart from exactly the flushed post-close state: a ghost that survives restart lands here.
  const pass2 = makeUserDataDir(runRoot, 'user-data-restart', flushed)
  report.restartUserDataDir = pass2.userDataDir
  await shutdown(firstApp, pass1.userDataDir)
  firstApp = null
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  report.restartHealLines = []
  const second = await launchHidden(pass2.userDataDir, report.restartHealLines)
  secondApp = second.app
  report.afterRestart = await second.page.evaluate(readStore, readArg)
  writeEvidence('6-after-restart.json', report.afterRestart)
  await second.page.evaluate(() => window.api.session.flush())
  await second.page.waitForTimeout(1_000)
  report.persistedAfterRestart = persistedShape(
    JSON.parse(readFileSync(pass2.dataFile, 'utf8')),
    worktreeId,
    trackedPaths
  )
  writeEvidence('7-persisted-after-restart.json', report.persistedAfterRestart)

  // Why every snapshot after the close: a ghost that skips one of them still comes back from the
  // next, and the restart pass is where a record the flush kept finally resurfaces.
  const survivesIn = (snapshot, trackedPath) =>
    Boolean(snapshot) &&
    ((snapshot.openFileCountByPath?.[trackedPath] ?? 0) > 0 ||
      (snapshot.editorTabsForPaths ?? []).some(
        (tab) => editorEntityPath(tab.entityId) === trackedPath
      ) ||
      [...(snapshot.tabGroups ?? []), ...(snapshot.groups ?? [])].some((group) =>
        (group.pathReferences ?? []).some((reference) => reference.path === trackedPath)
      ))
  const survivors = trackedPaths.filter((trackedPath) =>
    [
      report.afterPreviousRecent,
      report.persistedAfterFlush,
      report.afterRestart,
      report.persistedAfterRestart
    ].some((snapshot) => survivesIn(snapshot, trackedPath))
  )
  report.survivingPaths = survivors
  exitCode = survivors.length > 0 ? 1 : 0
} catch (error) {
  report.error = String(error)
  console.error(error)
  exitCode = 1
} finally {
  writeEvidence('report.json', report)
  if (firstApp) {
    await shutdown(firstApp, pass1.userDataDir)
  }
  // Why the guard: a throw before the restart dir is recorded must not make this quit path throw
  // too, or the real error never reaches the summary.
  if (secondApp && report.restartUserDataDir) {
    await shutdown(secondApp, report.restartUserDataDir)
  }
  const healed = report.baseline.openFileCountByPath
  const afterFlush = report.persistedAfterFlush?.openFileCountByPath ?? {}
  console.error('[heal-repro] summary')
  console.error(`  data              ${dataFile}`)
  console.error(`  worktree          ${worktreeId}`)
  console.error(`  launchAgents      stripped ${report.strippedLaunchAgents}`)
  console.error(`  heal line         ${report.healLines?.[0] ?? '(none)'}`)
  console.error(`  restart heal line ${report.restartHealLines?.[0] ?? '(none)'}`)
  for (const trackedPath of trackedPaths) {
    console.error(
      `  records           ${healed[trackedPath] ?? 0} persisted -> ` +
        `${report.afterHydration?.openFileCountByPath?.[trackedPath] ?? '?'} hydrated -> ` +
        `${afterFlush[trackedPath] ?? '?'} flushed   ${trackedPath}`
    )
  }
  const presses = report.previousRecentPresses ?? []
  console.error(
    `  Control+Tab       ${presses.filter((press) => press.switched).length}/${presses.length} switched`
  )
  console.error(`  surviving paths   ${report.survivingPaths?.length ?? 'n/a'}`)
  console.error(`  evidence          ${evidenceDir}`)
  if (keepRunRoot || exitCode !== 0) {
    console.error(`  run dir kept      ${runRoot}`)
  } else {
    rmSync(path.join(runRoot, 'user-data'), { recursive: true, force: true })
    rmSync(path.join(runRoot, 'user-data-restart'), { recursive: true, force: true })
  }
  process.exit(exitCode)
}
