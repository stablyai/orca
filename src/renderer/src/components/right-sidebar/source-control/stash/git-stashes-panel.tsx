import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ChevronDown, Loader2, MoreHorizontal, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { getConnectionId } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { retainCurrentStashFiles, stashFilesCacheKey } from './stash-panel-cache'
import type { GitStashFile, GitStashSummary } from '../../../../../../shared/git-stash'
import {
  applyRuntimeGitStash,
  createRuntimeGitStash,
  dropRuntimeGitStash,
  getRuntimeGitCommitCompare,
  listRuntimeGitStashes,
  listRuntimeGitStashFiles,
  popRuntimeGitStash,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'

type Confirmation = { action: 'pop' | 'drop'; stash: GitStashSummary } | null

function stashErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback
  }
  if (error.message === 'stash_revision_changed') {
    return translate(
      'components.sourceControl.stashes.revisionChanged',
      'This stash changed. Refresh stashes and try again.'
    )
  }
  if (error.message === 'invalid_stash_revision') {
    return translate('components.sourceControl.stashes.invalidRevision', 'Invalid stash revision')
  }
  if (error.message === 'git_stash_unavailable') {
    return translate(
      'components.sourceControl.stashes.hostUnavailable',
      'Git stashes are unavailable on this host. Reconnect to update Orca, then try again.'
    )
  }
  return error.message
}

