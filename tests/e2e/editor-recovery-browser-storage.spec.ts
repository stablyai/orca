import { build } from 'esbuild'
import type { WebEditorRecoveryDatabase } from '../../src/renderer/src/web/preload-api/web-editor-recovery-database'
import type { createWebEditorRecoveryApi } from '../../src/renderer/src/web/preload-api/web-editor-recovery-api'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- DOM Window augmentation requires an interface.
  interface Window {
    recoveryStorageTest: {
      WebEditorRecoveryDatabase: typeof WebEditorRecoveryDatabase
      createWebEditorRecoveryApi: typeof createWebEditorRecoveryApi
    }
  }
}

let browserBundle: string
test.beforeAll(async () => {
  const built = await build({
    stdin: {
      contents: `
    export { WebEditorRecoveryDatabase } from './src/renderer/src/web/preload-api/web-editor-recovery-database'
    export { createWebEditorRecoveryApi } from './src/renderer/src/web/preload-api/web-editor-recovery-api'
  `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'recoveryStorageTest',
    logLevel: 'silent'
  })
  const output = built.outputFiles?.[0]
  if (!output) {
    throw new Error('Browser recovery bundle was not generated')
  }
  browserBundle = output.text
})

test('uses real browser transactions for recovery, rollback, migration and retired checkpoints', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.addScriptTag({ content: browserBundle })
  const result = await orcaPage.evaluate(async () => {
    const { WebEditorRecoveryDatabase, createWebEditorRecoveryApi } = window.recoveryStorageTest
    const database = new WebEditorRecoveryDatabase()
    const metadata = {
      hostId: 'local',
      worktreeId: 'wt',
      filePath: '/repo/note.txt',
      relativePath: 'note.txt',
      language: 'plaintext',
      bufferKind: 'edit' as const
    }
    const content = '\ud800\r\n😀'.repeat(10_000)
    const put = {
      kind: 'put' as const,
      id: 'durable',
      expectedRevision: 0,
      metadata,
      content,
      state: 'active' as const
    }
    const concurrent = await Promise.all([
      database.apply([put]),
      database.apply([{ ...put, content: 'stale text' }])
    ])
    const reopened = new WebEditorRecoveryDatabase()
    const recovered = (await reopened.readMany(['durable']))[0]
    const patch = {
      kind: 'patch' as const,
      id: 'durable',
      expectedRevision: 1,
      metadata,
      baseLength: content.length,
      start: content.length,
      removed: 0,
      inserted: '\ud800',
      byteLengthDelta: 3,
      state: 'active' as const
    }
    const patchAck = await reopened.apply([patch])
    const stalePatch = await reopened.apply([patch])
    await reopened.apply([
      {
        ...patch,
        expectedRevision: 2,
        baseLength: content.length + 1,
        removed: 1,
        inserted: '\ud800\udc00',
        byteLengthDelta: 1
      }
    ])
    const patched = (await reopened.readMany(['durable']))[0]
    const expectedPatched = `${content}\ud800\udc00`
    const nativePut = IDBObjectStore.prototype.put
    let contentsWritten = 0
    let failed = false
    try {
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore['put']>
      ) {
        if (this.name === 'contents' && ++contentsWritten === 2) {
          throw new DOMException('Storage quota exhausted', 'QuotaExceededError')
        }
        return nativePut.apply(this, args)
      }
      await reopened.apply([
        {
          ...patch,
          expectedRevision: 3,
          baseLength: expectedPatched.length,
          start: expectedPatched.length,
          inserted: 'rolled back',
          byteLengthDelta: 11
        },
        { ...put, id: 'abort-second' }
      ])
    } catch (error) {
      failed = error instanceof DOMException && error.name === 'QuotaExceededError'
    } finally {
      IDBObjectStore.prototype.put = nativePut
    }
    const rolledBack = await reopened.readMany(['abort-first', 'abort-second'])
    const rolledBackPatch = (await reopened.readMany(['durable']))[0]
    const legacy = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        wt: [
          {
            ...metadata,
            filePath: '/repo/imported.txt',
            relativePath: 'imported.txt',
            dirtyDraftContent: '\ud800'
          },
          {
            ...metadata,
            filePath: '/repo/imported.txt',
            relativePath: 'imported.txt',
            dirtyDraftContent: '\ud801'
          }
        ]
      }
    }
    const unchanged = JSON.stringify(legacy)
    const first = createWebEditorRecoveryApi(() => [{ hostId: 'local', session: legacy }])
    const imported = (await first.api.list()).filter((entry) => entry.id.startsWith('legacy:'))
    const snapshot = await first.restoreSession(legacy)
    await first.api.apply(
      imported.map((entry) => ({ kind: 'resolve', id: entry.id, expectedRevision: entry.revision }))
    )
    const second = createWebEditorRecoveryApi(() => [{ hostId: 'local', session: legacy }])
    const afterMigration = await second.api.list()
    const afterRetirement = await second.restoreSession(snapshot)
    return {
      revisions: concurrent
        .flat()
        .map((ack) => ack.revision)
        .sort(),
      exact: recovered?.content === content,
      revision: recovered?.revision,
      patchAck,
      stalePatch,
      patchExact: patched?.content === expectedPatched,
      patchBytes: patched?.byteLength === new Blob([expectedPatched]).size,
      rolledBackPatchExact:
        rolledBackPatch?.content === expectedPatched && rolledBackPatch.revision === 3,
      failed,
      rolledBack,
      importedCount: imported.length,
      sourceIntact: JSON.stringify(legacy) === unchanged,
      retiredImports: afterMigration.filter((entry) => entry.id.startsWith('legacy:')).length,
      retiredSnapshotText: afterRetirement.openFilesByWorktree?.wt?.[0]?.dirtyDraftContent ?? null
    }
  })
  expect(result).toEqual({
    revisions: [1, null],
    exact: true,
    revision: 1,
    patchAck: [{ id: 'durable', revision: 2 }],
    stalePatch: [{ id: 'durable', revision: null }],
    patchExact: true,
    patchBytes: true,
    rolledBackPatchExact: true,
    failed: true,
    rolledBack: [null, null],
    importedCount: 2,
    sourceIntact: true,
    retiredImports: 0,
    retiredSnapshotText: null
  })
})

test('leaves a newer browser journal intact when an older client opens it', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.addScriptTag({ content: browserBundle })
  const result = await orcaPage.evaluate(async () => {
    const open = (): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('orca-editor-recovery', 2)
        request.onupgradeneeded = () => request.result.createObjectStore('future')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const future = await open()
    const transaction = future.transaction('future', 'readwrite', { durability: 'strict' })
    transaction.objectStore('future').put('newer unsaved text', 'draft')
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
    })
    future.close()
    let refused = false
    try {
      await new window.recoveryStorageTest.WebEditorRecoveryDatabase().list()
    } catch (error) {
      refused = error instanceof DOMException && error.name === 'VersionError'
    }
    const verified = await open()
    const content = await new Promise<unknown>((resolve, reject) => {
      const request = verified.transaction('future', 'readonly').objectStore('future').get('draft')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    verified.close()
    return { refused, content }
  })
  expect(result).toEqual({ refused: true, content: 'newer unsaved text' })
})
