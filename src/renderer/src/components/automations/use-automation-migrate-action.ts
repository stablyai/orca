import { useEffect, useEffectEvent, useState } from 'react'
import { toast } from 'sonner'
import { resolveAutomationCreateDestination } from './automation-create-destination'
import { createAutomationSaveAction } from './automation-save-action'
import type { AutomationSaveContext } from './automation-save-context'
import type { AutomationListRow } from './automation-list-row-identity'
import type { AutomationEditorActions } from './use-automation-editor-actions'

/** Migrate: the editor's own move-to-server save, run without opening the dialog. */
export function useAutomationMigrateAction(
  context: AutomationSaveContext,
  editorActions: AutomationEditorActions
) {
  const [migration, setMigration] = useState<{ rowKey: string; opened: boolean } | null>(null)

  // Runs on the render that holds the headless edit session, so Save reads it like the dialog would.
  const saveMigration = useEffectEvent(async () => {
    const save = createAutomationSaveAction({
      ...context,
      local: {
        ...context.local,
        // No dialog is open to show editor notices.
        setEditorNotice: (notice) => {
          if (notice && typeof notice !== 'function') {
            toast.error(notice.message)
          }
        },
        setEditorNoticeHost: () => {}
      }
    })
    try {
      await save()
    } finally {
      setMigration(null)
    }
  })
  useEffect(() => {
    if (migration?.opened) {
      void saveMigration()
    }
  }, [migration])

  const migrateAutomation = async (row: AutomationListRow): Promise<void> => {
    setMigration({ rowKey: row.key, opened: false })
    let opened = false
    try {
      const servedBy = context.destination.rowRecoveryHost(row.key)?.servedBy
      const server = resolveAutomationCreateDestination(
        context.list.hostCatalog.entries.find((entry) => entry.stableKey === servedBy)
      )
      // Save checks the project against the server's repo table, which may not be loaded yet.
      if (server.status === 'ready' && server.authority.kind === 'runtime') {
        await context.store.fetchRuntimeEnvironmentRepos(server.authority.environmentId)
      }
      opened = await editorActions.openEditDialog(row, { headless: true })
    } finally {
      setMigration(opened ? { rowKey: row.key, opened: true } : null)
    }
  }

  return { migrateAutomation, migratingRowKey: migration?.rowKey ?? null }
}
