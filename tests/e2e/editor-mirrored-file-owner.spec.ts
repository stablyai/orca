import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PreloadApi } from '../../src/preload/api-types'
import type { PublicKnownRuntimeEnvironment } from '../../src/shared/runtime-environments'
import type { RuntimeMobileSessionTabsResult, RuntimeStatus } from '../../src/shared/runtime-types'
import type { RuntimeRpcResponse } from '../../src/shared/runtime-rpc-envelope'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('loads, reconnects and saves a receiver-local mirrored file without losing its draft', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = path.join(context.rootPath, `mirrored-owner-${randomUUID()}.txt`)
  const original = 'RECEIVER_LOCAL_CONTENT'
  const edited = `${original}_CLIENT_DRAFT`
  await writeFile(filePath, original, 'utf8')
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
  const environment: PublicKnownRuntimeEnvironment = {
    id: 'mirrored-owner-fixture',
    name: 'Controlled publisher',
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    lastUsedAt: null,
    runtimeId: 'mirrored-owner-runtime',
    endpoints: [],
    preferredEndpointId: 'fixture'
  }
  const status: RuntimeStatus = {
    runtimeId: 'mirrored-owner-runtime',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 1,
    liveLeafCount: 1
  }

  // The peer publication is controlled; local reads and writes use the real filesystem.
  await electronApp.evaluate(
    ({ ipcMain }, { environment, status, filePath, worktreeId }) => {
      let publicationCount = 0
      const publication = (): RuntimeMobileSessionTabsResult => ({
        worktree: worktreeId,
        publicationEpoch: 'fixture-publication',
        snapshotVersion: ++publicationCount,
        activeGroupId: 'fixture-group',
        activeTabId: 'fixture-editor',
        activeTabType: 'file',
        tabs: [
          {
            type: 'file',
            id: 'fixture-editor',
            title: 'Mirrored local file',
            filePath,
            relativePath: filePath.split(/[\\/]/).pop() ?? filePath,
            language: 'plaintext',
            isDirty: false,
            isActive: true
          }
        ]
      })
      const response = (result: unknown): RuntimeRpcResponse<unknown> => ({
        id: 'fixture-response',
        ok: true,
        result,
        _meta: { runtimeId: status.runtimeId }
      })
      ipcMain.removeHandler('runtimeEnvironments:list')
      ipcMain.handle('runtimeEnvironments:list', () => [environment])
      for (const channel of ['runtimeEnvironments:getStatus', 'runtimeEnvironments:connect']) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => response(status))
      }
      ipcMain.removeHandler('runtimeEnvironments:call')
      ipcMain.handle(
        'runtimeEnvironments:call',
        (_event, args: Parameters<PreloadApi['runtimeEnvironments']['call']>[0]) => {
          if (args.method === 'session.tabs.listAll') {
            return response({ snapshots: [publication()], authoritative: true })
          }
          if (args.method === 'session.tabs.list') {
            return response(publication())
          }
          return {
            id: 'fixture-response',
            ok: false,
            error: { code: 'not_found', message: 'Publisher does not own the receiver-local file' },
            _meta: { runtimeId: status.runtimeId }
          }
        }
      )
      ipcMain.removeHandler('runtimeEnvironments:subscribe')
      ipcMain.handle(
        'runtimeEnvironments:subscribe',
        (_event, args: { subscriptionId: string }) => ({
          subscriptionId: args.subscriptionId,
          requestId: 'fixture-subscription'
        })
      )
      ipcMain.removeHandler('runtimeEnvironments:unsubscribe')
      ipcMain.handle('runtimeEnvironments:unsubscribe', () => undefined)
      ipcMain.on('editor-owner-fixture:receipt', (_event, reply: (count: number) => void) =>
        reply(publicationCount)
      )
    },
    { environment, status, filePath, worktreeId: context.worktreeId }
  )

  await orcaPage.evaluate(
    ({ environment, status, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Editor store unavailable')
      }
      const settings = store.getState().settings
      if (!settings) {
        throw new Error('Fixture settings unavailable')
      }
      const owner = Object.values(store.getState().worktreesByRepo)
        .flat()
        .find((entry) => entry.id === worktreeId)
      if (!owner) {
        throw new Error('Fixture worktree unavailable')
      }
      store.getState().setRuntimeEnvironments([environment])
      store.setState((state) => ({
        settings: {
          ...settings,
          editorAutoSave: false,
          activeRuntimeEnvironmentId: environment.id
        },
        repos: state.repos.map((repo) =>
          repo.id === owner.repoId ? { ...repo, executionHostId: 'local' as const } : repo
        ),
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [owner.repoId]: state.worktreesByRepo[owner.repoId].map((entry) =>
            entry.id === worktreeId
              ? { ...entry, hostId: 'local', runtimeOwnerEnvironmentId: undefined }
              : entry
          )
        },
        activeWorkspaceExecutionHostId: 'local',
        runtimeStatusByEnvironmentId: new Map([
          [environment.id, { status, checkedAt: Date.now(), connectionGeneration: 0 }]
        ])
      }))
    },
    { environment, status, worktreeId: context.worktreeId }
  )

  const mirroredFile = () =>
    orcaPage.evaluate(
      (filePath) => window.__store?.getState().openFiles.find((file) => file.filePath === filePath),
      filePath
    )
  await expect.poll(mirroredFile).toBeTruthy()
  const file = await mirroredFile()
  if (!file) {
    throw new Error('Mirrored file unavailable')
  }
  await orcaPage.evaluate((id) => window.__store?.getState().setActiveFile(id), file.id)
  const value = () => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail)
  try {
    await expect.poll(value, { timeout: 25_000 }).toBe(original)
  } finally {
    await orcaPage.screenshot({
      path: testInfo.outputPath('mirrored-load.png'),
      animations: 'disabled'
    })
  }
  expect((await mirroredFile())?.runtimeEnvironmentId ?? null).toBeNull()
  const editor = orcaPage.locator('.monaco-editor').first()
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.type('_CLIENT_DRAFT')
  await expect.poll(value).toBe(edited)
  await expect
    .poll(() => orcaPage.evaluate((id) => window.__store?.getState().editorDrafts[id], file.id))
    .toBe(edited)
  const count = await electronApp.evaluate(({ ipcMain }) => {
    let count = 0
    ipcMain.emit('editor-owner-fixture:receipt', undefined, (value: number) => {
      count = value
    })
    return count
  })
  await orcaPage.evaluate((id) => {
    window.__store?.setState((state) => {
      const current = state.runtimeStatusByEnvironmentId.get(id)
      if (!current) {
        throw new Error('Fixture status unavailable')
      }
      return {
        runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set(id, {
          ...current,
          hostContactEpoch: 1
        })
      }
    })
  }, environment.id)
  await expect
    .poll(() =>
      electronApp.evaluate(({ ipcMain }) => {
        let count = 0
        ipcMain.emit('editor-owner-fixture:receipt', undefined, (value: number) => {
          count = value
        })
        return count
      })
    )
    .toBeGreaterThan(count)
  expect(
    await orcaPage.evaluate(
      (filePath) =>
        window.__store
          ?.getState()
          .openFiles.filter((file) => file.filePath === filePath)
          .map((file) => ({ id: file.id, dirty: file.isDirty })),
      filePath
    )
  ).toEqual([{ id: file.id, dirty: true }])
  await expect.poll(value).toBe(edited)
  await orcaPage.screenshot({
    path: testInfo.outputPath('mirrored-reconnected-draft.png'),
    animations: 'disabled'
  })
  await orcaPage.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => readFile(filePath, 'utf8')).toBe(edited)
  await expect.poll(() => mirroredFile().then((file) => file?.isDirty)).toBe(false)
  await orcaPage.screenshot({
    path: testInfo.outputPath('mirrored-saved-local.png'),
    animations: 'disabled'
  })
})
