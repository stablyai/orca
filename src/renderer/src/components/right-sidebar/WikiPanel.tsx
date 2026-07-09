import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { openHttpLink } from '@/lib/http-link-routing'
import { useMountedRef } from '@/hooks/useMountedRef'
import { createWikiHistory, type WikiHistory } from './wiki-panel-navigation'
import { prepareWikiNoteForDisplay } from './wiki-note-content'
import { WikiPanelTopBar } from './WikiPanelTopBar'
import { WikiPanelSetupState } from './WikiPanelSetupState'

type WikiNote = { relativePath: string; content: string }
type WikiPanelPhase = 'loading' | 'empty' | 'generating' | 'error' | 'content'

const EXTERNAL_LINK_PATTERN = /^https?:\/\//i
const DEFAULT_LOAD_ERROR = 'Failed to load the wiki.'
const DEFAULT_GENERATE_ERROR = 'Failed to start generation.'

export default function WikiPanel(): React.JSX.Element | null {
  const activeWorktree = useActiveWorktree()
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const worktreeId = activeWorktree?.id ?? null

  const [phase, setPhase] = useState<WikiPanelPhase>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [note, setNote] = useState<WikiNote | null>(null)
  const [addClaudeMd, setAddClaudeMd] = useState(true)
  const [generatingOutput, setGeneratingOutput] = useState('')
  const [, bumpHistoryTick] = useState(0)
  const historyRef = useRef<WikiHistory | null>(null)
  const mountedRef = useMountedRef()
  // Why: every wiki read/generate shares this counter so a worktree switch or a
  // newer click invalidates any still-in-flight response before it can apply.
  const requestIdRef = useRef(0)
  const displayContent = React.useMemo(
    () => (note ? prepareWikiNoteForDisplay(note.content) : ''),
    [note]
  )

  const load = useCallback(
    async (id: string): Promise<void> => {
      const requestId = ++requestIdRef.current
      setPhase('loading')
      try {
        const result = await window.api.wiki.read({ worktreeId: id })
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }
        if (!result.hasWiki) {
          setPhase('empty')
          return
        }
        if (!result.note) {
          setErrorMessage('Failed to load the wiki root page.')
          setPhase('error')
          return
        }
        historyRef.current = createWikiHistory(result.rootRelativePath)
        setNote(result.note)
        setPhase('content')
      } catch (error) {
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }
        setErrorMessage(error instanceof Error ? error.message : DEFAULT_LOAD_ERROR)
        setPhase('error')
      }
    },
    [mountedRef]
  )

  // Why: generation state lives in the main process (WikiGenerationService), so
  // a fresh mount must check it first — a sidebar tab switch away and back must
  // not lose an in-progress generation to a stale "empty"/"content" read.
  useEffect(() => {
    if (!worktreeId) {
      return
    }
    let canceled = false
    void (async () => {
      const status = await window.api.wiki.generationStatus({ worktreeId })
      if (canceled) {
        return
      }
      if (status?.running) {
        setGeneratingOutput(status.output)
        setPhase('generating')
        return
      }
      if (status && !status.running && status.error) {
        setErrorMessage(status.error)
        setPhase('error')
        return
      }
      void load(worktreeId)
    })()
    return () => {
      canceled = true
    }
  }, [worktreeId, load, mountedRef])

  useEffect(() => {
    if (!worktreeId) {
      return
    }
    const unsubscribe = window.api.wiki.onGenerationChanged((payload) => {
      if (payload.worktreeId !== worktreeId) {
        return
      }
      if (payload.running) {
        setGeneratingOutput(payload.output)
        setPhase('generating')
        return
      }
      if (payload.done) {
        void load(worktreeId)
        return
      }
      if (payload.error) {
        setErrorMessage(payload.error)
        setPhase('error')
      }
    })
    return unsubscribe
  }, [worktreeId, load, mountedRef])

  const handleGenerate = useCallback(async (): Promise<void> => {
    if (!worktreeId) {
      return
    }
    const requestId = ++requestIdRef.current
    try {
      const result = await window.api.wiki.generate({
        worktreeId,
        addClaudeMdInstruction: addClaudeMd
      })
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return
      }
      if (result.ok) {
        setGeneratingOutput('')
        setPhase('generating')
        return
      }
      toast.error(result.error)
      setErrorMessage(result.error)
      setPhase('error')
    } catch (error) {
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return
      }
      const message = error instanceof Error ? error.message : DEFAULT_GENERATE_ERROR
      toast.error(message)
      setErrorMessage(message)
      setPhase('error')
    }
  }, [worktreeId, mountedRef, addClaudeMd])

  const handleStop = useCallback(async (): Promise<void> => {
    if (!worktreeId) {
      return
    }
    // Why: the following main-process status change (running:false) drives the
    // phase transition out of "generating" — no local phase flip here.
    await window.api.wiki.cancelGeneration({ worktreeId })
  }, [worktreeId])

  const loadNoteAt = useCallback(
    (relativePath: string): void => {
      if (!worktreeId) {
        return
      }
      const requestId = ++requestIdRef.current
      void window.api.wiki.read({ worktreeId, target: relativePath }).then((result) => {
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }
        if (result.hasWiki && result.note) {
          setNote(result.note)
        }
      })
    },
    [worktreeId, mountedRef]
  )

  const handleBack = useCallback((): void => {
    if (!historyRef.current?.canGoBack()) {
      return
    }
    historyRef.current.back()
    loadNoteAt(historyRef.current.current())
    bumpHistoryTick((tick) => tick + 1)
  }, [loadNoteAt])

  const handleHome = useCallback((): void => {
    if (!historyRef.current?.canGoBack()) {
      return
    }
    historyRef.current.home()
    loadNoteAt(historyRef.current.current())
    bumpHistoryTick((tick) => tick + 1)
  }, [loadNoteAt])

  const handleLinkClick = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) => {
      if (!href) {
        return
      }
      event.preventDefault()
      if (EXTERNAL_LINK_PATTERN.test(href)) {
        openHttpLink(href, { worktreeId })
        return
      }
      // Why: wiki link navigation stays inside this panel — never hand off to the editor.
      if (!worktreeId || !historyRef.current) {
        return
      }
      const fromRelativePath = historyRef.current.current()
      const requestId = ++requestIdRef.current
      void window.api.wiki.read({ worktreeId, target: href, fromRelativePath }).then((result) => {
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }
        if (result.hasWiki && result.note) {
          historyRef.current?.push(result.note.relativePath)
          setNote(result.note)
          bumpHistoryTick((tick) => tick + 1)
        }
      })
    },
    [worktreeId, mountedRef]
  )

  if (!activeWorktree) {
    return null
  }

  const setupPhase = phase === 'content' ? 'loading' : phase

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      role="region"
      aria-label={repo ? `Wiki: ${repo.displayName}` : 'Wiki'}
    >
      {phase === 'content' && note ? (
        <>
          <WikiPanelTopBar
            relativePath={note.relativePath}
            canGoBack={historyRef.current?.canGoBack() ?? false}
            onBack={handleBack}
            onHome={handleHome}
          />
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <CommentMarkdown
              content={displayContent}
              variant="document"
              onLinkClick={handleLinkClick}
            />
          </div>
        </>
      ) : (
        <WikiPanelSetupState
          phase={setupPhase}
          errorMessage={errorMessage}
          addClaudeMd={addClaudeMd}
          onAddClaudeMdChange={setAddClaudeMd}
          generatingOutput={generatingOutput}
          onGenerate={() => void handleGenerate()}
          onStop={() => void handleStop()}
        />
      )}
    </div>
  )
}
