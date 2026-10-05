import { describe, expect, it, vi } from 'vitest'
import {
  LspDocumentSync,
  lspLanguageIdForPath,
  type LspDocumentSyncDeps,
  type SyncModel
} from './lsp-document-sync'

type SyncClient = NonNullable<Awaited<ReturnType<LspDocumentSyncDeps['getClient']>>>

function model(
  uri: string,
  languageId = 'typescript',
  scheme = 'file'
): SyncModel & { change: (text: string) => void; dispose: () => void } {
  let value = 'const a = 1'
  let version = 1
  const changeListeners: (() => void)[] = []
  const disposeListeners: (() => void)[] = []
  return {
    uri: { scheme, fsPath: uri.replace('file://', ''), toString: () => uri },
    getLanguageId: () => languageId,
    getValue: () => value,
    getVersionId: () => version,
    onDidChangeContent: (listener) => {
      changeListeners.push(listener)
      return { dispose: () => {} }
    },
    onWillDispose: (listener) => {
      disposeListeners.push(listener)
      return { dispose: () => {} }
    },
    change: (text) => {
      value = text
      version++
      changeListeners.forEach((l) => l())
    },
    dispose: () => disposeListeners.forEach((l) => l())
  }
}

function leases() {
  return { retainClient: vi.fn(), releaseClient: vi.fn() }
}

function fakeClient() {
  return { isClosed: false, notify: vi.fn(), request: vi.fn(), close: vi.fn() }
}

