import type {
  EditorRecoveryApi,
  EditorRecoveryChange,
  EditorRecoveryMetadata
} from '../../../../shared/editor-recovery'
import { editorRecoveryResourceKey } from '../../../../shared/editor-recovery'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  editorRecoverySessionResources,
  applyEditorRecoverySessionDrafts,
  editorRecoverySessionCheckpointIds,
  editorRecoverySessionFileMetadata
} from '../../../../shared/editor-recovery-session'
import { WebEditorRecoveryDatabase } from './web-editor-recovery-database'
import { sha256 } from '../../../../shared/sha256'

export function createWebEditorRecoveryApi(
  readLegacy: () => { hostId: ExecutionHostId; session: WorkspaceSessionState }[]
): {
  api: EditorRecoveryApi
  restoreSession: (
    session: WorkspaceSessionState,
    hostId?: ExecutionHostId
  ) => Promise<WorkspaceSessionState>
} {
  const database = new WebEditorRecoveryDatabase()
  let migration: Promise<void> | null = null
  const migrate = (): Promise<void> =>
    (migration ??= (async () => {
      const changes: EditorRecoveryChange[] = []
      const sessions = readLegacy()
      const knownIds = new Set(
        (
          await database.status(
            sessions.flatMap(({ session }) => editorRecoverySessionCheckpointIds(session))
          )
        ).map((entry) => entry.id)
      )
      for (const { hostId, session } of sessions) {
        for (const [worktreeId, files] of Object.entries(session.openFilesByWorktree ?? {})) {
          for (const file of files) {
            if (file.readOnly || file.dirtyDraftContent === undefined) {
              continue
            }
            if (file.recoveryId && knownIds.has(file.recoveryId)) {
              continue
            }
            const metadata: EditorRecoveryMetadata = editorRecoverySessionFileMetadata(
              file,
              worktreeId,
              hostId
            )
            const input = new TextEncoder().encode(
              `${editorRecoveryResourceKey(metadata)}\0${JSON.stringify(file.dirtyDraftContent)}`
            )
            const id = `legacy:${Array.from(sha256(input), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
            changes.push({
              kind: 'put',
              id,
              expectedRevision: 0,
              metadata,
              content: file.dirtyDraftContent,
              state: 'active'
            })
          }
        }
      }
      await database.apply(changes, true)
    })().catch((error) => {
      migration = null
      throw error
    }))

  const api: EditorRecoveryApi = {
    list: async () => {
      await migrate()
      return database.list()
    },
    read: async (id) => {
      await migrate()
      return (await database.readMany([id]))[0] ?? null
    },
    apply: async (changes) => {
      await migrate()
      return database.apply(changes)
    },
    export: async ({ id, revision }) => {
      await migrate()
      const draft = (await database.readMany([id]))[0]
      if (!draft || draft.revision !== revision) {
        throw new Error('The recovery draft changed. Refresh and retry.')
      }
      const name = draft.filePath.replaceAll('\\', '/').split('/').at(-1) ?? 'draft.txt'
      const dot = name.lastIndexOf('.')
      const suggestedName =
        dot > 0 ? `${name.slice(0, dot)}.recovered${name.slice(dot)}` : `${name}.recovered.txt`
      const result = await window.api.fs.saveDownloadedFile({
        suggestedName,
        content: draft.content,
        encoding: 'utf8'
      })
      return result.canceled ? null : result.destinationPath
    }
  }
  return {
    api,
    restoreSession: async (session, hostId) => {
      await migrate()
      const resources = editorRecoverySessionResources(session, hostId)
      if (resources.length === 0) {
        return session
      }
      const active = new Map<string, string>()
      for (const entry of await database.list()) {
        const key = editorRecoveryResourceKey(entry)
        if (entry.state === 'active' && !active.has(key)) {
          active.set(key, entry.id)
        }
      }
      const ids = resources.map((resource) => active.get(editorRecoveryResourceKey(resource)) ?? '')
      const statuses = await database.status(editorRecoverySessionCheckpointIds(session))
      const resolvedIds = new Set(
        statuses.filter((entry) => entry.state === 'resolved').map((entry) => entry.id)
      )
      return applyEditorRecoverySessionDrafts(session, await database.readMany(ids), resolvedIds)
    }
  }
}
