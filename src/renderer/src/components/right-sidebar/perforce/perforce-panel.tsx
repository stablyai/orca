import { useMemo, useState } from 'react'
import { FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import type { PerforceEntry } from '../../../../../shared/perforce/perforce-types'
import { PerforceChangelistHeader } from './perforce-changelist-section'
import { NewChangelistDialog, UnshelveDialog } from './perforce-dialogs'
import { PerforceFileActions } from './perforce-file-actions'
import { PerforceFileContextMenu } from './perforce-file-context-menu'
import { PerforceFileRow } from './perforce-file-row'
import { PerforcePanelHeader } from './perforce-panel-header'
import { usePerforceSelection } from './use-perforce-selection'
import { usePerforceStatus } from './use-perforce-status'

function SectionHeader({
  title,
  count,
  children
}: {
  title: string
  count: number
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1 px-2 pt-3 pb-1">
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {title}
      </span>
      {children}
      <span className="text-[11px] text-muted-foreground">{count}</span>
    </div>
  )
}

function rowKey(entry: PerforceEntry): string {
  return `${entry.group}:${entry.path}`
}

export function PerforcePanel({
  worktreeId,
  worktreePath,
  connectionId
}: {
  worktreeId: string
  worktreePath: string
  connectionId?: string
}) {
  const target = { worktreePath, connectionId }
  const { status, error, busy, refresh, run } = usePerforceStatus(target)
  const openDiff = useAppStore((s) => s.openDiff)
  const [message, setMessage] = useState('')
  const [newChangelistPaths, setNewChangelistPaths] = useState<string[] | null>(null)
  const [unshelveOpen, setUnshelveOpen] = useState(false)
  const { selected, select, focusForContextMenu } = usePerforceSelection()
  const api = window.api.perforce

  const groups = useMemo(() => {
    const entries = status?.entries ?? []
    const opened = entries.filter((entry) => entry.group === 'opened')
    return {
      defaultList: opened.filter((entry) => entry.changelist === 'default'),
      numbered: (status?.changelists ?? []).map((changelist) => ({
        changelist,
        files: opened.filter((entry) => entry.changelist === changelist.id)
      })),
      modified: entries.filter((entry) => entry.group === 'modified'),
      fresh: entries.filter((entry) => entry.group === 'new')
    }
  }, [status])

  const openEntryDiff = (entry: PerforceEntry): void => {
    openDiff(
      worktreeId,
      joinPath(worktreePath, entry.path),
      entry.path,
      detectLanguage(entry.path),
      false
    )
  }
  const paths = (entries: PerforceEntry[]): string[] => entries.map((entry) => entry.path)

  const submitDefault = async (): Promise<void> => {
    const ok = await run(
      () => api.submit({ ...target, changelist: 'default', message }),
      'Submitted change'
    )
    if (ok) {
      setMessage('')
    }
  }

  const confirmDiscard = (entries: PerforceEntry[]): void => {
    const noun = entries.length === 1 ? entries[0]?.path : `${entries.length} files`
    if (window.confirm(`Discard local changes to ${noun}? This cannot be undone.`)) {
      void run(() => api.discard({ ...target, entries }))
    }
  }

  const orderedKeys = useMemo(
    () =>
      [
        ...groups.defaultList,
        ...groups.numbered.flatMap(({ files }) => files),
        ...groups.modified,
        ...groups.fresh
      ].map((entry) => rowKey(entry)),
    [groups]
  )

  const openedTargets = (clicked: PerforceEntry): PerforceEntry[] => {
    const picked = (status?.entries ?? []).filter(
      (entry) => entry.group === 'opened' && selected.has(rowKey(entry))
    )
    return picked.some((entry) => entry.path === clicked.path) ? picked : [clicked]
  }

  const renderRows = (entries: PerforceEntry[]) =>
    entries.map((entry) => {
      const row = (
        <PerforceFileRow
          key={rowKey(entry)}
          entry={entry}
          selected={selected.has(rowKey(entry))}
          onSelect={(event) => {
            if (select(rowKey(entry), event, orderedKeys) === 'plain') {
              openEntryDiff(entry)
            }
          }}
          onContextMenu={() => focusForContextMenu(rowKey(entry))}
          actions={
            <PerforceFileActions
              entry={entry}
              busy={busy}
              onClose={() => void run(() => api.close({ ...target, filePaths: [entry.path] }))}
              onOpen={() => void run(() => api.open({ ...target, filePaths: [entry.path] }))}
              onDiscard={() => confirmDiscard([entry])}
            />
          }
        />
      )
      if (entry.group !== 'opened') {
        return row
      }
      const targets = openedTargets(entry)
      return (
        <PerforceFileContextMenu
          key={rowKey(entry)}
          targets={targets}
          changelists={status?.changelists ?? []}
          onMoveToChangelist={(changelist) =>
            void run(() =>
              api.moveToChangelist({ ...target, filePaths: paths(targets), changelist })
            )
          }
          onMoveToNewChangelist={() => setNewChangelistPaths(paths(targets))}
        >
          {row}
        </PerforceFileContextMenu>
      )
    })

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {error ?? 'Loading Perforce workspace…'}
      </div>
    )
  }

  const { info } = status
  const nothingPending =
    groups.defaultList.length + groups.modified.length + groups.fresh.length === 0 &&
    groups.numbered.length === 0
  const canSubmit = message.trim().length > 0 && groups.defaultList.length > 0
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PerforcePanelHeader
        info={info}
        busy={busy}
        onRefresh={() => void refresh()}
        onSync={() => void run(() => api.sync(target), 'Workspace synced')}
        onUnshelve={() => setUnshelveOpen(true)}
      />
      {error ? <div className="px-2 py-1 text-xs text-destructive">{error}</div> : null}
      <div className="flex flex-col gap-2 border-b border-border p-2">
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Changelist description"
          rows={3}
          className="min-h-0"
        />
        <Button size="sm" disabled={busy || !canSubmit} onClick={() => void submitDefault()}>
          Submit Change
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2 scrollbar-sleek">
        {nothingPending ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            No pending changes
          </div>
        ) : null}
        {groups.defaultList.length > 0 ? (
          <>
            <SectionHeader title="Default changelist" count={groups.defaultList.length}>
              <Button
                variant="ghost"
                size="icon-xs"
                title="Move to a new changelist (uses the description above)"
                disabled={busy || message.trim().length === 0}
                onClick={() =>
                  void run(
                    () =>
                      api.createChangelist({
                        ...target,
                        description: message,
                        filePaths: paths(groups.defaultList)
                      }),
                    'Created changelist'
                  ).then((ok) => ok && setMessage(''))
                }
              >
                <FolderPlus />
              </Button>
            </SectionHeader>
            {renderRows(groups.defaultList)}
          </>
        ) : null}
        {groups.numbered.map(({ changelist, files }) => (
          <div key={changelist.id}>
            <PerforceChangelistHeader
              changelist={changelist}
              fileCount={files.length}
              actions={{
                busy,
                onEditDescription: (description) =>
                  run(
                    () =>
                      api.editDescription({ ...target, changelist: changelist.id, description }),
                    'Description updated'
                  ),
                onShelve: () =>
                  void run(() => api.shelve({ ...target, changelist: changelist.id }), 'Shelved'),
                onUnshelve: () =>
                  void run(
                    () => api.unshelve({ ...target, changelist: changelist.id }),
                    'Unshelved'
                  ),
                onDeleteShelf: () =>
                  void run(
                    () => api.deleteShelf({ ...target, changelist: changelist.id }),
                    'Shelf deleted'
                  ),
                onSubmit: () =>
                  void run(
                    () => api.submit({ ...target, changelist: changelist.id }),
                    `Submitted changelist ${changelist.id}`
                  ),
                onDelete: () =>
                  void run(() => api.deleteChangelist({ ...target, changelist: changelist.id }))
              }}
            />
            {renderRows(files)}
          </div>
        ))}
        {groups.modified.length > 0 ? (
          <>
            <SectionHeader title="Modified, not opened" count={groups.modified.length}>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() =>
                  void run(() => api.open({ ...target, filePaths: paths(groups.modified) }))
                }
              >
                Open all
              </Button>
            </SectionHeader>
            {renderRows(groups.modified)}
          </>
        ) : null}
        {groups.fresh.length > 0 ? (
          <>
            <SectionHeader title="New files" count={groups.fresh.length}>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() =>
                  void run(() => api.open({ ...target, filePaths: paths(groups.fresh) }))
                }
              >
                Add all
              </Button>
            </SectionHeader>
            {renderRows(groups.fresh)}
          </>
        ) : null}
      </div>
      {newChangelistPaths ? (
        <NewChangelistDialog
          fileCount={newChangelistPaths.length}
          onCancel={() => setNewChangelistPaths(null)}
          onCreate={(description) =>
            run(
              () => api.createChangelist({ ...target, description, filePaths: newChangelistPaths }),
              'Created changelist'
            )
          }
        />
      ) : null}
      {unshelveOpen ? (
        <UnshelveDialog
          changelists={status.changelists}
          onCancel={() => setUnshelveOpen(false)}
          onUnshelve={(source, changelist) =>
            run(
              () => api.unshelveFrom({ ...target, sourceChangelist: source, changelist }),
              `Unshelved changelist ${source}`
            )
          }
        />
      ) : null}
    </div>
  )
}