describe('LspDocumentSync', () => {
  const owner = { worktreeId: 'r::/repo', worktreePath: '/repo', repoId: 'r' }

  it('ignores diff models and files outside a worktree', () => {
    const sync = new LspDocumentSync({ ...leases(), findOwner: () => owner, getClient: vi.fn() })
    sync.track(model('diff:original:x', 'typescript', 'diff'))
    sync.track(model('file:///repo/a.py', 'python'))
    expect(sync.isTracked(model('diff:original:x', 'typescript', 'diff'))).toBe(false)
    const outside = new LspDocumentSync({ ...leases(), findOwner: () => null, getClient: vi.fn() })
    const m = model('file:///elsewhere/a.ts')
    outside.track(m)
    expect(outside.isTracked(m)).toBe(false)
  })

  it('opens, flushes changes before a request, and closes on dispose', async () => {
    const client = fakeClient()
    const sync = new LspDocumentSync({
      ...leases(),
      findOwner: () => owner,
      getClient: async () => client
    })
    const m = model('file:///repo/a.tsx')
    sync.track(m)
    await sync.clientFor(m)
    expect(client.notify).toHaveBeenCalledWith('textDocument/didOpen', {
      textDocument: {
        uri: 'file:///repo/a.tsx',
        languageId: 'typescriptreact',
        version: 1,
        text: 'const a = 1'
      }
    })
    m.change('const a = 2')
    await sync.clientFor(m)
    expect(client.notify).toHaveBeenCalledWith('textDocument/didChange', {
      textDocument: { uri: 'file:///repo/a.tsx', version: 2 },
      contentChanges: [{ text: 'const a = 2' }]
    })
    m.dispose()
    expect(client.notify).toHaveBeenLastCalledWith('textDocument/didClose', {
      textDocument: { uri: 'file:///repo/a.tsx' }
    })
  })

  it('replays didOpen when the session reconnects', async () => {
    const first = fakeClient()
    const second = fakeClient()
    const getClient = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second)
    const sync = new LspDocumentSync({ ...leases(), findOwner: () => owner, getClient })
    const m = model('file:///repo/a.ts')
    sync.track(m)
    await sync.clientFor(m)
    first.isClosed = true
    await sync.clientFor(m)
    expect(second.notify).toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
  })

  it('sends exactly one didOpen when clientFor calls race on first open', async () => {
    const client = fakeClient()
    const sync = new LspDocumentSync({
      ...leases(),
      findOwner: () => owner,
      getClient: async () => client
    })
    const m = model('file:///repo/a.ts')
    sync.track(m)
    await Promise.all([sync.clientFor(m), sync.clientFor(m), sync.clientFor(m)])
    const opens = client.notify.mock.calls.filter(([method]) => method === 'textDocument/didOpen')
    expect(opens).toHaveLength(1)
    expect(
      client.notify.mock.calls.filter(([method]) => method === 'textDocument/didChange')
    ).toHaveLength(0)
  })

  it('drops a stale call when a same-URI model replaces the doc while getClient is pending', async () => {
    const client = fakeClient()
    let resolve: (c: SyncClient) => void = () => {}
    const pending = new Promise<SyncClient>((r) => {
      resolve = r
    })
    const sync = new LspDocumentSync({
      ...leases(),
      findOwner: () => owner,
      getClient: () => pending
    })
    const m1 = model('file:///repo/a.ts')
    sync.track(m1)
    const stale = sync.clientFor(m1)
    m1.dispose()
    const m2 = model('file:///repo/a.ts')
    m2.change('const b = 2')
    sync.track(m2)
    resolve(client)
    expect(await stale).toBeNull()
    await sync.clientFor(m2)
    const opens = client.notify.mock.calls.filter(([method]) => method === 'textDocument/didOpen')
    expect(opens).toHaveLength(1)
    expect(opens[0][1].textDocument.text).toBe('const b = 2')
  })

  it('does not send didChange after a reconnect replays didOpen', async () => {
    const first = fakeClient()
    const second = fakeClient()
    let current = first
    const getClient = async () => current
    const sync = new LspDocumentSync({ ...leases(), findOwner: () => owner, getClient })
    const m = model('file:///repo/a.ts')
    sync.track(m)
    await sync.clientFor(m)
    first.isClosed = true
    current = second
    m.change('const a = 3')
    await sync.clientFor(m)
    expect(second.notify).toHaveBeenCalledTimes(1)
    expect(second.notify).toHaveBeenCalledWith('textDocument/didOpen', {
      textDocument: expect.objectContaining({ version: 2, text: 'const a = 3' })
    })
  })

  it('notifies document-opened listeners after each didOpen, not on later flushes', async () => {
    const first = fakeClient()
    const second = fakeClient()
    let current = first
    const sync = new LspDocumentSync({
      ...leases(),
      findOwner: () => owner,
      getClient: async () => current
    })
    const opened = vi.fn()
    const subscription = sync.onDocumentOpened(opened)
    const m = model('file:///repo/a.rb', 'ruby')
    sync.track(m)
    await sync.clientFor(m)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledWith(m)
    expect(opened.mock.invocationCallOrder[0]).toBeGreaterThan(
      first.notify.mock.invocationCallOrder[0]
    )
    m.change('x = 1')
    await sync.clientFor(m)
    expect(opened).toHaveBeenCalledTimes(1)
    first.isClosed = true
    current = second
    await sync.clientFor(m)
    expect(opened).toHaveBeenCalledTimes(2)
    subscription.dispose()
    second.isClosed = true
    current = fakeClient()
    await sync.clientFor(m)
    expect(opened).toHaveBeenCalledTimes(2)
  })

  it('still returns the client when a document-opened listener throws', async () => {
    const client = fakeClient()
    const sync = new LspDocumentSync({
      ...leases(),
      findOwner: () => owner,
      getClient: async () => client
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const later = vi.fn()
    sync.onDocumentOpened(() => {
      throw new Error('listener exploded')
    })
    sync.onDocumentOpened(later)
    const m = model('file:///repo/a.rb', 'ruby')
    sync.track(m)
    await expect(sync.clientFor(m)).resolves.toBe(client)
    expect(later).toHaveBeenCalledWith(m)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('sends no didClose when the client is already closed', async () => {
    const client = fakeClient()
    const sync = new LspDocumentSync({
      ...leases(),
      findOwner: () => owner,
      getClient: async () => client
    })
    const m = model('file:///repo/a.ts')
    sync.track(m)
    await sync.clientFor(m)
    client.isClosed = true
    m.dispose()
    expect(client.notify).not.toHaveBeenCalledWith('textDocument/didClose', expect.anything())
  })
})

describe('LspDocumentSync client leases', () => {
  const owner = { worktreeId: 'r::/repo', worktreePath: '/repo', repoId: 'r' }

  it('retains once per tracked document and releases after didClose', async () => {
    const client = fakeClient()
    const lease = leases()
    const sync = new LspDocumentSync({
      ...lease,
      findOwner: () => owner,
      getClient: async () => client
    })
    const a = model('file:///repo/a.ts')
    const b = model('file:///repo/b.ts')
    sync.track(a)
    sync.track(a)
    sync.track(b)
    await sync.clientFor(a)
    expect(lease.retainClient).toHaveBeenCalledTimes(2)
    expect(lease.retainClient).toHaveBeenCalledWith('r::/repo', 'typescript')
    a.dispose()
    expect(lease.releaseClient).toHaveBeenCalledTimes(1)
    expect(lease.releaseClient).toHaveBeenCalledWith('r::/repo', 'typescript')
    expect(client.notify.mock.invocationCallOrder.at(-1)).toBeLessThan(
      lease.releaseClient.mock.invocationCallOrder[0]
    )
    b.dispose()
    expect(lease.releaseClient).toHaveBeenCalledTimes(2)
  })

  it('does not lease untracked models', () => {
    const lease = leases()
    const sync = new LspDocumentSync({ ...lease, findOwner: () => null, getClient: vi.fn() })
    sync.track(model('file:///elsewhere/a.ts'))
    expect(lease.retainClient).not.toHaveBeenCalled()
  })
})

describe('lspLanguageIdForPath', () => {
  it('maps JSX extensions to the react language ids tsserver expects', () => {
    expect(lspLanguageIdForPath('/a.tsx', 'typescript')).toBe('typescriptreact')
    expect(lspLanguageIdForPath('/a.jsx', 'javascript')).toBe('javascriptreact')
    expect(lspLanguageIdForPath('/a.rb', 'ruby')).toBe('ruby')
  })
})
