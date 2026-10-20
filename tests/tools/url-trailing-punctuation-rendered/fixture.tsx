import React from 'react'
import { createRoot } from 'react-dom/client'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { createPaneDOM } from '@/lib/pane-manager/pane-dom-creation'
import { createDragReorderState } from '@/lib/pane-manager/pane-drag-reorder'
import type {
  DragReorderCallbacks,
  ManagedPaneInternal,
  PaneStyleOptions
} from '@/lib/pane-manager/pane-manager-types'
import { isTerminalLeafId } from '../../../src/shared/stable-pane-id'
import './fixture.css'

// Two sentences a Japanese user actually types. Markdown breaks on both; the
// terminal regex already excluded half-width `)`, so it only breaks on the
// full-width pair. Each surface gets the sentence that exercises it.
const PROSE_HALF =
  '依頼文を用意しました。投稿はお願いします (https://github.com/stablyai/orca/pull/1078)。'
const PROSE_FULL =
  '依頼文を用意しました。投稿はお願いします（https://github.com/stablyai/orca/pull/1078）。'

function MarkdownHref({ label, content }: { label: string; content: string }): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [href, setHref] = React.useState('(no link rendered)')

  React.useEffect(() => {
    const anchor = containerRef.current?.querySelector('a')
    setHref(anchor?.getAttribute('href') ?? '(no link rendered)')
  }, [])

  return (
    <>
      <div ref={containerRef} className="rounded border border-border p-3 text-sm">
        <CommentMarkdown content={content} />
      </div>
      <ReadOut label={label} value={href} />
    </>
  )
}

function NativeChatProof(): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-muted-foreground">Native chat message</h2>
      <MarkdownHref label="href the click opens (half-width brackets)" content={PROSE_HALF} />
      <MarkdownHref label="href the click opens (full-width brackets)" content={PROSE_FULL} />
    </section>
  )
}

function ReadOut({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded border border-border bg-muted/40 p-3">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <code data-proof={label} className="break-all text-sm">
        {value}
      </code>
    </div>
  )
}

function createPaneCallbacks(root: HTMLElement): DragReorderCallbacks {
  const noop = (): void => undefined
  return {
    getPanes: () => new Map<number, ManagedPaneInternal>(),
    getRoot: () => root,
    getStyleOptions: (): PaneStyleOptions => ({}),
    isDestroyed: () => false,
    safeFit: noop,
    applyPaneOpacity: noop,
    applyDividerStyles: noop,
    refitPanesUnder: noop
  }
}

const PROOF_LEAF_ID = '00000000-4000-4000-8000-000000000001'
if (!isTerminalLeafId(PROOF_LEAF_ID)) {
  throw new Error('Proof leaf id must be a UUID')
}

function TerminalProof(): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const [uri, setUri] = React.useState('(hover not resolved)')

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    // Production pane construction: the same WebLinksAddon wiring a real pane gets.
    const pane = createPaneDOM(
      1,
      PROOF_LEAF_ID,
      {
        linkOpenHint: () => 'Cmd+click to open',
        onLinkClick: (_paneId, _event, url) => setUri(url),
        terminalOptions: () => ({ fontSize: 13, rows: 2, cols: 120 })
      },
      createDragReorderState(),
      createPaneCallbacks(host),
      () => undefined,
      () => undefined
    )
    host.appendChild(pane.container)
    pane.container.appendChild(pane.linkTooltip)
    pane.terminal.open(pane.xtermContainer)
    pane.terminal.loadAddon(pane.webLinksAddon)
    pane.terminal.write(PROSE_FULL)
    // The harness reads these to place a real hover over the URL.
    host.dataset.cols = String(pane.terminal.cols)
    host.dataset.rows = String(pane.terminal.rows)
    const observer = new MutationObserver(() => setUri(pane.linkTooltip.textContent ?? ''))
    observer.observe(pane.linkTooltip, { childList: true, characterData: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-muted-foreground">
        Terminal pane (full-width brackets)
      </h2>
      <div
        ref={hostRef}
        data-proof-terminal=""
        className="relative h-24 rounded border border-border p-2"
      />
      <ReadOut label="uri the hover reports" value={uri} />
    </section>
  )
}

const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing fixture root')
}
createRoot(root).render(
  <main className="flex min-h-screen flex-col gap-6 bg-background p-6 text-foreground">
    <header className="text-sm">
      URL boundary proof ·{' '}
      <span data-proof="label">
        {new URLSearchParams(location.search).get('label') ?? 'unknown'}
      </span>
    </header>
    <NativeChatProof />
    <TerminalProof />
  </main>
)
