import { useMemo, useState } from 'react'
import { ArrowDownToLine, FolderPlus, Plus, RefreshCw, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import type { PerforceEntry } from '../../../../../shared/perforce-types'
import { PerforceFileRow } from './perforce-file-row'
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

export function PerforcePanel({
  worktreeId,
  worktreePath
}: {
  worktreeId: string
  worktreePath: string
}) {
  const { status, error, busy, refresh, run } = usePerforceStatus(worktreePath)
  const openDiff = useAppStore((s) => s.openDiff)
  const [message, setMessage] = useState('')
  const api = window.api.perforce

  const groups = useMemo(() => {
    const entries = status?.entries ?? []
    const opened = entries.filter((entry) => entry.group === 'opened')
    return {
      defaultList: opened.filter((entry) => entry.changelist === 'default'),
      numbered: (status?.changelists ?? [])
        .map((changelist) => ({
          changelist,
          files: opened.filter((entry) => entry.changelist === changelist.id)
        }))
        .filter((item) => item.files.length > 0),
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
      () => api.submit({ worktreePath, changelist: 'default', message }),
      'Submitted changelist'
    )
    if (ok) {
      setMessage('')
    }
  }

  const confirmDiscard = (entries: PerforceEntry[]): void => {
    const noun = entries.length === 1 ? entries[0]?.path : `${entries.length} files`
    if (window.confirm(`Discard local changes to ${noun}? This cannot be undone.`)) {
      void run(() => api.discard({ worktreePath, entries }))
    }
  }

  const fileActions = (entry: PerforceEntry) => (
    <>
      {entry.group === 'opened' ? (
        <Button
          variant="ghost"
          size="icon-xs"
          title="Close file (keep local changes)"
          disabled={busy}
          onClick={() => void run(() => api.close({ worktreePath, filePaths: [entry.path] }))}
        >
          <X />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          title={entry.group === 'new' ? 'Mark for add' : 'Open for edit'}
          disabled={busy}
          onClick={() => void run(() => api.open({ worktreePath, filePaths: [entry.path] }))}
        >
          <Plus />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        title="Discard changes"
        disabled={busy}
        onClick={() => confirmDiscard([entry])}
      >
        <Undo2 />
      </Button>
    </>
  )

  const renderRows = (entries: PerforceEntry[]) =>
    entries.map((entry) => (
      <PerforceFileRow
        key={`${entry.group}:${entry.path}`}
        entry={entry}
        onOpen={() => openEntryDiff(entry)}
        actions={fileActions(entry)}
      />
    ))

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {error ?? 'Loading Perforce workspace…'}
      </div>
    )
  }

  const { info } = status
  const nothingPending =
    groups.defaultList.length +
      groups.numbered.length +
      groups.modified.length +
      groups.fresh.length ===
    0
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium" title={info.root}>
            {info.client}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[info.stream, info.haveChange ? `synced to @${info.haveChange}` : null]
              .filter(Boolean)
              .join(' · ') || info.port}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Refresh"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Get latest revisions (p4 sync)"
          disabled={busy}
          onClick={() => void run(() => api.sync({ worktreePath }), 'Workspace synced')}
        >
          <ArrowDownToLine />
        </Button>
      </div>
      {error ? <div className="px-2 py-1 text-xs text-destructive">{error}</div> : null}
      <div className="flex flex-col gap-2 border-b border-border p-2">
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Changelist description"
          rows={3}
          className="min-h-0"
        />
        <Button
          size="sm"
          disabled={busy || message.trim().length === 0 || groups.defaultList.length === 0}
          onClick={() => void submitDefault()}
        >
          Submit {groups.defaultList.length} file{groups.defaultList.length === 1 ? '' : 's'}
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
                title="Move to a new changelist"
                disabled={busy || message.trim().length === 0}
                onClick={() =>
                  void run(
                    () =>
                      api.createChangelist({
                        worktreePath,
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
            <SectionHeader
              title={`Changelist ${changelist.id}${changelist.description ? ` · ${changelist.description.split('\n')[0]}` : ''}`}
              count={files.length}
            >
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() =>
                  void run(() => api.shelve({ worktreePath, changelist: changelist.id }), 'Shelved')
                }
              >
                Shelve
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api.submit({ worktreePath, changelist: changelist.id }),
                    `Submitted changelist ${changelist.id}`
                  )
                }
              >
                Submit
              </Button>
            </SectionHeader>
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
                  void run(() => api.open({ worktreePath, filePaths: paths(groups.modified) }))
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
                  void run(() => api.open({ worktreePath, filePaths: paths(groups.fresh) }))
                }
              >
                Add all
              </Button>
            </SectionHeader>
            {renderRows(groups.fresh)}
          </>
        ) : null}
      </div>
    </div>
  )
}
