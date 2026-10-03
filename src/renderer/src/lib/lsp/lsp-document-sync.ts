import type { LspPortClient } from './lsp-port-client'
import type { OwningWorktree } from './lsp-owning-worktree'

export const LSP_LANGUAGE_IDS = ['typescript', 'javascript', 'ruby'] as const

type Disposable = { dispose(): void }
export type SyncModel = {
  uri: { scheme: string; fsPath: string; toString(): string }
  getLanguageId(): string
  getValue(): string
  getVersionId(): number
  onDidChangeContent(listener: () => void): Disposable
  onWillDispose(listener: () => void): Disposable
}
type SyncClient = Pick<LspPortClient, 'isClosed' | 'notify' | 'request'>

export type LspDocumentSyncDeps = {
  findOwner: (fsPath: string) => OwningWorktree | null
  getClient: (worktreeId: string, languageId: string) => Promise<SyncClient | null>
  retainClient: (worktreeId: string, languageId: string) => void
  releaseClient: (worktreeId: string, languageId: string) => void
}

type TrackedDocument = {
  model: SyncModel
  owner: OwningWorktree
  openedOn: SyncClient | null
  dirty: boolean
}

export function lspLanguageIdForPath(fsPath: string, monacoLanguageId: string): string {
  // Why: Monaco has no tsx/jsx ids, but tsserver picks the script kind from these.
  if (/\.tsx$/i.test(fsPath)) {
    return 'typescriptreact'
  }
  if (/\.jsx$/i.test(fsPath)) {
    return 'javascriptreact'
  }
  return monacoLanguageId
}

function isLspLanguage(languageId: string): boolean {
  return LSP_LANGUAGE_IDS.some((id) => id === languageId)
}

export class LspDocumentSync {
  private readonly documents = new Map<string, TrackedDocument>()
  private readonly openedListeners = new Set<(model: SyncModel) => void>()

  constructor(private readonly deps: LspDocumentSyncDeps) {}

  // Why: lets per-document features (semantic tokens) re-query once a starting server finally has the file.
  onDocumentOpened(listener: (model: SyncModel) => void): Disposable {
    this.openedListeners.add(listener)
    return {
      dispose: () => {
        this.openedListeners.delete(listener)
      }
    }
  }

  isTracked(model: SyncModel): boolean {
    return this.documents.has(model.uri.toString())
  }

  track(model: SyncModel): void {
    // Why: diff models use diff:/diff-section: URIs whose text is not a real program.
    if (model.uri.scheme !== 'file' || !isLspLanguage(model.getLanguageId())) {
      return
    }
    const owner = this.deps.findOwner(model.uri.fsPath)
    const key = model.uri.toString()
    if (!owner || this.documents.has(key)) {
      return
    }
    const doc: TrackedDocument = { model, owner, openedOn: null, dirty: false }
    this.documents.set(key, doc)
    const languageId = model.getLanguageId()
    this.deps.retainClient(owner.worktreeId, languageId)
    model.onDidChangeContent(() => {
      doc.dirty = true
    })
    model.onWillDispose(() => {
      this.documents.delete(key)
      if (doc.openedOn && !doc.openedOn.isClosed) {
        doc.openedOn.notify('textDocument/didClose', { textDocument: { uri: key } })
      }
      this.deps.releaseClient(owner.worktreeId, languageId)
    })
    this.clientFor(model).catch(() => undefined)
  }

  async clientFor(model: SyncModel): Promise<SyncClient | null> {
    const uri = model.uri.toString()
    const doc = this.documents.get(uri)
    if (!doc) {
      return null
    }
    const client = await this.deps.getClient(doc.owner.worktreeId, model.getLanguageId())
    // Why: a same-URI model may have replaced this doc while getClient was pending.
    if (!client || this.documents.get(uri) !== doc) {
      return null
    }
    // Why: no await between this check and the openedOn write, so racing callers send one didOpen.
    if (doc.openedOn !== client) {
      client.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: lspLanguageIdForPath(model.uri.fsPath, model.getLanguageId()),
          version: model.getVersionId(),
          text: model.getValue()
        }
      })
      doc.openedOn = client
      doc.dirty = false
      this.openedListeners.forEach((listener) => {
        try {
          listener(model)
        } catch (error) {
          // Why: a feature's refresh hook must never fail the navigation request that opened the file.
          console.error('[lsp] document-opened listener failed', error)
        }
      })
    } else if (doc.dirty) {
      // ponytail: full-text sync on demand; switch to incremental if large files lag.
      client.notify('textDocument/didChange', {
        textDocument: { uri, version: model.getVersionId() },
        contentChanges: [{ text: model.getValue() }]
      })
      doc.dirty = false
    }
    return client
  }
}