export function GitStashesPanel(props: {
  worktreeId: string
  worktreePath: string
  settings: RuntimeGitContext['settings']
  collapsed: boolean
  onToggle: () => void
  onRefreshStatus: () => void
}) {
  const [stashes, setStashes] = useState<GitStashSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, GitStashFile[]>>({})
  const [createOpen, setCreateOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation>(null)
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [keepIndex, setKeepIndex] = useState(false)
  const listRequestRef = useRef<AbortController | null>(null)
  const filesRequestRef = useRef<AbortController | null>(null)
  const openCommitDiff = useAppStore((state) => state.openCommitDiff)
  const context = useMemo<RuntimeGitContext>(() => ({
    settings: props.settings,
    worktreeId: props.worktreeId,
    worktreePath: props.worktreePath,
    connectionId: getConnectionId(props.worktreeId) ?? undefined
  }), [props.settings, props.worktreeId, props.worktreePath])

  const refresh = useCallback(async () => {
    listRequestRef.current?.abort()
    const controller = new AbortController()
    listRequestRef.current = controller
    setLoading(true)
    try {
      const nextStashes = await listRuntimeGitStashes(context, controller.signal)
      if (listRequestRef.current !== controller) {
        return
      }
      setStashes(nextStashes)
      setFiles((current) => retainCurrentStashFiles(current, nextStashes))
      setExpanded((current) =>
        current && nextStashes.some((stash) => stash.commitId === current) ? current : null
      )
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(stashErrorMessage(error, translate('components.sourceControl.stashes.loadFailed', 'Failed to load stashes')))
      }
    } finally {
      if (listRequestRef.current === controller) {
        listRequestRef.current = null
        setLoading(false)
      }
    }
  }, [context])

  useEffect(() => {
    if (!props.collapsed) {
      void refresh()
    }
    return () => {
      listRequestRef.current?.abort()
      filesRequestRef.current?.abort()
    }
  }, [props.collapsed, refresh])

  const toggleStash = async (stash: GitStashSummary) => {
    const cacheKey = stashFilesCacheKey(stash)
    if (expanded === cacheKey) {
      setExpanded(null)
      return
    }
    setExpanded(cacheKey)
    if (!files[cacheKey]) {
      filesRequestRef.current?.abort()
      const controller = new AbortController()
      filesRequestRef.current = controller
      try {
        const loadedFiles = await listRuntimeGitStashFiles(
          context,
          { ref: stash.ref, expectedCommitId: stash.commitId },
          controller.signal
        )
        if (filesRequestRef.current === controller) {
          setFiles((current) => ({ ...current, [cacheKey]: loadedFiles }))
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          toast.error(stashErrorMessage(error, translate('components.sourceControl.stashes.filesLoadFailed', 'Failed to load stash files')))
        }
      } finally {
        if (filesRequestRef.current === controller) {
          filesRequestRef.current = null
        }
      }
    }
  }

  const openFile = async (stash: GitStashSummary, file: GitStashFile) => {
    const compare = await getRuntimeGitCommitCompare(context, file.commitId ?? stash.commitId)
    if (compare.summary.status !== 'ready') {
      toast.error(
        compare.summary.errorMessage ??
          translate('components.sourceControl.stashes.diffOpenFailed', 'Failed to open stash diff')
      )
      return
    }
    const entry = compare.entries.find((candidate) => candidate.path === file.path)
    if (!entry) {
      toast.error(
        translate(
          'components.sourceControl.stashes.filePreviewUnavailable',
          'This stash file cannot be previewed'
        )
      )
      return
    }
    openCommitDiff(props.worktreeId, props.worktreePath, entry, compare.summary, detectLanguage(file.path))
  }

  const afterMutation = async (operation: () => Promise<void>, success: string) => {
    try {
      await operation()
      toast.success(success)
    } catch (error) {
      toast.error(stashErrorMessage(error, translate('components.sourceControl.stashes.operationFailed', 'Stash operation failed')))
    } finally {
      props.onRefreshStatus()
      await refresh()
    }
  }

  return (
    <section className="border-t border-border">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-xs font-semibold uppercase tracking-wider text-foreground/70" onClick={props.onToggle}>
          <ChevronDown className={cn('size-3.5 transition-transform', props.collapsed && '-rotate-90')} />
          {translate('components.sourceControl.stashes.title', 'Stashes')}{' '}
          <span className="text-[11px] font-medium tabular-nums">{stashes.length}</span>
        </button>
        <Button variant="ghost" size="icon-xs" aria-label={translate('components.sourceControl.stashes.create', 'Create stash')} onClick={() => setCreateOpen(true)}><Plus /></Button>
        <Button variant="ghost" size="icon-xs" aria-label={translate('components.sourceControl.stashes.refresh', 'Refresh stashes')} disabled={loading} onClick={() => void refresh()}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}</Button>
      </div>
      {!props.collapsed && (
        <div className="pb-1">
          {!loading && stashes.length === 0 && <p className="px-4 py-3 text-xs text-muted-foreground">{translate('components.sourceControl.stashes.empty', 'No stashes')}</p>}
          {stashes.map((stash) => (
            <div key={stash.ref}>
              <div className="group flex items-center gap-1 px-2 py-1 hover:bg-accent">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs" onClick={() => void toggleStash(stash)}>
                  <Archive className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{stash.summary}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{stash.ref}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={translate('components.sourceControl.stashes.actionsFor', 'Actions for {{ref}}', { ref: stash.ref })}><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void afterMutation(() => applyRuntimeGitStash(context, { ref: stash.ref, expectedCommitId: stash.commitId }), translate('components.sourceControl.stashes.applied', 'Stash applied'))}>{translate('components.sourceControl.stashes.apply', 'Apply')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setConfirmation({ action: 'pop', stash })}>{translate('components.sourceControl.stashes.popMenu', 'Pop...')}</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setConfirmation({ action: 'drop', stash })}>{translate('components.sourceControl.stashes.dropMenu', 'Drop...')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {expanded === stashFilesCacheKey(stash) && (
                <div className="pl-7">
                  {!files[stashFilesCacheKey(stash)] && <div className="px-2 py-1 text-xs text-muted-foreground">{translate('components.sourceControl.stashes.loadingFiles', 'Loading files...')}</div>}
                  {files[stashFilesCacheKey(stash)]?.map((file) => <button key={`${file.oldPath ?? ''}:${file.path}`} type="button" className="block w-full truncate px-2 py-1 text-left font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => void openFile(stash, file)}>{file.path}</button>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{translate('components.sourceControl.stashes.createTitle', 'Create stash')}</DialogTitle><DialogDescription>{translate('components.sourceControl.stashes.createDescription', 'Save the current working tree changes for later.')}</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2"><Label htmlFor="stash-message">{translate('components.sourceControl.stashes.message', 'Message')}</Label><Input id="stash-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder={translate('components.sourceControl.stashes.optionalMessage', 'Optional message')} /></div>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={includeUntracked} onCheckedChange={(value) => setIncludeUntracked(value === true)} />{translate('components.sourceControl.stashes.includeUntracked', 'Include untracked files')}</label>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={keepIndex} onCheckedChange={(value) => setKeepIndex(value === true)} />{translate('components.sourceControl.stashes.keepIndex', 'Keep staged changes')}</label>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>{translate('common.cancel', 'Cancel')}</Button><Button onClick={() => { setCreateOpen(false); void afterMutation(() => createRuntimeGitStash(context, { message, includeUntracked, keepIndex }), translate('components.sourceControl.stashes.created', 'Stash created')) }}>{translate('components.sourceControl.stashes.create', 'Create stash')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmation !== null} onOpenChange={(open) => !open && setConfirmation(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{confirmation?.action === 'drop' ? translate('components.sourceControl.stashes.dropTitle', 'Drop stash?') : translate('components.sourceControl.stashes.popTitle', 'Pop stash?')}</DialogTitle><DialogDescription>{confirmation?.action === 'drop' ? translate('components.sourceControl.stashes.dropDescription', 'This permanently removes the selected stash.') : translate('components.sourceControl.stashes.popDescription', 'A successful pop applies the changes and removes the stash. If conflicts occur, Git keeps it.')}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setConfirmation(null)}>{translate('common.cancel', 'Cancel')}</Button><Button variant={confirmation?.action === 'drop' ? 'destructive' : 'default'} onClick={() => { const value = confirmation; setConfirmation(null); if (value) { const target = { ref: value.stash.ref, expectedCommitId: value.stash.commitId }; void afterMutation(() => value.action === 'drop' ? dropRuntimeGitStash(context, target) : popRuntimeGitStash(context, target), value.action === 'drop' ? translate('components.sourceControl.stashes.dropped', 'Stash dropped') : translate('components.sourceControl.stashes.popped', 'Stash popped')) } }}>{confirmation?.action === 'drop' ? translate('components.sourceControl.stashes.drop', 'Drop') : translate('components.sourceControl.stashes.pop', 'Pop')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
