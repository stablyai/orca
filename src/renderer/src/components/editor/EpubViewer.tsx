import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, List } from 'lucide-react'
import ePub, { type Book, type Rendition } from 'epubjs'
import type { Location } from 'epubjs/types/rendition'
import type { NavItem } from 'epubjs/types/navigation'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { epubBase64ToArrayBuffer } from './epub-base64-to-array-buffer'
import { flattenEpubToc, type FlatTocEntry } from './epub-toc-flatten'
import { epubLocationCache, setWithLRU } from '@/lib/scroll-cache'

type EpubViewerProps = {
  content: string
  filePath: string
  // Why: absent means "no location memory" — matches PdfViewer, where diff and
  // conflict-review callers mount several viewers on one path.
  scrollCacheKey?: string | null
}

// Why: book text renders in an isolated iframe that cannot read Orca's CSS
// variables, so the theme colors are passed in explicitly.
const LIGHT_THEME = {
  body: { color: '#18181b', background: '#ffffff' },
  a: { color: '#2563eb' }
}
const DARK_THEME = {
  body: { color: '#d4d4d8', background: '#18181b' },
  a: { color: '#60a5fa' }
}

export default function EpubViewer({
  content,
  filePath,
  scrollCacheKey = null
}: EpubViewerProps): JSX.Element {
  const renderRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const [error, setError] = useState<string | null>(null)
  const [toc, setToc] = useState<FlatTocEntry[]>([])
  const [showToc, setShowToc] = useState(false)
  const [currentHref, setCurrentHref] = useState<string | null>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])

  const goPrev = useCallback(() => {
    renditionRef.current?.prev()
  }, [])
  const goNext = useCallback(() => {
    renditionRef.current?.next()
  }, [])
  const goToHref = useCallback((href: string) => {
    renditionRef.current?.display(href)
    setShowToc(false)
  }, [])

  useEffect(() => {
    const container = renderRef.current
    if (!container || !cleanedContent) {
      return
    }

    setError(null)
    let cancelled = false
    let book: Book | null = null
    let rendition: Rendition | null = null

    try {
      book = ePub(epubBase64ToArrayBuffer(cleanedContent))
    } catch {
      setError(translate('epub.viewer.decodeError', 'Failed to decode this EPUB'))
      return
    }

    rendition = book.renderTo(container, {
      flow: 'paginated',
      width: '100%',
      height: '100%',
      spread: 'auto'
    })
    renditionRef.current = rendition

    rendition.themes.register('orca-light', LIGHT_THEME)
    rendition.themes.register('orca-dark', DARK_THEME)
    rendition.themes.select(isDark ? 'orca-dark' : 'orca-light')

    const handleRelocated = (location: Location): void => {
      if (cancelled) {
        return
      }
      const cfi = location?.start?.cfi
      if (cfi && scrollCacheKey) {
        setWithLRU(epubLocationCache, scrollCacheKey, cfi)
      }
      setAtStart(Boolean(location?.atStart))
      setAtEnd(Boolean(location?.atEnd))
      setCurrentHref(location?.start?.href ?? null)
    }
    rendition.on('relocated', handleRelocated)

    // Why: arrow keys pressed while focus is inside the book iframe reach us only
    // through epub.js's forwarded key event, not a window listener.
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft') {
        goPrev()
      } else if (event.key === 'ArrowRight') {
        goNext()
      }
    }
    rendition.on('keyup', handleKey)

    const savedCfi = scrollCacheKey ? epubLocationCache.get(scrollCacheKey) : undefined

    book.ready
      .then(() => {
        if (cancelled || !book) {
          return
        }
        setToc(flattenEpubToc(book.navigation?.toc as NavItem[] | undefined))
        return rendition?.display(savedCfi)
      })
      .catch(() => {
        if (!cancelled) {
          setError(translate('epub.viewer.openError', 'Couldn’t open this EPUB'))
        }
      })

    return () => {
      cancelled = true
      rendition?.off('relocated', handleRelocated)
      rendition?.off('keyup', handleKey)
      rendition?.destroy()
      book?.destroy()
      renditionRef.current = null
    }
    // Why: scrollCacheKey is a dependency because two paths can hold identical
    // bytes — without it the effect would not re-run on a switch and the second
    // book would restore the first book's location. isDark is intentionally
    // excluded: a separate effect re-selects the theme without rebuilding.
  }, [cleanedContent, scrollCacheKey, goPrev, goNext])

  // Why: re-select the theme on toggle without tearing down and rebuilding the
  // rendition (which would lose the reader's page).
  useEffect(() => {
    renditionRef.current?.themes.select(isDark ? 'orca-dark' : 'orca-light')
  }, [isDark])

  if (error) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-muted/20 p-8 text-sm text-muted-foreground">
          <BookOpen size={40} />
          <div>{error}</div>
          <div className="max-w-md break-all text-center text-xs">{filename}</div>
        </div>
        <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={filename}>
            {filename}
          </span>
          <span>{translate('epub.viewer.label', 'EPUB preview')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1">
        {showToc && (
          <nav className="w-64 shrink-0 overflow-y-auto border-r bg-muted/20 py-2 scrollbar-editor">
            {toc.length === 0 ? (
              <div className="px-4 py-2 text-xs text-muted-foreground">
                {translate('epub.viewer.noContents', 'No table of contents')}
              </div>
            ) : (
              toc.map((entry) => (
                <button
                  key={`${entry.href} ${entry.depth}`}
                  type="button"
                  onClick={() => goToHref(entry.href)}
                  style={{ paddingLeft: `${entry.depth * 12 + 16}px` }}
                  className={cn(
                    'block w-full truncate py-1 pr-3 text-left text-xs hover:bg-accent hover:text-foreground',
                    currentHref && entry.href.split('#')[0] === currentHref.split('#')[0]
                      ? 'text-foreground'
                      : 'text-muted-foreground'
                  )}
                  title={entry.label}
                >
                  {entry.label}
                </button>
              ))
            )}
          </nav>
        )}
        <div className="relative min-w-0 flex-1">
          <div ref={renderRef} className="absolute inset-0" />
          <button
            type="button"
            onClick={goPrev}
            disabled={atStart}
            aria-label={translate('epub.viewer.previousPage', 'Previous page')}
            className="absolute left-2 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-full p-1.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
          >
            {/* Why: a chevron reads as weighted toward its point; nudge it back to look optically centered. */}
            <ChevronLeft size={20} className="translate-x-[1px]" />
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={atEnd}
            aria-label={translate('epub.viewer.nextPage', 'Next page')}
            className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-full p-1.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
          >
            <ChevronRight size={20} className="translate-x-[-1px]" />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setShowToc((open) => !open)}
          className={cn(
            'rounded p-1 hover:bg-accent hover:text-foreground',
            showToc && 'bg-accent text-foreground'
          )}
          title={translate('epub.viewer.tableOfContents', 'Table of contents')}
        >
          <List size={14} />
        </button>
        <span className="min-w-0 truncate" title={filename}>
          {filename}
        </span>
        <span>{translate('epub.viewer.label', 'EPUB preview')}</span>
      </div>
    </div>
  )
}
