import { ChevronDown, ChevronRight, Link2, Network, RotateCw } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '@/store/slices/editor'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import {
  collectMarkdownBacklinks,
  markdownBacklinkSearchOptions,
  type MarkdownBacklink
} from './markdown-backlinks'
import { MarkdownNoteGraphDialog } from './MarkdownNoteGraphDialog'
import {
  useMarkdownWorkspaceSearch,
  type MarkdownWorkspaceSearch
} from './use-markdown-workspace-search'

type MarkdownBacklinksPanelProps = {
  activeFile: OpenFile
  markdownDocuments: MarkdownDocument[]
  onOpenDocument: (document: MarkdownDocument) => void
}

/** Puts the Backlinks bar under a Markdown view without each surface repeating the layout. */
export function WithMarkdownBacklinks({
  activeFile,
  documents,
  children
}: {
  activeFile: OpenFile
  documents: {
    markdownDocuments: MarkdownDocument[]
    openMarkdownDocument: (document: MarkdownDocument) => Promise<void>
  }
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      <MarkdownBacklinksPanel
        activeFile={activeFile}
        markdownDocuments={documents.markdownDocuments}
        onOpenDocument={(document) => void documents.openMarkdownDocument(document)}
      />
    </div>
  )
}

/** Obsidian-style "linked mentions": collapsed by default; only the open list reads the store and searches. */
export function MarkdownBacklinksPanel(props: MarkdownBacklinksPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const onOpenGraph = (): void => setGraphOpen(true)
  return (
    <section className="shrink-0 border-t border-border text-xs">
      <MarkdownNoteGraphDialog open={graphOpen} onOpenChange={setGraphOpen} {...props} />
      {open ? (
        // Why keyed: a reused list would show the previous note's backlinks for a frame.
        <OpenMarkdownBacklinks
          key={props.activeFile.filePath}
          {...props}
          onClose={() => setOpen(false)}
          onOpenGraph={onOpenGraph}
        />
      ) : (
        <MarkdownBacklinksHeader
          open={false}
          count={null}
          onToggle={() => setOpen(true)}
          onOpenGraph={onOpenGraph}
        />
      )}
    </section>
  )
}

function MarkdownBacklinksHeader({
  open,
  count,
  onToggle,
  onRefresh,
  onOpenGraph
}: {
  open: boolean
  count: number | null
  onToggle: () => void
  onRefresh?: () => void
  onOpenGraph: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 px-2 py-1 text-muted-foreground">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent hover:text-foreground"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Link2 size={14} />
        <span>{translate('auto.components.editor.MarkdownBacklinksPanel.title', 'Backlinks')}</span>
        {count !== null ? <span className="tabular-nums">({count})</span> : null}
      </button>
      {onRefresh ? (
        <button
          type="button"
          className="rounded p-1 hover:bg-accent hover:text-foreground"
          onClick={onRefresh}
          aria-label={translate(
            'auto.components.editor.MarkdownBacklinksPanel.refresh',
            'Refresh backlinks'
          )}
        >
          <RotateCw size={12} />
        </button>
      ) : null}
      <button
        type="button"
        className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
        onClick={onOpenGraph}
      >
        <Network size={12} />
        {translate('auto.components.editor.MarkdownBacklinksPanel.graph', 'Graph')}
      </button>
    </div>
  )
}

function OpenMarkdownBacklinks({
  activeFile,
  markdownDocuments,
  onOpenDocument,
  onClose,
  onOpenGraph
}: MarkdownBacklinksPanelProps & {
  onClose: () => void
  onOpenGraph: () => void
}): React.JSX.Element {
  const search = useMemo<MarkdownWorkspaceSearch<MarkdownBacklink[]>>(() => {
    const findTarget = (documents: MarkdownDocument[]): MarkdownDocument | undefined =>
      documents.find((document) => document.filePath === activeFile.filePath)
    return {
      options: (documents, rootPath) => {
        const target = findTarget(documents)
        return target ? markdownBacklinkSearchOptions(target, rootPath) : null
      },
      interpret: (documents, result) => {
        const target = findTarget(documents)
        return target ? collectMarkdownBacklinks(target, documents, result) : []
      },
      empty: []
    }
  }, [activeFile.filePath])
  const { state, refresh } = useMarkdownWorkspaceSearch(activeFile, markdownDocuments, search)
  return (
    <>
      <MarkdownBacklinksHeader
        open
        count={state.status === 'ready' ? state.value.length : null}
        onToggle={onClose}
        onRefresh={refresh}
        onOpenGraph={onOpenGraph}
      />
      <div className="scrollbar-editor max-h-48 overflow-y-auto px-2 pb-2">
        {state.status === 'loading' || state.status === 'idle' ? (
          <div className="px-1 py-1 text-muted-foreground">
            {translate('auto.components.editor.MarkdownBacklinksPanel.loading', 'Searching…')}
          </div>
        ) : state.status === 'error' ? (
          <div role="alert" className="px-1 py-1 text-destructive">
            {state.message}
          </div>
        ) : state.value.length === 0 ? (
          <div className="px-1 py-1 text-muted-foreground">
            {translate(
              'auto.components.editor.MarkdownBacklinksPanel.empty',
              'No notes link here yet'
            )}
          </div>
        ) : (
          <ul>
            {state.value.map((backlink) => (
              <li key={`${backlink.source.filePath}:${backlink.line}`}>
                <button
                  type="button"
                  className="flex w-full min-w-0 flex-col rounded px-1 py-1 text-left hover:bg-accent"
                  onClick={() => onOpenDocument(backlink.source)}
                >
                  <span className="truncate text-foreground">
                    {backlink.source.relativePath}
                    <span className="ml-1 text-muted-foreground tabular-nums">
                      :{backlink.line}
                    </span>
                  </span>
                  <span className="truncate text-muted-foreground">{backlink.lineContent}</span>
                </button>
              </li>
            ))}
            {state.truncated ? (
              <li className="px-1 py-1 text-muted-foreground">
                {translate(
                  'auto.components.editor.MarkdownBacklinksPanel.truncated',
                  'Search hit its result limit; some backlinks may be missing'
                )}
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </>
  )
}
