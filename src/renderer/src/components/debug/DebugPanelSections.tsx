import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { debugClient } from '@/lib/debug/debug-client'
import {
  debugSessionStore,
  useDebugSession,
  type DebugSessionStore
} from '@/lib/debug/use-debug-session'
import { openMatchResult } from '@/components/right-sidebar/search-match-open'
import {
  relativeToRoot,
  type DebugRevealSource,
  type DebugSectionsClient
} from './debug-section-contract'
import DebugVariablesSection from './DebugVariablesSection'
import DebugWatchSection from './DebugWatchSection'
import DebugCallStackSection from './DebugCallStackSection'
import DebugBreakpointsSection from './DebugBreakpointsSection'
import DebugConsoleSection from './DebugConsoleSection'

type DebugPanelSectionsProps = {
  /** Core's realpath for the session, as in snapshot.worktreePath. */
  worktreePath: string
  /** Orca's own path for the worktree; only the worktree lookup and reveal use it. Defaults to worktreePath. */
  rendererPath?: string
  /** Defaults to the repo of the Orca worktree at rendererPath. */
  repoId?: string
  client?: DebugSectionsClient
  store?: DebugSessionStore
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div className="border-b border-border">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronRight className={cn('size-3.5 shrink-0', open && 'rotate-90')} />
            <span role="heading" aria-level={3}>
              {title}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-1">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export default function DebugPanelSections({
  worktreePath,
  rendererPath = worktreePath,
  repoId,
  client = debugClient,
  store = debugSessionStore
}: DebugPanelSectionsProps): React.JSX.Element {
  const session = useDebugSession(worktreePath, store)
  const worktree = useAppStore((s) =>
    Object.values(s.worktreesByRepo ?? {})
      .flat()
      .find((candidate) => candidate.path === rendererPath)
  )
  const openFile = useAppStore((s) => s.openFile)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const revealRafRef = useRef<number | null>(null)
  const revealInnerRafRef = useRef<number | null>(null)
  const resolvedRepoId = repoId ?? worktree?.repoId
  const target = useMemo(
    () => (resolvedRepoId ? { repoId: resolvedRepoId, worktreePath } : null),
    [resolvedRepoId, worktreePath]
  )

  // The store loads the stopped stack itself once it knows which repo core's path belongs to.
  useEffect(() => {
    if (target) {
      store.bindRepo(target.worktreePath, target.repoId)
    }
  }, [store, target])

  const reveal = useCallback<DebugRevealSource>(
    (filePath, line, column = 1) => {
      if (!worktree) {
        setPendingEditorReveal({ filePath, line, column, matchLength: 0 })
        return
      }
      // Debugging is local-only, so the file never belongs to a runtime environment.
      openMatchResult({
        resultOwner: { worktreeId: worktree.id, runtimeEnvironmentId: null },
        fileResult: {
          filePath,
          relativePath: relativeToRoot(worktree.path, filePath),
          matches: []
        },
        match: { line, column, matchLength: 0, lineContent: '' },
        openFile,
        setPendingEditorReveal,
        revealRafRef,
        revealInnerRafRef
      })
    },
    [openFile, setPendingEditorReveal, worktree]
  )

  if (!target) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {translate('debug.sections.noWorktree', 'This folder is not an Orca workspace.')}
      </div>
    )
  }
  const props = { client, target, session }
  return (
    <div className="flex min-h-0 flex-col text-xs">
      <Section title={translate('debug.variables.title', 'Variables')}>
        <DebugVariablesSection {...props} />
      </Section>
      <Section title={translate('debug.watch.title', 'Watch')}>
        <DebugWatchSection {...props} />
      </Section>
      <Section title={translate('debug.callStack.title', 'Call Stack')}>
        <DebugCallStackSection {...props} store={store} reveal={reveal} />
      </Section>
      <Section title={translate('debug.breakpoints.title', 'Breakpoints')}>
        <DebugBreakpointsSection {...props} store={store} reveal={reveal} />
      </Section>
      <Section title={translate('debug.console.title', 'Debug Console')}>
        <DebugConsoleSection {...props} />
      </Section>
    </div>
  )
}
