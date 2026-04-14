import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import rehypeHighlight from 'rehype-highlight'
import { extractFrontMatter } from './markdown-frontmatter'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { Components } from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { getMarkdownPreviewLinkTarget } from './markdown-preview-links'
import { useLocalImageSrc } from './useLocalImageSrc'
import CodeBlockCopyButton from './CodeBlockCopyButton'
import MermaidBlock from './MermaidBlock'
import {
  applyMarkdownPreviewSearchHighlights,
  clearMarkdownPreviewSearchHighlights,
  isMarkdownPreviewFindShortcut,
  setActiveMarkdownPreviewSearchMatch
} from './markdown-preview-search'

type MarkdownPreviewProps = {
  content: string
  filePath: string
}

export default function MarkdownPreview({
  content,
  filePath
}: MarkdownPreviewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const matchesRef = useRef<HTMLElement[]>([])
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1)
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const editorFontSize = computeEditorFontSize(14, editorFontZoomLevel)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const frontMatter = useMemo(() => extractFrontMatter(content), [content])
  const frontMatterInner = useMemo(() => {
    if (!frontMatter) {
      return ''
    }
    return frontMatter.raw
      .replace(/^(?:---|\+\+\+)\r?\n/, '')
      .replace(/\r?\n(?:---|\+\+\+)\r?\n?$/, '')
      .trim()
  }, [frontMatter])

  // Why: Each markdown viewing mode (source/rich/preview) produces different
  // DOM structures and content heights. A scroll position saved in source mode
  // has no meaningful correspondence in preview mode. Using mode-scoped keys
  // means each mode remembers its own position independently.
  const scrollCacheKey = `${filePath}:preview`

  // Save scroll position with trailing throttle and synchronous unmount snapshot.
  useLayoutEffect(() => {
    const container = rootRef.current
    if (!container) {
      return
    }

    let throttleTimer: ReturnType<typeof setTimeout> | null = null

    const onScroll = (): void => {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      throttleTimer = setTimeout(() => {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        throttleTimer = null
      }, 150)
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      // Why: During React StrictMode double-mount (or rapid mount/unmount before
      // react-markdown renders content), scrollHeight equals clientHeight and
      // scrollTop is 0. Saving that would clobber a valid cached position.
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
    }
  }, [scrollCacheKey])

  // Restore scroll position with RAF retry loop for async react-markdown content.
  useLayoutEffect(() => {
    const container = rootRef.current
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    if (!container || targetScrollTop === undefined) {
      return
    }

    let frameId = 0
    let attempts = 0

    // Why: react-markdown renders asynchronously, so scrollHeight may still be
    // too small on the first frame. Retry up to 30 frames (~500ms at 60fps) to
    // accommodate content loading. This matches CombinedDiffViewer's proven
    // pattern for dynamic-height content restoration.
    const tryRestore = (): void => {
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      const nextScrollTop = Math.min(targetScrollTop, maxScrollTop)
      container.scrollTop = nextScrollTop

      if (Math.abs(container.scrollTop - targetScrollTop) <= 1 || maxScrollTop >= targetScrollTop) {
        return
      }

      attempts += 1
      if (attempts < 30) {
        frameId = window.requestAnimationFrame(tryRestore)
      }
    }

    tryRestore()
    return () => window.cancelAnimationFrame(frameId)
    // Why: content is included so the restore loop re-triggers when markdown
    // content arrives or changes (e.g., async file load), since scrollHeight
    // depends on rendered content and may not be large enough until then.
  }, [scrollCacheKey, content])

  const moveToMatch = useCallback((direction: 1 | -1) => {
    const matches = matchesRef.current
    if (matches.length === 0) {
      return
    }
    setActiveMatchIndex((currentIndex) => {
      const baseIndex = currentIndex >= 0 ? currentIndex : direction === 1 ? -1 : 0
      const nextIndex = (baseIndex + direction + matches.length) % matches.length
      return nextIndex
    })
  }, [])

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false)
    setQuery('')
    setActiveMatchIndex(-1)
  }, [])

  useEffect(() => {
    if (isSearchOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isSearchOpen])

  useEffect(() => {
    const body = bodyRef.current
    if (!body) {
      return
    }

    if (!isSearchOpen) {
      matchesRef.current = []
      setMatchCount(0)
      clearMarkdownPreviewSearchHighlights(body)
      return
    }

    // Search decorations are applied imperatively because the rendered preview is
    // already owned by react-markdown. Rewriting the markdown AST for transient
    // find state would make navigation and link rendering much harder to reason about.
    const matches = applyMarkdownPreviewSearchHighlights(body, query)
    matchesRef.current = matches
    setMatchCount(matches.length)
    setActiveMatchIndex((currentIndex) => {
      if (matches.length === 0) {
        return -1
      }
      if (currentIndex >= 0 && currentIndex < matches.length) {
        return currentIndex
      }
      return 0
    })

    return () => clearMarkdownPreviewSearchHighlights(body)
  }, [content, isSearchOpen, query])

  useEffect(() => {
    setActiveMarkdownPreviewSearchMatch(matchesRef.current, activeMatchIndex)
  }, [activeMatchIndex, matchCount])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root) {
        return
      }

      const target = event.target
      const targetInsidePreview = target instanceof Node && root.contains(target)
      const targetIsEditable =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select') !== null)

      if (
        isMarkdownPreviewFindShortcut(event, navigator.userAgent.includes('Mac')) &&
        (isSearchOpen || targetInsidePreview || !targetIsEditable)
      ) {
        event.preventDefault()
        event.stopPropagation()
        setIsSearchOpen(true)
        return
      }

      if (!isSearchOpen) {
        return
      }

      if (event.key === 'Escape' && (targetInsidePreview || target === inputRef.current)) {
        event.preventDefault()
        event.stopPropagation()
        closeSearch()
        root.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [closeSearch, isSearchOpen, setIsSearchOpen])

  const components: Components = {
    a: ({ href, children, ...props }) => {
      const handleClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
        if (!href || href.startsWith('#')) {
          return
        }

        event.preventDefault()

        const target = getMarkdownPreviewLinkTarget(href, filePath)
        if (!target) {
          return
        }

        let parsed: URL
        try {
          parsed = new URL(target)
        } catch {
          return
        }

        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          void window.api.shell.openUrl(parsed.toString())
          return
        }

        if (parsed.protocol === 'file:') {
          void window.api.shell.openFileUri(parsed.toString())
        }
      }

      return (
        <a {...props} href={href} onClick={handleClick}>
          {children}
        </a>
      )
    },
    img: function MarkdownImg({ src, alt, ...props }) {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- react-markdown
      // instantiates component overrides as regular React components, so hooks
      // are valid here despite the lowercase function name.
      const resolvedSrc = useLocalImageSrc(src, filePath)
      return <img {...props} src={resolvedSrc} alt={alt ?? ''} />
    },
    // Why: Intercept code elements to detect mermaid fenced blocks. rehype-highlight
    // sets className="language-mermaid" on the <code> inside <pre> for ```mermaid blocks.
    // We render those as SVG diagrams instead of highlighted source. Markdown preview
    // opts out of Mermaid HTML labels because this path sanitizes the SVG before
    // injection, and sanitized foreignObject labels disappear on some platforms.
    code: ({ className, children, ...props }) => {
      if (/language-mermaid/.test(className || '')) {
        return (
          <MermaidBlock content={String(children).trimEnd()} isDark={isDark} htmlLabels={false} />
        )
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    },
    // Why: Wrap <pre> blocks with a positioned container so a copy button can
    // overlay the code block. Mermaid diagrams are detected and passed through
    // unwrapped — MermaidBlock renders via useEffect/innerHTML, not React children,
    // so CodeBlockCopyButton's extractText() would copy an empty string, and a
    // <div> inside <pre> produces invalid HTML.
    pre: ({ children, ...props }) => {
      const child = React.Children.toArray(children)[0]
      if (React.isValidElement(child) && child.type === MermaidBlock) {
        return <>{children}</>
      }
      return <CodeBlockCopyButton {...props}>{children}</CodeBlockCopyButton>
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      style={{ fontSize: `${editorFontSize}px` }}
      className={`markdown-preview h-full min-h-0 overflow-auto scrollbar-editor ${isDark ? 'markdown-dark' : 'markdown-light'}`}
    >
      {isSearchOpen ? (
        <div className="markdown-preview-search" onKeyDown={(event) => event.stopPropagation()}>
          <div className="markdown-preview-search-field">
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.shiftKey) {
                  event.preventDefault()
                  moveToMatch(-1)
                  return
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  moveToMatch(1)
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeSearch()
                  rootRef.current?.focus()
                }
              }}
              placeholder="Find in preview"
              className="markdown-preview-search-input h-7 !border-0 bg-transparent px-2 shadow-none focus-visible:!border-0 focus-visible:ring-0"
              aria-label="Find in markdown preview"
            />
          </div>
          <div className="markdown-preview-search-status">
            {query && matchCount === 0
              ? 'No results'
              : `${matchCount === 0 ? 0 : activeMatchIndex + 1}/${matchCount}`}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => moveToMatch(-1)}
            disabled={matchCount === 0}
            title="Previous match"
            aria-label="Previous match"
            className="markdown-preview-search-button"
          >
            <ChevronUp size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => moveToMatch(1)}
            disabled={matchCount === 0}
            title="Next match"
            aria-label="Next match"
            className="markdown-preview-search-button"
          >
            <ChevronDown size={14} />
          </Button>
          <div className="markdown-preview-search-divider" />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={closeSearch}
            title="Close search"
            aria-label="Close search"
            className="markdown-preview-search-button"
          >
            <X size={14} />
          </Button>
        </div>
      ) : null}
      <div ref={bodyRef} className="markdown-body">
        {/* Why: remarkFrontmatter silently strips front-matter from rendered
        output. We extract it ourselves and render it as a styled code block so
        the user can see the metadata in preview mode. */}
        {frontMatter && (
          <div className="mb-4 rounded border border-border/60 bg-muted/40 px-3 py-2">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Front Matter
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground font-mono scrollbar-editor">
              {frontMatterInner}
            </pre>
          </div>
        )}
        <Markdown
          components={components}
          remarkPlugins={[remarkGfm, remarkFrontmatter]}
          rehypePlugins={[rehypeHighlight]}
        >
          {content}
        </Markdown>
      </div>
    </div>
  )
}
