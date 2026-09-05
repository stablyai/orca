import { useEffect, useRef, useState } from 'react'
import { CreationDraftEditor } from './CreationDraftEditor'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  useCreationDraftSession,
  loadCreationDrafts
} from '@/lib/workspace-creation-drafts/creation-draft-session'
import type { CreationDraftInput } from '@/lib/workspace-creation-drafts/creation-draft-record'

export function CreationDraftSurface(): React.JSX.Element | null {
  const { activeView, activeWorktreeId, pending, repos } = useAppStore(
    useShallow((state) => ({
      activeView: state.activeView,
      activeWorktreeId: state.activeWorktreeId,
      pending: state.activePendingCreationId
        ? state.pendingWorktreeCreations[state.activePendingCreationId]
        : undefined,
      repos: state.repos
    }))
  )
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const recoveringDraft = useRef(false)
  const session = useCreationDraftSession()
  const [hiddenId, setHiddenId] = useState<string | null>(null)
  useEffect(() => {
    void loadCreationDrafts()
    const refresh = (): void => {
      void loadCreationDrafts(true)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  if (activeView !== 'terminal') {
    return null
  }
  const drafts = Object.values(session.entries)
  const eligiblePending =
    pending?.request.agent && pending.request.agentLaunchRoute !== 'structured-native-chat'
      ? pending
      : undefined
  const selected = session.viewedDraftId ? session.entries[session.viewedDraftId] : undefined
  const workspaceDraft = drafts.find(
    (entry) =>
      entry.buffer.target?.worktreeId === activeWorktreeId &&
      entry.buffer.delivery?.state !== 'delivered'
  )
  const id = selected?.buffer.id ?? eligiblePending?.creationId ?? workspaceDraft?.buffer.id
  const entry = id ? session.entries[id] : undefined
  const repo = eligiblePending
    ? repos.find((item) => item.id === eligiblePending.request.repoId)
    : undefined
  const initial: CreationDraftInput | undefined =
    entry?.buffer ??
    (eligiblePending && repo
      ? {
          id: eligiblePending.creationId,
          title: eligiblePending.request.displayName || eligiblePending.request.name,
          text: '',
          updatedAt: eligiblePending.startedAt,
          agent: eligiblePending.request.agent!,
          executionHostId:
            eligiblePending.request.workspaceRunContext?.hostId ?? getRepoExecutionHostId(repo)
        }
      : undefined)
  const showEditor = initial && id !== hiddenId
  if (!showEditor && drafts.length === 0 && !session.loadError) {
    return null
  }
  return (
    <div className="shrink-0 border-t border-border bg-editor-surface p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {showEditor ? (
          <span className="min-w-0 flex-1 truncate">{initial.title}</span>
        ) : (
          <span className="flex-1" />
        )}
        {drafts.length > 0 ? (
          <DropdownMenu
            onOpenChange={(open) => {
              if (open) {
                void loadCreationDrafts(true)
              }
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs">
                {translate('creationDraft.savedDrafts', 'Saved drafts')} ({drafts.length})
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (recoveringDraft.current) {
                  recoveringDraft.current = false
                  event.preventDefault()
                  editorRef.current?.focus()
                }
              }}
            >
              {drafts.map(({ buffer }) => (
                <DropdownMenuItem
                  key={buffer.id}
                  onSelect={() => {
                    recoveringDraft.current = true
                    useCreationDraftSession.setState({ viewedDraftId: buffer.id })
                    setHiddenId(null)
                  }}
                >
                  {buffer.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {showEditor ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setHiddenId(initial.id)
              useCreationDraftSession.setState({ viewedDraftId: null })
            }}
          >
            {translate('creationDraft.hide', 'Hide')}
          </Button>
        ) : null}
      </div>
      {session.loadError ? (
        <div role="alert" className="text-xs text-destructive">
          {translate('creationDraft.loadFailed', 'Saved drafts could not be loaded.')}
          <Button variant="link" size="xs" onClick={() => void loadCreationDrafts()}>
            {translate('creationDraft.retry', 'Retry')}
          </Button>
        </div>
      ) : null}
      {showEditor ? (
        <CreationDraftEditor key={initial.id} initial={initial} editorRef={editorRef} />
      ) : null}
    </div>
  )
}
