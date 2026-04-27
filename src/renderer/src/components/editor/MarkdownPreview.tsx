/* eslint-disable max-lines -- Why: MarkdownPreview owns rendering, link interception,
search, and viewport state for the preview surface in one place so markdown
behavior stays coherent across split panes and preview tabs. */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeSlug from 'rehype-slug'
import GithubSlugger from 'github-slugger'
import { extractFrontMatter } from './markdown-frontmatter'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { Components } from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { detectLanguage } from '@/lib/language-detect'
import type { Worktree } from '../../../../shared/types'
import {
  fileUrlToAbsolutePath,
  getMarkdownPreviewLinkTarget,
  resolveMarkdownPreviewHref
} from './markdown-preview-links'
import { absolutePathToFileUri, resolveMarkdownLinkTarget } from './markdown-internal-links'
import { useLocalImageSrc } from './useLocalImageSrc'
import CodeBlockCopyButton from './CodeBlockCopyButton'
import MermaidBlock from './MermaidBlock'
import {
  applyMarkdownPreviewSearchHighlights,
  clearMarkdownPreviewSearchHighlights,
  isMarkdownPreviewFindShortcut,
  setActiveMarkdownPreviewSearchMatch
} from './markdown-preview-search'
import { usePreserveSectionDuringExternalEdit } from './usePreserveSectionDuringExternalEdit'
import { openHttpLink } from '@/lib/http-link-routing'

type MarkdownPreviewProps = {
  content: string
  filePath: string
  scrollCacheKey: string
  initialAnchor?: string | null
}

const markdownPreviewSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'kbd', 'sub', 'sup', 'ins'],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'id'],
    a: [...(defaultSchema.attributes?.a ?? []), 'href', 'title'],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', /^language-[\w-]+$/, 'math-inline', 'math-display']
    ],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', /^language-[\w-]+$/], 'align'],
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
    h1: [...(defaultSchema.attributes?.h1 ?? []), 'id'],
    h2: [...(defaultSchema.attributes?.h2 ?? []), 'id'],
    h3: [...(defaultSchema.attributes?.h3 ?? []), 'id'],
    h4: [...(defaultSchema.attributes?.h4 ?? []), 'id'],
    h5: [...(defaultSchema.attributes?.h5 ?? []), 'id'],
    h6: [...(defaultSchema.attributes?.h6 ?? []), 'id'],
    img: [...(defaultSchema.attributes?.img ?? []), 'src', 'alt', 'title', 'width', 'height'],
    input: [...(defaultSchema.attributes?.input ?? []), 'type', 'checked', 'disabled'],
    pre: [...(defaultSchema.attributes?.pre ?? []), ['className', /^language-[\w-]+$/]],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', /^hljs(?:-[\w-]+)?$/]],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align']
  }
}

function getMarkdownPreviewNodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map((child) => getMarkdownPreviewNodeText(child)).join('')
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return getMarkdownPreviewNodeText(node.props.children)
  }
  return ''
}

// Why: use the same GithubSlugger that rehype-slug uses internally so
// heading IDs match standard GitHub/VS Code anchor links. The custom
// slugger previously stripped punctuation differently, breaking links
// like `#a--b` for headings containing `A & B`.
function createMarkdownPreviewHeadingId(headingText: string, slugger: GithubSlugger): string {
  return slugger.slug(headingText)
}

function parseLineTarget(hash: string): { line: number; column?: number } | null {
  if (!hash) {
    return null
  }
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash
  const match = /^L(\d+)(?:C(\d+))?$/i.exec(trimmed)
  if (!match) {
    return null
  }
  return { line: Number(match[1]), column: match[2] ? Number(match[2]) : undefined }
}

function normalizeMarkdownPreviewAbsolutePath(absolutePath: string): string {
  return absolutePath.replaceAll('\\', '/')
}

function findWorktreeForMarkdownPreviewPath(
  worktreesByRepo: Record<string, Worktree[]>,
  absolutePath: string
): Worktree | null {
  const normalizedAbsolutePath = normalizeMarkdownPreviewAbsolutePath(absolutePath)
  let bestMatch: Worktree | null = null
  let bestMatchLength = -1

  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      const normalizedWorktreePath = normalizeMarkdownPreviewAbsolutePath(worktree.path)
      if (
        normalizedAbsolutePath === normalizedWorktreePath ||
        normalizedAbsolutePath.startsWith(`${normalizedWorktreePath}/`)
      ) {
        if (normalizedWorktreePath.length > bestMatchLength) {
          bestMatch = worktree
          bestMatchLength = normalizedWorktreePath.length
        }
      }
    }
  }

  return bestMatch
}

