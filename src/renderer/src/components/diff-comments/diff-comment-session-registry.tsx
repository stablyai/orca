import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react'
import { DiffCommentFileSession } from './diff-comment-session'
import { useLocalDiffCommentSession } from './use-local-diff-comment-session'

type FileRecord = { session: DiffCommentFileSession; bindings: number }

export class DiffCommentSessionRegistry {
  private readonly scopes = new Map<string, Map<string, FileRecord>>()
  private disposed = false
  private scope: string | undefined

  selectScope(scope: string): void {
    if (this.scope === scope) {
      return
    }
    const previous = this.scope
    this.scope = scope
    if (previous !== undefined) {
      const retired = this.scopes.get(previous)
      this.scopes.delete(previous)
      for (const record of retired?.values() ?? []) {
        record.session.dispose()
      }
    }
  }

  file(scope: string, key: string): DiffCommentFileSession {
    let files = this.scopes.get(scope)
    if (!files) {
      files = new Map()
      this.scopes.set(scope, files)
    }
    const existing = files.get(key)
    if (existing) {
      return existing.session
    }
    const record: FileRecord = {
      bindings: 0,
      session: new DiffCommentFileSession(
        () => !this.disposed && this.scopes.get(scope)?.get(key) === record,
        () => this.releaseIdle(scope, key, record)
      )
    }
    files.set(key, record)
    return record.session
  }

  retain(scope: string, key: string, session: DiffCommentFileSession): () => void {
    const record = this.scopes.get(scope)?.get(key)
    if (!record || record.session !== session) {
      return () => {}
    }
    record.bindings++
    return () => {
      record.bindings--
      queueMicrotask(() => this.releaseIdle(scope, key, record))
    }
  }

  private releaseIdle(scope: string, key: string, record: FileRecord): void {
    if (record.bindings || record.session.hasWork || this.scopes.get(scope)?.get(key) !== record) {
      return
    }
    this.scopes.get(scope)!.delete(key)
    record.session.dispose()
    if (!this.scopes.get(scope)!.size) {
      this.scopes.delete(scope)
    }
  }

  pruneEdits(scope: string, ids: ReadonlySet<string>): void {
    for (const record of this.scopes.get(scope)?.values() ?? []) {
      record.session.pruneEdits(ids)
    }
  }

  clear = (): void => {
    const scopes = Array.from(this.scopes.values())
    this.scopes.clear()
    for (const files of scopes) {
      for (const record of files.values()) {
        record.session.dispose()
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.clear()
  }
}

const SessionContext = createContext<{
  registry: DiffCommentSessionRegistry
  scope: string
} | null>(null)

export function DiffCommentSessionScope({
  children,
  scope = 'review',
  knownNoteIds
}: {
  children: ReactNode
  scope?: string
  knownNoteIds?: ReadonlySet<string>
}): React.JSX.Element {
  const registry = useLocalDiffCommentSession(() => new DiffCommentSessionRegistry())
  useLayoutEffect(() => {
    registry.selectScope(scope)
  }, [registry, scope])
  useLayoutEffect(() => {
    if (knownNoteIds) {
      registry.pruneEdits(scope, knownNoteIds)
    }
  }, [knownNoteIds, registry, scope])
  const context = useMemo(() => ({ registry, scope }), [registry, scope])
  return <SessionContext.Provider value={context}>{children}</SessionContext.Provider>
}

export function useDiffCommentSessionRegistry(): DiffCommentSessionRegistry | undefined {
  return useContext(SessionContext)?.registry
}

export function useDiffCommentFileSession(key: string): DiffCommentFileSession | undefined {
  const context = useContext(SessionContext)
  const session = useMemo(() => context?.registry.file(context.scope, key), [context, key])
  useLayoutEffect(() => {
    if (context && session) {
      return context.registry.retain(context.scope, key, session)
    }
    return undefined
  }, [context, key, session])
  return session
}
