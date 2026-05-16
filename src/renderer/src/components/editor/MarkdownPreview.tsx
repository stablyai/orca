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
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownLeft,
  MessageSquare,
  Plus,
  Send,
  X
} from 'lucide-react'
import type { Components } from 'react-markdown'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { getConnectionId } from '@/lib/connection-context'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { detectLanguage } from '@/lib/language-detect'
import type { DiffComment, MarkdownDocument, Worktree } from '../../../../shared/types'
import {
  fileUrlToAbsolutePath,
  getMarkdownPreviewLinkTarget,
  isMarkdownPreviewOpenModifier,
  resolveMarkdownPreviewHref
} from './markdown-preview-links'
import {
  createMarkdownDocumentIndex,
  parseMarkdownDocLinkHref,
  remarkMarkdownDocLinks,
  resolveMarkdownDocLink
} from './markdown-doc-links'
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
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { markdownPreviewUrlTransform } from './markdown-preview-url-transform'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { buildMarkdownTableOfContents } from './markdown-table-of-contents'
import { MarkdownTableOfContentsPanel } from './MarkdownTableOfContentsPanel'
import { getDiffCommentLineLabel, isMarkdownComment } from '@/lib/diff-comment-compat'
import { DiffCommentCard } from '../diff-comments/DiffCommentCard'
import {
  formatMarkdownReviewNotes,
  getMarkdownReviewExcerpt,
  sortMarkdownReviewNotes,
  type MarkdownReviewNote
} from '@/lib/markdown-review-notes'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'

type MarkdownPreviewProps = {
  content: string
  filePath: string
  scrollCacheKey: string
  initialAnchor?: string | null
  showTableOfContents?: boolean
  onCloseTableOfContents?: () => void
  markdownDocuments?: MarkdownDocument[]
  onOpenDocument?: (document: MarkdownDocument) => void | Promise<void>
  markdownAnnotationsEnabled?: boolean
}

type MarkdownPreviewPositionNode = {
  tagName?: string
  position?: {
    start?: { line?: number }
    end?: { line?: number }
  }
  children?: MarkdownPreviewPositionNode[]
}

function getMarkdownPreviewBlockRange(
  node: MarkdownPreviewPositionNode | undefined
): { startLine: number; endLine: number } | null {
  const startLine = node?.position?.start?.line
  const endLine = node?.position?.end?.line
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return null
  }
  if (typeof startLine !== 'number' || typeof endLine !== 'number' || startLine < 1) {
    return null
  }
  return { startLine, endLine: Math.max(startLine, endLine) }
}

function hasMarkdownPreviewNestedBlock(node: MarkdownPreviewPositionNode | undefined): boolean {
  const blockTags = new Set(['p', 'pre', 'table', 'blockquote', 'ul', 'ol'])
  return Boolean(node?.children?.some((child) => child.tagName && blockTags.has(child.tagName)))
}

const markdownPreviewSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'kbd', 'sub', 'sup', 'ins'],
  protocols: {
    ...defaultSchema.protocols,
    // Why: markdown preview owns file:// click routing and authorizes the
    // user-selected path before opening it in Orca. Sanitization must preserve
    // the target so the click handler can make that security decision.
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'file']
  },
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
  initialAnchor = null,
  showTableOfContents = false,
  onCloseTableOfContents,
  markdownDocuments = [],
  onOpenDocument,
  markdownAnnotationsEnabled = false
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
  const activateMarkdownLink = useAppStore((s) => s.activateMarkdownLink)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const allDiffComments = useAppStore((s): DiffComment[] | undefined => {
    const worktree = findWorktreeForMarkdownPreviewPath(s.worktreesByRepo, filePath)
    return worktree?.diffComments
  })
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const sourceRuntimeEnvironmentId = useAppStore(
    (s) => s.openFiles.find((file) => file.filePath === filePath)?.runtimeEnvironmentId
  )
  const sourceWorktree = findWorktreeForMarkdownPreviewPath(worktreesByRepo, filePath)
  const sourceConnectionId = sourceWorktree ? getConnectionId(sourceWorktree.id) : null
  const worktreeRoot = sourceWorktree?.path ?? null
  const sourceRelativePath = useMemo(() => {
    if (!sourceWorktree) {
      return null
    }
    const normalizedFilePath = normalizeMarkdownPreviewAbsolutePath(filePath)
    const normalizedRoot = normalizeMarkdownPreviewAbsolutePath(sourceWorktree.path)
    if (normalizedFilePath === normalizedRoot) {
      return ''
    }
    if (!normalizedFilePath.startsWith(`${normalizedRoot}/`)) {
      return null
    }
    return normalizedFilePath.slice(normalizedRoot.length + 1)
  }, [filePath, sourceWorktree])
  const markdownComments = useMemo(
    () =>
      (allDiffComments ?? []).filter(
        (comment) => comment.filePath === sourceRelativePath && isMarkdownComment(comment)
      ),
    [allDiffComments, sourceRelativePath]
  )
  const settings = useAppStore((s) => s.settings)
  const imageRuntimeContext = useMemo(
    () =>
      sourceWorktree
        ? {
            settings: settingsForRuntimeOwner(settings, sourceRuntimeEnvironmentId),
            worktreeId: sourceWorktree.id,
            worktreePath: sourceWorktree.path,
            connectionId: sourceConnectionId
          }
        : undefined,
    [settings, sourceConnectionId, sourceRuntimeEnvironmentId, sourceWorktree]
  )
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const editorFontSize = computeEditorFontSize(14, editorFontZoomLevel)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const renderedContent = usePreserveSectionDuringExternalEdit(content, bodyRef)

  const frontMatter = useMemo(() => extractFrontMatter(renderedContent), [renderedContent])
  const tableOfContentsItems = useMemo(
    () => buildMarkdownTableOfContents(renderedContent),
    [renderedContent]
  )
  const markdownDocumentIndex = useMemo(
    () => createMarkdownDocumentIndex(markdownDocuments),
    [markdownDocuments]
  )
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
  const [activeAnnotationBlockKey, setActiveAnnotationBlockKey] = useState<string | null>(null)
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false)
  const [reviewNotesCopied, setReviewNotesCopied] = useState(false)
  const [activeReviewCommentId, setActiveReviewCommentId] = useState<string | null>(null)
  const markdownReviewNotes = useMemo(
    () => sortMarkdownReviewNotes(markdownComments as MarkdownReviewNote[]),
    [markdownComments]
  )
  const markdownReviewPrompt = useMemo(
    () => formatMarkdownReviewNotes(markdownReviewNotes, renderedContent),
    [markdownReviewNotes, renderedContent]
  )
  const canShowReviewTools = Boolean(
    markdownAnnotationsEnabled && sourceWorktree && sourceRelativePath !== null
  )

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

  const navigateToTableOfContentsItem = useCallback(
    (id: string): void => {
      scrollToAnchor(id)
    },
    [scrollToAnchor]
  )

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

  const handleCopyMarkdownReviewNotes = useCallback(async (): Promise<void> => {
    if (markdownReviewNotes.length === 0) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(markdownReviewPrompt)
      setReviewNotesCopied(true)
    } catch {
      // Best-effort clipboard action; failures usually mean the window is not focused.
    }
  }, [markdownReviewNotes.length, markdownReviewPrompt])

  useEffect(() => {
    if (!reviewNotesCopied) {
      return
    }
    const timeout = window.setTimeout(() => setReviewNotesCopied(false), 1600)
    return () => window.clearTimeout(timeout)
  }, [reviewNotesCopied])

  const scrollToReviewNote = useCallback((comment: DiffComment): void => {
    setActiveReviewCommentId(comment.id)
    const root = rootRef.current
    if (!root) {
      return
    }
    const blocks = root.querySelectorAll<HTMLElement>('[data-source-line][data-source-end-line]')
    let target: HTMLElement | null = null
    for (const block of blocks) {
      const startLine = Number(block.dataset.sourceLine)
      const endLine = Number(block.dataset.sourceEndLine)
      if (startLine <= comment.lineNumber && comment.lineNumber <= endLine) {
        target = block
        break
      }
    }
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  const renderAnnotationControls = useCallback(
    (range: { startLine: number; endLine: number }, blockKey: string): React.ReactNode => {
      if (!sourceWorktree || sourceRelativePath === null) {
        return null
      }
      if (!markdownAnnotationsEnabled) {
        return null
      }
      const commentsForBlock = markdownComments.filter(
        (comment) => range.startLine <= comment.lineNumber && comment.lineNumber <= range.endLine
      )

      const handleSubmit = async (body: string): Promise<boolean> => {
        const result = await addDiffComment({
          worktreeId: sourceWorktree.id,
          filePath: sourceRelativePath,
          source: 'markdown',
          startLine: range.startLine === range.endLine ? undefined : range.startLine,
          lineNumber: range.endLine,
          body,
          side: 'modified'
        })
        if (result) {
          setActiveAnnotationBlockKey(null)
          return true
        }
        return false
      }

      return (
        <div className="markdown-annotation-controls">
          <button
            type="button"
            className="markdown-annotation-add"
            aria-label={`Add note on line ${range.startLine}`}
            title="Add note"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setActiveAnnotationBlockKey((current) => (current === blockKey ? null : blockKey))
            }}
          >
            <Plus className="size-3" />
          </button>
          {activeAnnotationBlockKey === blockKey ? (
            <MarkdownAnnotationComposer
              lineNumber={range.endLine}
              startLine={range.startLine === range.endLine ? undefined : range.startLine}
              onCancel={() => setActiveAnnotationBlockKey(null)}
              onSubmit={handleSubmit}
            />
          ) : null}
          {commentsForBlock.map((comment) => (
            <div
              key={comment.id}
              className={`markdown-annotation-card ${
                activeReviewCommentId === comment.id ? 'is-active' : ''
              }`.trim()}
            >
              <DiffCommentCard
                lineNumber={comment.lineNumber}
                startLine={comment.startLine}
                body={comment.body}
                onDelete={() => void deleteDiffComment(sourceWorktree.id, comment.id)}
                onSubmitEdit={(body) => updateDiffComment(sourceWorktree.id, comment.id, body)}
              />
            </div>
          ))}
        </div>
      )
    },
    [
      activeAnnotationBlockKey,
      activeReviewCommentId,
      addDiffComment,
      deleteDiffComment,
      markdownAnnotationsEnabled,
      markdownComments,
      sourceRelativePath,
      sourceWorktree,
      updateDiffComment
    ]
  )

  const wrapAnnotatedBlock = useCallback(
    (
      tagName: string,
      node: MarkdownPreviewPositionNode | undefined,
      rendered: React.ReactNode
    ): React.ReactNode => {
      const range = getMarkdownPreviewBlockRange(node)
      if (!range) {
        return rendered
      }
      const blockKey = `${tagName}:${range.startLine}-${range.endLine}`
      const controls = renderAnnotationControls(range, blockKey)
      if (!controls) {
        return rendered
      }
      return (
        <div
          className="markdown-annotation-block"
          data-source-line={range.startLine}
          data-source-end-line={range.endLine}
        >
          {rendered}
          {controls}
        </div>
      )
    },
    [renderAnnotationControls]
  )

  const components: Components = useMemo(() => {
    sluggerRef.current.reset()
    const slugger = sluggerRef.current
    return {
      a: ({ href, children, className, ...props }) => {
        const docLinkTarget = parseMarkdownDocLinkHref(href)
        if (docLinkTarget !== null) {
          const resolution = resolveMarkdownDocLink(docLinkTarget, markdownDocumentIndex)
          const resolvedDocument = resolution.status === 'resolved' ? resolution.document : null
          const title =
            resolution.status === 'ambiguous' ? 'Document link is ambiguous' : 'Document not found'

          const handleDocLinkClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
            event.preventDefault()
            if (resolvedDocument && onOpenDocument) {
              void onOpenDocument(resolvedDocument)
            }
          }

          return (
            <a
              {...props}
              href={href}
              className={`${className ?? ''} ${
                resolvedDocument ? 'markdown-doc-link' : 'markdown-doc-link-broken'
              }`.trim()}
              title={resolvedDocument ? undefined : title}
              onClick={handleDocLinkClick}
            >
              {children}
            </a>
          )
        }

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
              if (
                isLocalPathOpenBlocked(
                  settingsForRuntimeOwner(
                    useAppStore.getState().settings,
                    sourceRuntimeEnvironmentId
                  ),
                  { connectionId: sourceConnectionId }
                )
              ) {
                // Why: modifier-open delegates to the client OS. Server-local
                // file:// targets from remote runtime/SSH worktrees cannot be opened locally.
                showLocalPathOpenBlockedToast()
                return
              }
              const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
              if (
                classified?.kind === 'markdown' ||
                (classified?.kind === 'file' && classified.line !== undefined)
              ) {
                // Why: use the classifier's stripped absolutePath (no `:line:col`
                // or `#L10` suffix) so the OS handler receives a clean file URI.
                const cleanUri = absolutePathToFileUri(classified.absolutePath)
                void window.api.shell.pathExists(classified.absolutePath).then((exists) => {
                  if (!exists) {
                    toast.error(
                      `File not found: ${classified.relativePath ?? classified.absolutePath}`
                    )
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

          const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
          const classifiedFileTarget =
            classified?.kind === 'markdown' || classified?.kind === 'file' ? classified : null
          const absolutePath = classifiedFileTarget?.absolutePath ?? fileUrlToAbsolutePath(target)
          if (!absolutePath) {
            return
          }
          const lineTarget =
            classifiedFileTarget?.line !== undefined
              ? { line: classifiedFileTarget.line, column: classifiedFileTarget.column }
              : parseLineTarget(target.hash)

          if (absolutePath === filePath && target.hash && !lineTarget) {
            void scrollToAnchor(target.hash.slice(1))
            return
          }

          const targetWorktree = findWorktreeForMarkdownPreviewPath(worktreesByRepo, absolutePath)
          if (!targetWorktree) {
            if (sourceWorktree) {
              void activateMarkdownLink(href, {
                sourceFilePath: filePath,
                worktreeId: sourceWorktree.id,
                worktreeRoot: sourceWorktree.path,
                runtimeEnvironmentId: sourceRuntimeEnvironmentId
              })
              return
            }
            if (
              isLocalPathOpenBlocked(
                settingsForRuntimeOwner(
                  useAppStore.getState().settings,
                  sourceRuntimeEnvironmentId
                ),
                { connectionId: sourceConnectionId }
              )
            ) {
              // Why: without a workspace match, opening a file URI delegates to
              // the client OS. Remote runtime/SSH paths are not local files.
              showLocalPathOpenBlockedToast()
              return
            }
            void window.api.shell.openFileUri(target.toString())
            return
          }

          const relativePath = absolutePath.slice(targetWorktree.path.length + 1)
          const language = detectLanguage(absolutePath)

          // Why: line targets like #L10 and path.ts:10 should reveal in Monaco,
          // not open a preview tab or a literal path with the suffix included.
          if (lineTarget) {
            if (language === 'markdown') {
              setMarkdownViewMode(absolutePath, 'source')
            }
            openFile({
              filePath: absolutePath,
              relativePath,
              worktreeId: targetWorktree.id,
              runtimeEnvironmentId: sourceRuntimeEnvironmentId,
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
                runtimeEnvironmentId: sourceRuntimeEnvironmentId,
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
            runtimeEnvironmentId: sourceRuntimeEnvironmentId,
            language,
            mode: 'edit'
          })
        }

        return (
          <a
            {...props}
            href={href}
            className={className}
            onClick={handleClick}
            style={{ cursor: 'pointer' }}
          >
            {children}
          </a>
        )
      },
      img: function MarkdownImg({ src, alt, ...props }) {
        // eslint-disable-next-line react-hooks/rules-of-hooks -- react-markdown
        // instantiates component overrides as regular React components, so hooks
        // are valid here despite the lowercase function name.
        const resolvedSrc = useLocalImageSrc(src, filePath, undefined, imageRuntimeContext)
        const handleImageClick = (event: React.MouseEvent<HTMLImageElement>): void => {
          if (!isMarkdownPreviewOpenModifier(event, isMac)) {
            return
          }

          if (!src || !sourceWorktree) {
            return
          }

          event.preventDefault()
          event.stopPropagation()
          void activateMarkdownLink(src, {
            sourceFilePath: filePath,
            worktreeId: sourceWorktree.id,
            worktreeRoot: sourceWorktree.path,
            runtimeEnvironmentId: sourceRuntimeEnvironmentId
          })
        }

        // Why: display uses IPC-backed blob URLs, but Cmd/Ctrl-click should open
        // the original markdown target so local and SSH worktree images route
        // through the same editor path as normal file links.
        return <img {...props} src={resolvedSrc} alt={alt ?? ''} onClick={handleImageClick} />
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
      pre: ({ node, children, ...props }) => {
        const child = React.Children.toArray(children)[0]
        if (React.isValidElement(child) && child.type === MermaidBlock) {
          return <>{children}</>
        }
        return wrapAnnotatedBlock(
          'pre',
          node as MarkdownPreviewPositionNode,
          <CodeBlockCopyButton {...props}>{children}</CodeBlockCopyButton>
        )
      },
      p: ({ node, children, ...props }) =>
        wrapAnnotatedBlock('p', node as MarkdownPreviewPositionNode, <p {...props}>{children}</p>),
      blockquote: ({ node, children, ...props }) =>
        wrapAnnotatedBlock(
          'blockquote',
          node as MarkdownPreviewPositionNode,
          <blockquote {...props}>{children}</blockquote>
        ),
      table: ({ node, children, ...props }) =>
        wrapAnnotatedBlock(
          'table',
          node as MarkdownPreviewPositionNode,
          <table {...props}>{children}</table>
        ),
      li: ({ node, children, ...props }) => {
        const positionNode = node as MarkdownPreviewPositionNode
        const range = hasMarkdownPreviewNestedBlock(positionNode)
          ? null
          : getMarkdownPreviewBlockRange(positionNode)
        if (!range) {
          return <li {...props}>{children}</li>
        }
        const blockKey = `li:${range.startLine}-${range.endLine}`
        return (
          <li {...props} data-source-line={range.startLine} data-source-end-line={range.endLine}>
            {children}
            {renderAnnotationControls(range, blockKey)}
          </li>
        )
      },
      h1: ({ node, children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return wrapAnnotatedBlock(
          'h1',
          node as MarkdownPreviewPositionNode,
          <h1 {...props} id={id} tabIndex={-1}>
            {children}
          </h1>
        )
      },
      h2: ({ node, children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return wrapAnnotatedBlock(
          'h2',
          node as MarkdownPreviewPositionNode,
          <h2 {...props} id={id} tabIndex={-1}>
            {children}
          </h2>
        )
      },
      h3: ({ node, children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return wrapAnnotatedBlock(
          'h3',
          node as MarkdownPreviewPositionNode,
          <h3 {...props} id={id} tabIndex={-1}>
            {children}
          </h3>
        )
      },
      h4: ({ node, children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return wrapAnnotatedBlock(
          'h4',
          node as MarkdownPreviewPositionNode,
          <h4 {...props} id={id} tabIndex={-1}>
            {children}
          </h4>
        )
      },
      h5: ({ node, children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return wrapAnnotatedBlock(
          'h5',
          node as MarkdownPreviewPositionNode,
          <h5 {...props} id={id} tabIndex={-1}>
            {children}
          </h5>
        )
      },
      h6: ({ node, children, ...props }) => {
        const id = createMarkdownPreviewHeadingId(getMarkdownPreviewNodeText(children), slugger)
        return wrapAnnotatedBlock(
          'h6',
          node as MarkdownPreviewPositionNode,
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
    activateMarkdownLink,
    isDark,
    isMac,
    imageRuntimeContext,
    markdownDocumentIndex,
    onOpenDocument,
    openFile,
    openMarkdownPreview,
    renderAnnotationControls,
    scrollToAnchor,
    setMarkdownViewMode,
    setPendingEditorReveal,
    sourceConnectionId,
    sourceRuntimeEnvironmentId,
    sourceWorktree,
    worktreeRoot,
    worktreesByRepo,
    wrapAnnotatedBlock
  ])

  return (
    <div className="markdown-preview-shell">
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
        {canShowReviewTools ? (
          <div className="markdown-review-toolbar">
            <button
              type="button"
              className="markdown-review-toolbar-button"
              onClick={() => setReviewPanelOpen((open) => !open)}
              aria-expanded={reviewPanelOpen}
              title={reviewPanelOpen ? 'Hide review notes' : 'Show review notes'}
            >
              <MessageSquare className="size-3.5" />
              <span>Review notes</span>
              <span className="markdown-review-count">{markdownReviewNotes.length}</span>
            </button>
            <button
              type="button"
              className="markdown-review-icon-button"
              onClick={() => void handleCopyMarkdownReviewNotes()}
              disabled={markdownReviewNotes.length === 0}
              title="Copy notes for agent"
              aria-label="Copy notes for agent"
            >
              {reviewNotesCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
            {sourceWorktree ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="markdown-review-icon-button"
                    disabled={markdownReviewNotes.length === 0}
                    title="Send notes to a new agent"
                    aria-label="Send notes to a new agent"
                  >
                    <Send className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <QuickLaunchAgentMenuItems
                    worktreeId={sourceWorktree.id}
                    groupId={sourceWorktree.id}
                    onFocusTerminal={focusTerminalTabSurface}
                    prompt={markdownReviewPrompt}
                    launchSource="notes_send"
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
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
            // Why: react-markdown filters file:// after rehype-sanitize; preview
            // click handlers need the target so they can authorize and open it.
            urlTransform={markdownPreviewUrlTransform}
            remarkPlugins={[
              remarkGfm,
              remarkBreaks,
              remarkFrontmatter,
              remarkMath,
              remarkMarkdownDocLinks
            ]}
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
      {canShowReviewTools && reviewPanelOpen && sourceWorktree ? (
        <MarkdownReviewNotesPanel
          notes={markdownReviewNotes}
          content={renderedContent}
          activeId={activeReviewCommentId}
          copied={reviewNotesCopied}
          onClose={() => setReviewPanelOpen(false)}
          onCopy={() => void handleCopyMarkdownReviewNotes()}
          onSelect={scrollToReviewNote}
          onDelete={(id) => void deleteDiffComment(sourceWorktree.id, id)}
          onSubmitEdit={(id, body) => updateDiffComment(sourceWorktree.id, id, body)}
          prompt={markdownReviewPrompt}
          worktreeId={sourceWorktree.id}
        />
      ) : null}
      {showTableOfContents ? (
        <MarkdownTableOfContentsPanel
          items={tableOfContentsItems}
          onClose={onCloseTableOfContents ?? (() => {})}
          onNavigate={navigateToTableOfContentsItem}
        />
      ) : null}
    </div>
  )
}

function MarkdownReviewNotesPanel({
  notes,
  content,
  activeId,
  copied,
  onClose,
  onCopy,
  onSelect,
  onDelete,
  onSubmitEdit,
  prompt,
  worktreeId
}: {
  notes: MarkdownReviewNote[]
  content: string
  activeId: string | null
  copied: boolean
  onClose: () => void
  onCopy: () => void
  onSelect: (note: MarkdownReviewNote) => void
  onDelete: (id: string) => void
  onSubmitEdit: (id: string, body: string) => Promise<boolean>
  prompt: string
  worktreeId: string
}): React.JSX.Element {
  return (
    <aside className="markdown-review-panel">
      <div className="markdown-review-panel-header">
        <div className="markdown-review-panel-title">
          <MessageSquare className="size-3.5" />
          <span>Review notes</span>
          <span className="markdown-review-count">{notes.length}</span>
        </div>
        <div className="markdown-review-panel-actions">
          <button
            type="button"
            className="markdown-review-icon-button"
            onClick={onCopy}
            disabled={notes.length === 0}
            title="Copy notes for agent"
            aria-label="Copy notes for agent"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="markdown-review-icon-button"
                disabled={notes.length === 0}
                title="Send notes to a new agent"
                aria-label="Send notes to a new agent"
              >
                <Send className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <QuickLaunchAgentMenuItems
                worktreeId={worktreeId}
                groupId={worktreeId}
                onFocusTerminal={focusTerminalTabSurface}
                prompt={prompt}
                launchSource="notes_send"
              />
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            className="markdown-review-icon-button"
            onClick={onClose}
            title="Close notes"
            aria-label="Close notes"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="markdown-review-note-list scrollbar-sleek">
        {notes.length === 0 ? (
          <div className="markdown-review-empty">No review notes for this file.</div>
        ) : (
          notes.map((note) => (
            <div
              key={note.id}
              className={`markdown-review-note ${activeId === note.id ? 'is-active' : ''}`.trim()}
            >
              <button
                type="button"
                className="markdown-review-note-anchor"
                onClick={() => onSelect(note)}
              >
                <span className="markdown-review-note-line">
                  {getDiffCommentLineLabel(note, true)}
                </span>
                <span className="markdown-review-note-excerpt">
                  {getMarkdownReviewExcerpt(content, note).replace(/^> /gm, '') || 'No preview'}
                </span>
              </button>
              <DiffCommentCard
                lineNumber={note.lineNumber}
                startLine={note.startLine}
                body={note.body}
                onDelete={() => onDelete(note.id)}
                onSubmitEdit={(body) => onSubmitEdit(note.id, body)}
              />
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

function MarkdownAnnotationComposer({
  lineNumber,
  startLine,
  onCancel,
  onSubmit
}: {
  lineNumber: number
  startLine?: number
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const label =
    startLine !== undefined && startLine !== lineNumber
      ? `Lines ${startLine}-${lineNumber}`
      : `Line ${lineNumber}`
  const trimmed = body.trim()

  const submit = async (): Promise<void> => {
    if (submitting || !trimmed) {
      return
    }
    setSubmitting(true)
    try {
      const ok = await onSubmit(trimmed)
      if (ok) {
        setBody('')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="markdown-annotation-composer" onClick={(event) => event.stopPropagation()}>
      <div className="orca-diff-comment-popover-label">{label}</div>
      <textarea
        ref={textareaRef}
        className="orca-diff-comment-popover-textarea"
        placeholder="Add note for the AI"
        value={body}
        onChange={(event) => {
          setBody(event.target.value)
          const el = event.currentTarget
          el.style.height = 'auto'
          el.style.height = `${Math.min(el.scrollHeight, 240)}px`
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
        rows={3}
      />
      <div className="orca-diff-comment-popover-footer">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={submitting || !trimmed}>
          {submitting ? 'Saving…' : 'Add note'}
          {!submitting && <CornerDownLeft className="ml-1 size-3 opacity-70" />}
        </Button>
      </div>
    </div>
  )
}