export default function MarkdownPreview({
  content,
  filePath,
  scrollCacheKey,
  initialAnchor = null
}: MarkdownPreviewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const matchesRef = useRef<HTMLElement[]>([])
  const lastAppliedInitialAnchorRef = useRef<string | null>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1)
  const isMac = navigator.userAgent.includes('Mac')
  const openFile = useAppStore((s) => s.openFile)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const worktreeRoot = findWorktreeForMarkdownPreviewPath(worktreesByRepo, filePath)?.path ?? null
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const editorFontSize = computeEditorFontSize(14, editorFontZoomLevel)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const renderedContent = usePreserveSectionDuringExternalEdit(content, bodyRef)

  const frontMatter = useMemo(() => extractFrontMatter(renderedContent), [renderedContent])
  const frontMatterInner = useMemo(() => {
    if (!frontMatter) {
      return ''
    }
    return frontMatter.raw
      .replace(/^(?:---|\+\+\+)\r?\n/, '')
      .replace(/\r?\n(?:---|\+\+\+)\r?\n?$/, '')
      .trim()
  }, [frontMatter])
  const sluggerRef = useRef(new GithubSlugger())

  // Why: each split pane needs its own markdown preview viewport even when the
  // underlying file is shared. The caller passes a pane-scoped cache key so
  // duplicate tabs do not overwrite each other's preview scroll state.

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
  }, [scrollCacheKey, renderedContent])

  const moveToMatch = useCallback((direction: 1 | -1) => {
    if (matchesRef.current.length === 0) {
      return
    }
    setActiveMatchIndex((cur) => {
      const base = cur >= 0 ? cur : direction === 1 ? -1 : 0
      return (base + direction + matchesRef.current.length) % matchesRef.current.length
    })
  }, [])

  const openSearch = useCallback(() => {
    if (isSearchOpen) {
      // Why: same-value setState is a no-op so the focus effect won't re-fire.
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      setIsSearchOpen(true)
    }
  }, [isSearchOpen])

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false)
    setQuery('')
    setActiveMatchIndex(-1)
  }, [])

  const scrollToAnchor = useCallback((rawAnchor: string): boolean => {
    const container = rootRef.current
    const body = bodyRef.current
    if (!container || !body) {
      return false
    }

    const decodedAnchor = decodeURIComponent(rawAnchor)
    let target: HTMLElement | null = null
    for (const candidate of body.querySelectorAll<HTMLElement>('[id]')) {
      if (candidate.id === decodedAnchor) {
        target = candidate
        break
      }
    }
    if (!target) {
      return false
    }

    const targetTop = target.offsetTop
    container.scrollTo({ top: Math.max(0, targetTop - 12) })
    target.focus({ preventScroll: true })
    return true
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
    setActiveMatchIndex((cur) =>
      matches.length === 0 ? -1 : cur >= 0 && cur < matches.length ? cur : 0
    )

    return () => clearMarkdownPreviewSearchHighlights(body)
  }, [renderedContent, isSearchOpen, query])

  useEffect(() => {
    setActiveMarkdownPreviewSearchMatch(matchesRef.current, activeMatchIndex)
  }, [activeMatchIndex, matchCount])

  useLayoutEffect(() => {
    if (!initialAnchor || initialAnchor === lastAppliedInitialAnchorRef.current) {
      return
    }

    let frameId = 0
    let attempts = 0

    const tryRevealAnchor = (): void => {
      if (scrollToAnchor(initialAnchor)) {
        lastAppliedInitialAnchorRef.current = initialAnchor
        return
      }

      attempts += 1
      if (attempts < 30) {
        frameId = window.requestAnimationFrame(tryRevealAnchor)
      }
    }

    tryRevealAnchor()
    return () => window.cancelAnimationFrame(frameId)
  }, [content, initialAnchor, scrollToAnchor])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root) {
        return
      }

      const target = event.target
      const targetInsidePreview = target instanceof Node && root.contains(target)

      if (
        isMarkdownPreviewFindShortcut(event, navigator.userAgent.includes('Mac')) &&
        targetInsidePreview
      ) {
        event.preventDefault()
        event.stopPropagation()
        openSearch()
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
  }, [closeSearch, isSearchOpen, openSearch])

  const components: Components = useMemo(() => {
    sluggerRef.current.reset()
    const slugger = sluggerRef.current
    return {
      a: ({ href, children, ...props }) => {
        const handleClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
          if (!href) {
            return
          }

          event.preventDefault()

          if (href.startsWith('#')) {
            void scrollToAnchor(href.slice(1))
            return
          }

          // Why: Cmd/Ctrl+Shift-click is the OS escape hatch — always hand the
          // link to the system default handler, bypassing the classifier. For a
          // dangling in-worktree .md, pre-check existence so the user sees a
          // toast instead of the silent no-op from shell.openFileUri.
          const modKey = isMac ? event.metaKey : event.ctrlKey
          if (modKey && event.shiftKey) {
            const osTarget = getMarkdownPreviewLinkTarget(href, filePath)
            if (!osTarget) {
              return
            }
            let parsed: URL
            try {
              parsed = new URL(osTarget)
            } catch {
              return
            }
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
              openHttpLink(parsed.toString(), { forceSystemBrowser: true })
              return
            }
            if (parsed.protocol === 'file:') {
              const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
              if (classified?.kind === 'markdown') {
                // Why: use the classifier's stripped absolutePath (no `:line:col`
                // or `#L10` suffix) so the OS handler receives a clean file URI.
                const cleanUri = absolutePathToFileUri(classified.absolutePath)
                void window.api.shell.pathExists(classified.absolutePath).then((exists) => {
                  if (!exists) {
                    toast.error(`File not found: ${classified.relativePath}`)
                    return
                  }
                  void window.api.shell.openFileUri(cleanUri)
                })
                return
              }
              void window.api.shell.openFileUri(parsed.toString())
            }
            return
          }

          const target = resolveMarkdownPreviewHref(href, filePath)
          if (!target) {
            return
          }

          if (target.protocol === 'http:' || target.protocol === 'https:') {
            void window.api.shell.openUrl(target.toString())
            return
          }

          if (target.protocol !== 'file:') {
            return
          }

          const absolutePath = fileUrlToAbsolutePath(target)
          if (!absolutePath) {
            return
          }

          if (absolutePath === filePath && target.hash) {
            void scrollToAnchor(target.hash.slice(1))
            return
          }

          const targetWorktree = findWorktreeForMarkdownPreviewPath(worktreesByRepo, absolutePath)
          if (!targetWorktree) {
            void window.api.shell.openFileUri(target.toString())
            return
          }

          const relativePath = absolutePath.slice(targetWorktree.path.length + 1)
          const language = detectLanguage(absolutePath)

          // Why: line-target fragments like #L10 or #L10C5 should open the
          // source editor and reveal the line, not open a preview tab that
          // treats "L10" as a heading anchor.
          const lineTarget = parseLineTarget(target.hash)
          if (language === 'markdown' && lineTarget) {
            const fileId = absolutePath
            setMarkdownViewMode(fileId, 'source')
            openFile({
              filePath: absolutePath,
              relativePath,
              worktreeId: targetWorktree.id,
              language,
              mode: 'edit'
            })
            setPendingEditorReveal(null)
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                setPendingEditorReveal({
                  filePath: absolutePath,
                  line: lineTarget.line,
                  column: lineTarget.column ?? 1,
                  matchLength: 0
                })
              })
            })
            return
          }

          if (language === 'markdown') {
            openMarkdownPreview(
              {
                filePath: absolutePath,
                relativePath,
                worktreeId: targetWorktree.id,
                language
              },
              { anchor: target.hash ? target.hash.slice(1) : null }
            )
            return
          }

          openFile({
            filePath: absolutePath,
            relativePath,
            worktreeId: targetWorktree.id,
            language,
            mode: 'edit'
          })
        }

        return (
          <a {...props} href={href} onClick={handleClick} style={{ cursor: 'pointer' }}>
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
      },
      h1: ({ children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return (
          <h1 {...props} id={id} tabIndex={-1}>
            {children}
          </h1>
        )
      },
      h2: ({ children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return (
          <h2 {...props} id={id} tabIndex={-1}>
            {children}
          </h2>
        )
      },
      h3: ({ children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return (
          <h3 {...props} id={id} tabIndex={-1}>
            {children}
          </h3>
        )
      },
      h4: ({ children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return (
          <h4 {...props} id={id} tabIndex={-1}>
            {children}
          </h4>
        )
      },
      h5: ({ children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return (
          <h5 {...props} id={id} tabIndex={-1}>
            {children}
          </h5>
        )
      },
      h6: ({ children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return (
          <h6 {...props} id={id} tabIndex={-1}>
            {children}
          </h6>
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the `img` override calls useLocalImageSrc
    // which is a hook, so react-markdown must see a stable component identity. The deps listed here
    // cover every value the overrides actually close over; slugger is a ref.
  }, [
    filePath,
    isDark,
    isMac,
    openFile,
    openMarkdownPreview,
    scrollToAnchor,
    setMarkdownViewMode,
    setPendingEditorReveal,
    worktreeRoot,
    worktreesByRepo
  ])

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
          remarkPlugins={[remarkGfm, remarkBreaks, remarkFrontmatter, remarkMath]}
          // Why: raw HTML must be sanitized before any trusted renderer expands
          // it into richer DOM. Running KaTeX and syntax highlighting after
          // sanitize preserves VS Code-style math/code rendering without having
          // to whitelist KaTeX's generated markup in the user-content schema.
          rehypePlugins={[
            rehypeRaw,
            [rehypeSanitize, markdownPreviewSanitizeSchema],
            rehypeSlug,
            rehypeHighlight,
            rehypeKatex
          ]}
        >
          {renderedContent}
        </Markdown>
      </div>
    </div>
  )
}
