import { useCallback, useEffect, useMemo, useState } from 'react'
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
  const openCommitDiff = useAppStore((state) => state.openCommitDiff)
  const context = useMemo<RuntimeGitContext>(() => ({
    settings: props.settings,
    worktreeId: props.worktreeId,
    worktreePath: props.worktreePath,
    connectionId: getConnectionId(props.worktreeId) ?? undefined
  }), [props.settings, props.worktreeId, props.worktreePath])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setStashes(await listRuntimeGitStashes(context))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load stashes')
    } finally {
      setLoading(false)
    }
  }, [context])

  useEffect(() => {
    if (!props.collapsed) {
      void refresh()
    }
  }, [props.collapsed, refresh])

  const toggleStash = async (stash: GitStashSummary) => {
    if (expanded === stash.ref) {
      setExpanded(null)
      return
    }
    setExpanded(stash.ref)
    if (!files[stash.ref]) {
      try {
        const loadedFiles = await listRuntimeGitStashFiles(context, stash.ref)
        setFiles((current) => ({ ...current, [stash.ref]: loadedFiles }))
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to load stash files')
      }
    }
  }

  const openFile = async (stash: GitStashSummary, file: GitStashFile) => {
    const compare = await getRuntimeGitCommitCompare(context, file.commitId ?? stash.commitId)
    if (compare.summary.status !== 'ready') {
      toast.error(compare.summary.errorMessage ?? 'Failed to open stash diff')
      return
    }
    const entry = compare.entries.find((candidate) => candidate.path === file.path)
    if (!entry) {
      toast.error('This stash file cannot be previewed')
      return
    }
    openCommitDiff(props.worktreeId, props.worktreePath, entry, compare.summary, detectLanguage(file.path))
  }

  const afterMutation = async (operation: () => Promise<void>, success: string) => {
    try {
      await operation()
      toast.success(success)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Stash operation failed')
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
          Stashes <span className="text-[11px] font-medium tabular-nums">{stashes.length}</span>
        </button>
        <Button variant="ghost" size="icon-xs" aria-label="Create stash" onClick={() => setCreateOpen(true)}><Plus /></Button>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh stashes" disabled={loading} onClick={() => void refresh()}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}</Button>
      </div>
      {!props.collapsed && (
        <div className="pb-1">
          {!loading && stashes.length === 0 && <p className="px-4 py-3 text-xs text-muted-foreground">No stashes</p>}
          {stashes.map((stash) => (
            <div key={stash.ref}>
              <div className="group flex items-center gap-1 px-2 py-1 hover:bg-accent">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs" onClick={() => void toggleStash(stash)}>
                  <Archive className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{stash.summary}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{stash.ref}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Actions for ${stash.ref}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void afterMutation(() => applyRuntimeGitStash(context, stash.ref), 'Stash applied')}>Apply</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setConfirmation({ action: 'pop', stash })}>Pop...</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setConfirmation({ action: 'drop', stash })}>Drop...</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {expanded === stash.ref && (
                <div className="pl-7">
                  {!files[stash.ref] && <div className="px-2 py-1 text-xs text-muted-foreground">Loading files...</div>}
                  {files[stash.ref]?.map((file) => <button key={`${file.oldPath ?? ''}:${file.path}`} type="button" className="block w-full truncate px-2 py-1 text-left font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => void openFile(stash, file)}>{file.path}</button>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create stash</DialogTitle><DialogDescription>Save the current working tree changes for later.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2"><Label htmlFor="stash-message">Message</Label><Input id="stash-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Optional message" /></div>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={includeUntracked} onCheckedChange={(value) => setIncludeUntracked(value === true)} />Include untracked files</label>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={keepIndex} onCheckedChange={(value) => setKeepIndex(value === true)} />Keep staged changes</label>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button><Button onClick={() => { setCreateOpen(false); void afterMutation(() => createRuntimeGitStash(context, { message, includeUntracked, keepIndex }), 'Stash created') }}>Create stash</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmation !== null} onOpenChange={(open) => !open && setConfirmation(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{confirmation?.action === 'drop' ? 'Drop stash?' : 'Pop stash?'}</DialogTitle><DialogDescription>{confirmation?.action === 'drop' ? 'This permanently removes the selected stash.' : 'A successful pop applies the changes and removes the stash. If conflicts occur, Git keeps it.'}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setConfirmation(null)}>Cancel</Button><Button variant={confirmation?.action === 'drop' ? 'destructive' : 'default'} onClick={() => { const value = confirmation; setConfirmation(null); if (value) { void afterMutation(() => value.action === 'drop' ? dropRuntimeGitStash(context, value.stash.ref) : popRuntimeGitStash(context, value.stash.ref), value.action === 'drop' ? 'Stash dropped' : 'Stash popped') } }}>{confirmation?.action === 'drop' ? 'Drop' : 'Pop'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
