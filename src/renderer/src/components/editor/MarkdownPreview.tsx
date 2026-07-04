/* eslint-disable max-lines -- Why: MarkdownPreview owns rendering, link interception,
search, and viewport state for the preview surface in one place so markdown
behavior stays coherent across split panes and preview tabs. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: search match state is synchronized with DOM highlights inserted into the rendered markdown body. */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject
} from 'react'
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
import { extractFrontMatter } from './markdown-frontmatter'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownLeft,
  MessageSquare,
  Plus,
  X
} from 'lucide-react'
import type { Components } from 'react-markdown'
import { Button } from '@/components/ui/button'
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
  isMarkdownPreviewSystemBrowserModifier,
  resolveMarkdownPreviewHref,
  resolveMarkdownPreviewHttpOpenOptions
} from './markdown-preview-links'
import {
  createMarkdownDocumentIndex,
  getMarkdownDocLinkAnchor,
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
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { markdownPreviewUrlTransform } from './markdown-preview-url-transform'
import { prewarmMarkdownPreviewLocalImages } from './markdown-preview-local-images'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { statRuntimePath } from '@/runtime/runtime-file-client'
import { useMountedRef } from '@/hooks/useMountedRef'
import { selectMarkdownTableOfContents } from './markdown-toc-visibility-gate'
import { MarkdownTableOfContentsPanel } from './MarkdownTableOfContentsPanel'
import { isMarkdownComment } from '@/lib/diff-comment-compat'
import { DiffCommentCard } from '../diff-comments/DiffCommentCard'
import {
  formatMarkdownReviewCardQuote,
  formatMarkdownReviewNotes,
  getMarkdownReviewCardQuote,
  sortMarkdownReviewNotes,
  type MarkdownReviewNote
} from '@/lib/markdown-review-notes'
import { copyMarkdownReviewNotesForAgent } from '@/lib/markdown-review-note-copy'
import { NotesSendMenu, type NotesSendMenuScope } from './NotesSendMenu'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { dirname } from '@/lib/path'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { translate } from '@/i18n/i18n'

const EMPTY_MARKDOWN_DOCUMENTS: MarkdownDocument[] = []

type MarkdownPreviewProps = {
  content: string
  filePath: string
  sourceFileId?: string | null
  sourceWorktreeId?: string | null
  sourceRuntimeEnvironmentId?: string | null
  scrollCacheKey: string
  initialAnchor?: string | null
  showTableOfContents?: boolean
  onCloseTableOfContents?: () => void
  markdownDocuments?: MarkdownDocument[]
  onOpenDocument?: (
    document: MarkdownDocument,
    options?: { anchor?: string | null }
  ) => void | Promise<void>
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

type MarkdownPreviewSourceOpenFile = {
  id: string
  filePath: string
  relativePath: string
  worktreeId: string
  runtimeEnvironmentId?: string | null
  mode: string
  markdownPreviewSourceFileId?: string
}

function isMarkdownAnnotationNavigationClick(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return !target.closest(
    'a,button,input,textarea,select,summary,[contenteditable="true"],.markdown-annotation-controls'
  )
}

export function findMarkdownPreviewSourceOpenFile(
  openFiles: MarkdownPreviewSourceOpenFile[],
  params: {
    sourceFileId: string | null
    filePath: string
    sourceWorktreeId: string | null
    sourceRuntimeEnvironmentId: string | null | undefined
  }
): MarkdownPreviewSourceOpenFile | undefined {
  const ownerMatches = (file: MarkdownPreviewSourceOpenFile): boolean =>
    (!params.sourceWorktreeId || file.worktreeId === params.sourceWorktreeId) &&
    (params.sourceRuntimeEnvironmentId === undefined ||
      (file.runtimeEnvironmentId ?? null) === (params.sourceRuntimeEnvironmentId ?? null))

  if (params.sourceFileId) {
    const idMatch = openFiles.find((file) => file.id === params.sourceFileId && ownerMatches(file))
    return (
      idMatch ??
      openFiles.find(
        (file) =>
          file.mode === 'markdown-preview' &&
          file.filePath === params.filePath &&
          file.markdownPreviewSourceFileId === params.sourceFileId &&
          ownerMatches(file)
      ) ??
      openFiles.find((file) => file.id === params.sourceFileId)
    )
  }

  return openFiles.find((file) => file.filePath === params.filePath && ownerMatches(file))
}

export function findMarkdownPreviewOpenedEditFileId(
  openFiles: MarkdownPreviewSourceOpenFile[],
  activeFileIdByWorktree: Record<string, string | null>,
  params: { filePath: string; worktreeId: string }
): string {
  const activeFileId = activeFileIdByWorktree[params.worktreeId]
  const activeFile = openFiles.find(
    (file) =>
      file.id === activeFileId &&
      file.filePath === params.filePath &&
      file.worktreeId === params.worktreeId &&
      file.mode === 'edit'
  )
  if (activeFile) {
    return activeFile.id
  }
  return (
    openFiles.find(
      (file) =>
        file.filePath === params.filePath &&
        file.worktreeId === params.worktreeId &&
        file.mode === 'edit'
    )?.id ?? params.filePath
  )
}

export function getMarkdownPreviewAnchorScrollTop(
  container: Pick<HTMLElement, 'getBoundingClientRect' | 'scrollTop'>,
  target: Pick<HTMLElement, 'getBoundingClientRect'>
): number {
  const containerTop = container.getBoundingClientRect().top
  const targetTop = target.getBoundingClientRect().top
  return Math.max(0, targetTop - containerTop + container.scrollTop - 12)
}

function cancelMarkdownPreviewEditorRevealFrames(frameIds: MutableRefObject<number[]>): void {
  for (const frameId of frameIds.current) {
    cancelAnimationFrame(frameId)
  }
  frameIds.current = []
}

function clearMarkdownPreviewTimeout(timeoutRef: MutableRefObject<number | null>): void {
  if (timeoutRef.current === null) {
    return
  }
  window.clearTimeout(timeoutRef.current)
  timeoutRef.current = null
}

function requestMarkdownPreviewEditorRevealFrame(
  frameIds: MutableRefObject<number[]>,
  callback: FrameRequestCallback
): void {
  let completed = false
  let frameId: number | undefined
  frameId = requestAnimationFrame((timestamp) => {
    completed = true
    if (frameId !== undefined) {
      frameIds.current = frameIds.current.filter((pendingFrameId) => pendingFrameId !== frameId)
    }
    callback(timestamp)
  })
  if (!completed) {
    frameIds.current.push(frameId)
  }
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

function getMarkdownPreviewReactText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (!node || typeof node === 'boolean') {
    return ''
  }
  if (Array.isArray(node)) {
    return node.map(getMarkdownPreviewReactText).join(' ')
  }
  if (!React.isValidElement(node)) {
    return ''
  }
  const props = node.props as { alt?: unknown; children?: React.ReactNode }
  if (typeof props.alt === 'string' && props.alt.trim()) {
    return props.alt
  }
  return getMarkdownPreviewReactText(props.children)
}

function getMarkdownPreviewAnnotationQuote(node: React.ReactNode): string | undefined {
  return formatMarkdownReviewCardQuote(getMarkdownPreviewReactText(node))
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
    details: [
      ...(defaultSchema.attributes?.details ?? []),
      'open',
      ['className', 'orca-details'],
      ['dataOrcaToggle', 'heading-1']
    ],
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

export function decodeMarkdownPreviewAnchor(rawAnchor: string): string {
  try {
    return decodeURIComponent(rawAnchor)
  } catch {
    return rawAnchor
  }
}

function normalizeMarkdownPreviewAbsolutePath(absolutePath: string): string {
  return absolutePath.replaceAll('\\', '/')
}

function normalizeMarkdownPreviewRelativePath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').replace(/^\/+/, '')
}

function isMarkdownPreviewAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function formatMarkdownPreviewRootPath(rootPath: string): string {
  if (rootPath === '') {
    return '/'
  }
  if (/^[A-Za-z]:$/.test(rootPath)) {
    return `${rootPath}/`
  }
  return rootPath
}

export function deriveMarkdownPreviewSourceRoot(
  filePath: string,
  relativePath: string | null | undefined
): string {
  const normalizedFilePath = normalizeMarkdownPreviewAbsolutePath(filePath)
  const normalizedRelativePath =
    relativePath && !isMarkdownPreviewAbsolutePathLike(relativePath)
      ? normalizeMarkdownPreviewRelativePath(relativePath)
      : ''

  if (normalizedRelativePath) {
    const suffix = `/${normalizedRelativePath}`
    if (normalizedFilePath.endsWith(suffix)) {
      return formatMarkdownPreviewRootPath(normalizedFilePath.slice(0, -suffix.length))
    }
  }

  return formatMarkdownPreviewRootPath(normalizeMarkdownPreviewAbsolutePath(dirname(filePath)))
}

function findWorktreeForMarkdownPreviewPath(
  worktreesByRepo: Record<string, Worktree[]>,
  absolutePath: string
): Worktree | null {
  let bestMatch: Worktree | null = null
  let bestMatchLength = -1

  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (relativePathInsideRoot(worktree.path, absolutePath) !== null) {
        const normalizedWorktreePathLength = normalizeMarkdownPreviewAbsolutePath(
          worktree.path
        ).length
        if (normalizedWorktreePathLength > bestMatchLength) {
          bestMatch = worktree
          bestMatchLength = normalizedWorktreePathLength
        }
      }
    }
  }

  return bestMatch
}

export function resolveMarkdownPreviewSourceWorktree(
  worktreesByRepo: Record<string, Worktree[]>,
  sourceWorktreeId: string | null | undefined,
  filePath: string
): Worktree | null {
  const sourceWorktree = sourceWorktreeId
    ? (findWorktreeById(worktreesByRepo, sourceWorktreeId) ?? null)
    : null

  return sourceWorktree ?? findWorktreeForMarkdownPreviewPath(worktreesByRepo, filePath)
}

export function getMarkdownPreviewSourceRelativePath(
  filePath: string,
  sourceWorktreePath: string
): string | null {
  return relativePathInsideRoot(sourceWorktreePath, filePath)
}

export default function MarkdownPreview({
  content,
  filePath,
  sourceFileId = null,
  sourceWorktreeId = null,
  sourceRuntimeEnvironmentId = undefined,
  scrollCacheKey,
  initialAnchor = null,
  showTableOfContents = false,
  onCloseTableOfContents,
  markdownDocuments = EMPTY_MARKDOWN_DOCUMENTS,
  onOpenDocument,
  markdownAnnotationsEnabled = false
}: MarkdownPreviewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const setSearchInputElement = useCallback((input: HTMLInputElement | null) => {
    inputRef.current = input
    if (!input) {
      return
    }
    // Why: opening preview search should select the query once, while typing
    // and match-count updates must not keep re-selecting the field.
    input.focus()
    input.select()
  }, [])
  const matchesRef = useRef<HTMLElement[]>([])
  const lastAppliedInitialAnchorRef = useRef<string | null>(null)
  const pendingEditorRevealFrameIdsRef = useRef<number[]>([])
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1)
  const isMac = navigator.userAgent.includes('Mac')
  const openFile = useAppStore((s) => s.openFile)
  const activateMarkdownLink = useAppStore((s) => s.activateMarkdownLink)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const frontmatterVisibleByFile = useAppStore((s) => s.markdownFrontmatterVisible)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const clearDeliveredDiffComments = useAppStore((s) => s.clearDeliveredDiffComments)
  const keybindings = useAppStore((s) => s.keybindings)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const sourceOpenFile = useAppStore((s) =>
    findMarkdownPreviewSourceOpenFile(s.openFiles, {
      sourceFileId,
      filePath,
      sourceWorktreeId,
      sourceRuntimeEnvironmentId
    })
  )
  const resolvedSourceWorktreeId = sourceWorktreeId ?? sourceOpenFile?.worktreeId ?? null
  const resolvedSourceRuntimeEnvironmentId =
    sourceRuntimeEnvironmentId !== undefined
      ? sourceRuntimeEnvironmentId
      : sourceOpenFile?.runtimeEnvironmentId
  const sourceWorktree = resolveMarkdownPreviewSourceWorktree(
    worktreesByRepo,
    resolvedSourceWorktreeId,
    filePath
  )
  const allDiffComments = sourceWorktree?.diffComments
  const sourceRoutingWorktreeId = sourceWorktree?.id ?? resolvedSourceWorktreeId
  const sourceConnectionId = sourceRoutingWorktreeId
    ? (getConnectionId(sourceRoutingWorktreeId) ?? null)
    : null
  const worktreeRoot =
    sourceWorktree?.path ??
    (sourceRoutingWorktreeId
      ? deriveMarkdownPreviewSourceRoot(filePath, sourceOpenFile?.relativePath)
      : null)
  const sourceRelativePath = useMemo(() => {
    if (!sourceWorktree) {
      return null
    }
    return getMarkdownPreviewSourceRelativePath(filePath, sourceWorktree.path)
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
      sourceRoutingWorktreeId && worktreeRoot
        ? {
            settings: settingsForRuntimeOwner(settings, resolvedSourceRuntimeEnvironmentId),
            worktreeId: sourceRoutingWorktreeId,
            worktreePath: worktreeRoot,
            connectionId: sourceConnectionId
          }
        : undefined,
    [
      settings,
      sourceConnectionId,
      resolvedSourceRuntimeEnvironmentId,
      sourceRoutingWorktreeId,
      worktreeRoot
    ]
  )
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const editorFontSize = computeEditorFontSize(14, editorFontZoomLevel)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  // Why: forces .markdown-light on this container only (never the global theme).
  const lightPreview = !!settings?.markdownPreviewLightBackground
  const previewThemeClass = lightPreview || !isDark ? 'markdown-light' : 'markdown-dark'
  // Why: mermaid (and any future dark-aware preview children) must use light theme
  // when lightPreview forces the reading surface light, regardless of app theme.
  const effectiveIsDark = lightPreview ? false : isDark

  const renderedContent = usePreserveSectionDuringExternalEdit(content, bodyRef)

  useEffect(() => {
    const prewarm = prewarmMarkdownPreviewLocalImages(renderedContent, filePath, {
      runtimeContext: imageRuntimeContext
    })
    return prewarm.cancel
  }, [renderedContent, filePath, imageRuntimeContext])

  const frontMatter = useMemo(() => extractFrontMatter(renderedContent), [renderedContent])
  // Why: building the table of contents runs a full-document remark parse on
  // every content change, and the preview's content churns on streamed/external
  // file writes. The result is only used while the panel is open (closed by
  // default), so gate the parse on visibility; showTableOfContents in the deps
  // rebuilds the outline the moment it opens.
  const tableOfContentsItems = useMemo(
    () => selectMarkdownTableOfContents(showTableOfContents, renderedContent),
    [renderedContent, showTableOfContents]
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
  // Why: front matter is hidden by default (#4468) and controlled from the
  // markdown preview actions menu, keeping metadata out of the reading surface
  // unless the user explicitly asks for it.
  const toggleableSourceFileId: string | null = sourceFileId ?? null
  const frontmatterVisible = toggleableSourceFileId
    ? (frontmatterVisibleByFile[toggleableSourceFileId] ?? false)
    : true
  const [activeAnnotationBlockKey, setActiveAnnotationBlockKey] = useState<string | null>(null)
  const [reviewNotesCopied, setReviewNotesCopied] = useState(false)
  const [copiedReviewNoteId, setCopiedReviewNoteId] = useState<string | null>(null)
  const reviewNotesCopiedResetTimerRef = useRef<number | null>(null)
  const copiedReviewNoteResetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after the preview unmounts; skip copied
  // feedback instead of starting a reset timer on a stale preview.
  const reviewNotesCopyMountedRef = useRef(false)
  const [activeReviewCommentId, setActiveReviewCommentId] = useState<string | null>(null)
  const [attentionReviewCommentId, setAttentionReviewCommentId] = useState<string | null>(null)
  const attentionReviewCommentTimeoutRef = useRef<number | null>(null)
  const markdownReviewNotes = useMemo(
    () => sortMarkdownReviewNotes(markdownComments as MarkdownReviewNote[]),
    [markdownComments]
  )
  const unsentMarkdownReviewNotes = useMemo(
    () => markdownReviewNotes.filter((note) => !note.sentAt),
    [markdownReviewNotes]
  )
  const unsentMarkdownReviewPrompt = useMemo(
    () => formatMarkdownReviewNotes(unsentMarkdownReviewNotes, renderedContent),
    [renderedContent, unsentMarkdownReviewNotes]
  )
  const unsentMarkdownReviewScope = useMemo<NotesSendMenuScope<MarkdownReviewNote>[]>(
    () => [
      {
        id: 'all',
        label: translate('auto.components.editor.MarkdownPreview.ddf087d12e', 'All unsent notes'),
        notes: unsentMarkdownReviewNotes,
        prompt: unsentMarkdownReviewPrompt
      }
    ],
    [unsentMarkdownReviewNotes, unsentMarkdownReviewPrompt]
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

  const clearReviewNotesCopiedResetTimer = useCallback((): void => {
    if (reviewNotesCopiedResetTimerRef.current !== null) {
      window.clearTimeout(reviewNotesCopiedResetTimerRef.current)
      reviewNotesCopiedResetTimerRef.current = null
    }
  }, [])

  const clearCopiedReviewNoteResetTimer = useCallback((): void => {
    if (copiedReviewNoteResetTimerRef.current !== null) {
      window.clearTimeout(copiedReviewNoteResetTimerRef.current)
      copiedReviewNoteResetTimerRef.current = null
    }
  }, [])

  const cleanupPreviewSurfaceTimers = useCallback((): void => {
    // Why: reveal/copy timers are event-owned, but the final cancellation
    // belongs to the preview surface unmount.
    cancelMarkdownPreviewEditorRevealFrames(pendingEditorRevealFrameIdsRef)
    clearMarkdownPreviewTimeout(attentionReviewCommentTimeoutRef)
    clearReviewNotesCopiedResetTimer()
    clearCopiedReviewNoteResetTimer()
  }, [clearCopiedReviewNoteResetTimer, clearReviewNotesCopiedResetTimer])

  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node
      reviewNotesCopyMountedRef.current = node !== null
      if (node === null) {
        cleanupPreviewSurfaceTimers()
      }
    },
    [cleanupPreviewSurfaceTimers]
  )

  const scrollToAnchor = useCallback((rawAnchor: string): boolean => {
    const container = rootRef.current
    const body = bodyRef.current
    if (!container || !body) {
      return false
    }

    const decodedAnchor = decodeMarkdownPreviewAnchor(rawAnchor)
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

    container.scrollTo({ top: getMarkdownPreviewAnchorScrollTop(container, target) })
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
        isMarkdownPreviewFindShortcut(event, getShortcutPlatform(), keybindings) &&
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
  }, [closeSearch, isSearchOpen, keybindings, openSearch])

  const handleCopyMarkdownReviewNotes = useCallback(async (): Promise<void> => {
    if (markdownReviewNotes.length === 0) {
      return
    }
    try {
      const copied = await copyMarkdownReviewNotesForAgent({
        notes: markdownReviewNotes,
        content: renderedContent,
        writeClipboardText: window.api.ui.writeClipboardText
      })
      if (!copied || !reviewNotesCopyMountedRef.current) {
        return
      }
      clearReviewNotesCopiedResetTimer()
      setReviewNotesCopied(true)
      reviewNotesCopiedResetTimerRef.current = window.setTimeout(() => {
        reviewNotesCopiedResetTimerRef.current = null
        setReviewNotesCopied(false)
      }, 1600)
    } catch {
      // Best-effort clipboard action; failures usually mean the window is not focused.
    }
  }, [clearReviewNotesCopiedResetTimer, markdownReviewNotes, renderedContent])

  const handleCopyMarkdownReviewNote = useCallback(
    async (note: MarkdownReviewNote): Promise<void> => {
      try {
        const copied = await copyMarkdownReviewNotesForAgent({
          notes: [note],
          content: renderedContent,
          writeClipboardText: window.api.ui.writeClipboardText
        })
        if (!copied || !reviewNotesCopyMountedRef.current) {
          return
        }
        clearCopiedReviewNoteResetTimer()
        setCopiedReviewNoteId(note.id)
        copiedReviewNoteResetTimerRef.current = window.setTimeout(() => {
          copiedReviewNoteResetTimerRef.current = null
          setCopiedReviewNoteId(null)
        }, 1600)
      } catch {
        // Best-effort clipboard action; failures usually mean the window is not focused.
      }
    },
    [clearCopiedReviewNoteResetTimer, renderedContent]
  )

  const pulseRenderedMarkdownReviewNote = useCallback((commentId: string): void => {
    if (attentionReviewCommentTimeoutRef.current !== null) {
      window.clearTimeout(attentionReviewCommentTimeoutRef.current)
    }
    setAttentionReviewCommentId(null)
    window.requestAnimationFrame(() => {
      setAttentionReviewCommentId(commentId)
      attentionReviewCommentTimeoutRef.current = window.setTimeout(() => {
        setAttentionReviewCommentId(null)
        attentionReviewCommentTimeoutRef.current = null
      }, 900)
    })
  }, [])

  const findRenderedMarkdownReviewNoteCard = useCallback(
    (commentId: string): HTMLElement | null => {
      const root = rootRef.current
      if (!root) {
        return null
      }
      return (
        Array.from(root.querySelectorAll<HTMLElement>('[data-markdown-review-note-id]')).find(
          (candidate) => candidate.dataset.markdownReviewNoteId === commentId
        ) ?? null
      )
    },
    []
  )

  const scrollRenderedMarkdownReviewNoteIntoView = useCallback(
    (comment: DiffComment): void => {
      setActiveReviewCommentId(comment.id)
      pulseRenderedMarkdownReviewNote(comment.id)
      window.requestAnimationFrame(() => {
        findRenderedMarkdownReviewNoteCard(comment.id)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest'
        })
      })
    },
    [findRenderedMarkdownReviewNoteCard, pulseRenderedMarkdownReviewNote]
  )

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

  const getMarkdownCommentsForRange = useCallback(
    (range: { startLine: number; endLine: number }): DiffComment[] =>
      markdownComments.filter(
        (comment) => range.startLine <= comment.lineNumber && comment.lineNumber <= range.endLine
      ),
    [markdownComments]
  )

  const handleAnnotatedMarkdownBlockClick = useCallback(
    (range: { startLine: number; endLine: number }, event: React.MouseEvent<HTMLElement>): void => {
      if (!isMarkdownAnnotationNavigationClick(event.target)) {
        return
      }
      const commentsForBlock = getMarkdownCommentsForRange(range)
      const comment =
        commentsForBlock.find((candidate) => candidate.id !== activeReviewCommentId) ??
        commentsForBlock[0]
      if (!comment) {
        return
      }
      scrollRenderedMarkdownReviewNoteIntoView(comment)
    },
    [activeReviewCommentId, getMarkdownCommentsForRange, scrollRenderedMarkdownReviewNoteIntoView]
  )

  const renderAnnotationControls = useCallback(
    (
      range: { startLine: number; endLine: number },
      blockKey: string,
      annotationQuote?: string
    ): React.ReactNode => {
      if (!sourceWorktree || sourceRelativePath === null) {
        return null
      }
      if (!markdownAnnotationsEnabled) {
        return null
      }
      const commentsForBlock = getMarkdownCommentsForRange(range)

      const handleSubmit = async (body: string): Promise<boolean> => {
        const result = await addDiffComment({
          worktreeId: sourceWorktree.id,
          filePath: sourceRelativePath,
          source: 'markdown',
          startLine: range.startLine === range.endLine ? undefined : range.startLine,
          lineNumber: range.endLine,
          ...(annotationQuote ? { selectedText: annotationQuote } : {}),
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
            aria-label={translate('auto.components.editor.MarkdownPreview.13f94d760c', 'Add note')}
            title={translate('auto.components.editor.MarkdownPreview.13f94d760c', 'Add note')}
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
          <div className="markdown-annotation-note-stack">
            {commentsForBlock.map((comment) => (
              <div
                key={comment.id}
                data-markdown-review-note-id={comment.id}
                className={`markdown-annotation-card ${
                  activeReviewCommentId === comment.id ? 'is-active' : ''
                } ${attentionReviewCommentId === comment.id ? 'is-attention' : ''}`.trim()}
              >
                <DiffCommentCard
                  lineNumber={comment.lineNumber}
                  startLine={comment.startLine}
                  label={null}
                  quote={
                    formatMarkdownReviewCardQuote(comment.selectedText) ??
                    annotationQuote ??
                    getMarkdownReviewCardQuote(content, comment)
                  }
                  body={comment.body}
                  sentAt={comment.sentAt}
                  onDelete={() => void deleteDiffComment(sourceWorktree.id, comment.id)}
                  onSubmitEdit={(body) => updateDiffComment(sourceWorktree.id, comment.id, body)}
                  headerActions={
                    <>
                      <button
                        type="button"
                        className="orca-diff-comment-pill-btn"
                        title={
                          copiedReviewNoteId === comment.id
                            ? translate(
                                'auto.components.editor.MarkdownPreview.94b520a96a',
                                'Copied note'
                              )
                            : translate(
                                'auto.components.editor.MarkdownPreview.f961e94057',
                                'Copy note for agent'
                              )
                        }
                        aria-label={
                          copiedReviewNoteId === comment.id
                            ? translate(
                                'auto.components.editor.MarkdownPreview.94b520a96a',
                                'Copied note'
                              )
                            : translate(
                                'auto.components.editor.MarkdownPreview.f961e94057',
                                'Copy note for agent'
                              )
                        }
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void handleCopyMarkdownReviewNote(comment as MarkdownReviewNote)
                        }}
                      >
                        {copiedReviewNoteId === comment.id ? (
                          <Check className="size-3" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </button>
                      <MarkdownSingleNoteSendMenu
                        worktreeId={sourceWorktree.id}
                        filePath={filePath}
                        content={renderedContent}
                        note={comment as MarkdownReviewNote}
                        modeSlot="preview-inline"
                        onDelivered={(notes) =>
                          void clearDeliveredDiffComments(sourceWorktree.id, notes)
                        }
                      />
                    </>
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )
    },
    [
      activeAnnotationBlockKey,
      activeReviewCommentId,
      attentionReviewCommentId,
      addDiffComment,
      clearDeliveredDiffComments,
      copiedReviewNoteId,
      deleteDiffComment,
      filePath,
      getMarkdownCommentsForRange,
      handleCopyMarkdownReviewNote,
      markdownAnnotationsEnabled,
      content,
      renderedContent,
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
      const controls = renderAnnotationControls(
        range,
        blockKey,
        getMarkdownPreviewAnnotationQuote(rendered)
      )
      if (!controls) {
        return rendered
      }
      const hasReviewNotes = getMarkdownCommentsForRange(range).length > 0
      return (
        <div
          className={`markdown-annotation-block ${hasReviewNotes ? 'has-review-notes' : ''}`.trim()}
          data-source-line={range.startLine}
          data-source-end-line={range.endLine}
          onClick={(event) => handleAnnotatedMarkdownBlockClick(range, event)}
        >
          {rendered}
          {controls}
        </div>
      )
    },
    [getMarkdownCommentsForRange, handleAnnotatedMarkdownBlockClick, renderAnnotationControls]
  )

  const components: Components = useMemo(() => {
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
              void onOpenDocument(resolvedDocument, {
                anchor: getMarkdownDocLinkAnchor(docLinkTarget)
              })
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

        const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>): Promise<void> => {
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
          if (isMarkdownPreviewSystemBrowserModifier(event, isMac)) {
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
              openHttpLink(
                parsed.toString(),
                resolveMarkdownPreviewHttpOpenOptions(event, isMac, sourceRoutingWorktreeId)
              )
              return
            }
            if (parsed.protocol === 'file:') {
              if (
                isLocalPathOpenBlocked(
                  settingsForRuntimeOwner(
                    useAppStore.getState().settings,
                    resolvedSourceRuntimeEnvironmentId
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
                      translate(
                        'auto.components.editor.MarkdownPreview.6c043947ae',
                        'File not found: {{value0}}',
                        { value0: classified.relativePath ?? classified.absolutePath }
                      )
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
            // Why: route through openHttpLink (not raw shell.openUrl) so a plain
            // click honors the "open links in Orca" setting; openHttpLink keeps
            // remote runtimes on the system browser. (Cmd/Ctrl+Shift-click is
            // handled above; this path only sees non-escape-hatch clicks.)
            openHttpLink(
              target.toString(),
              resolveMarkdownPreviewHttpOpenOptions(event, isMac, sourceRoutingWorktreeId)
            )
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
            if (sourceRoutingWorktreeId && worktreeRoot) {
              // Why: floating markdown files are owned by a synthetic workspace,
              // so there may be no repo worktree even though Orca can stat/open
              // links relative to the source file root.
              void activateMarkdownLink(href, {
                sourceFilePath: filePath,
                worktreeId: sourceRoutingWorktreeId,
                worktreeRoot,
                runtimeEnvironmentId: resolvedSourceRuntimeEnvironmentId
              })
              return
            }
            if (
              isLocalPathOpenBlocked(
                settingsForRuntimeOwner(
                  useAppStore.getState().settings,
                  resolvedSourceRuntimeEnvironmentId
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
          try {
            const stats = await statRuntimePath(
              {
                settings: settingsForRuntimeOwner(
                  useAppStore.getState().settings,
                  resolvedSourceRuntimeEnvironmentId
                ),
                worktreeId: targetWorktree.id,
                worktreePath: targetWorktree.path,
                connectionId: getConnectionId(targetWorktree.id) ?? undefined
              },
              absolutePath
            )
            if (stats.isDirectory) {
              toast.error(
                translate(
                  'auto.components.editor.MarkdownPreview.759463a221',
                  'Cannot open directory: {{value0}}',
                  { value0: relativePath }
                )
              )
              return
            }
          } catch {
            toast.error(
              translate(
                'auto.components.editor.MarkdownPreview.6c043947ae',
                'File not found: {{value0}}',
                { value0: relativePath }
              )
            )
            return
          }

          // Why: line targets like #L10 and path.ts:10 should reveal in Monaco,
          // not open a preview tab or a literal path with the suffix included.
          if (lineTarget) {
            openFile({
              filePath: absolutePath,
              relativePath,
              worktreeId: targetWorktree.id,
              runtimeEnvironmentId: resolvedSourceRuntimeEnvironmentId,
              language,
              mode: 'edit'
            })
            const openedState = useAppStore.getState()
            const targetFileId = findMarkdownPreviewOpenedEditFileId(
              openedState.openFiles,
              openedState.activeFileIdByWorktree,
              { filePath: absolutePath, worktreeId: targetWorktree.id }
            )
            if (language === 'markdown') {
              setMarkdownViewMode(targetFileId, 'source')
            }
            cancelMarkdownPreviewEditorRevealFrames(pendingEditorRevealFrameIdsRef)
            setPendingEditorReveal(null)
            requestMarkdownPreviewEditorRevealFrame(pendingEditorRevealFrameIdsRef, () => {
              requestMarkdownPreviewEditorRevealFrame(pendingEditorRevealFrameIdsRef, () => {
                setPendingEditorReveal({
                  filePath: absolutePath,
                  fileId: targetFileId,
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
                runtimeEnvironmentId: resolvedSourceRuntimeEnvironmentId,
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
            runtimeEnvironmentId: resolvedSourceRuntimeEnvironmentId,
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

          if (!src || !sourceRoutingWorktreeId || !worktreeRoot) {
            return
          }

          event.preventDefault()
          event.stopPropagation()
          void activateMarkdownLink(src, {
            sourceFilePath: filePath,
            worktreeId: sourceRoutingWorktreeId,
            worktreeRoot,
            runtimeEnvironmentId: resolvedSourceRuntimeEnvironmentId
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
            <MermaidBlock
              content={String(children).trimEnd()}
              isDark={effectiveIsDark}
              htmlLabels={false}
            />
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
        const hasReviewNotes = getMarkdownCommentsForRange(range).length > 0
        return (
          <li {...props}>
            <div
              className={`markdown-annotation-list-block ${
                hasReviewNotes ? 'has-review-notes' : ''
              }`.trim()}
              data-source-line={range.startLine}
              data-source-end-line={range.endLine}
              onClick={(event) => handleAnnotatedMarkdownBlockClick(range, event)}
            >
              <span className="markdown-annotation-list-content">{children}</span>
              {renderAnnotationControls(
                range,
                blockKey,
                getMarkdownPreviewAnnotationQuote(children)
              )}
            </div>
          </li>
        )
      },
      h1: ({ node, children, ...props }) => {
        return wrapAnnotatedBlock(
          'h1',
          node as MarkdownPreviewPositionNode,
          <h1 {...props} tabIndex={-1}>
            {children}
          </h1>
        )
      },
      h2: ({ node, children, ...props }) => {
        return wrapAnnotatedBlock(
          'h2',
          node as MarkdownPreviewPositionNode,
          <h2 {...props} tabIndex={-1}>
            {children}
          </h2>
        )
      },
      h3: ({ node, children, ...props }) => {
        return wrapAnnotatedBlock(
          'h3',
          node as MarkdownPreviewPositionNode,
          <h3 {...props} tabIndex={-1}>
            {children}
          </h3>
        )
      },
      h4: ({ node, children, ...props }) => {
        return wrapAnnotatedBlock(
          'h4',
          node as MarkdownPreviewPositionNode,
          <h4 {...props} tabIndex={-1}>
            {children}
          </h4>
        )
      },
      h5: ({ node, children, ...props }) => {
        return wrapAnnotatedBlock(
          'h5',
          node as MarkdownPreviewPositionNode,
          <h5 {...props} tabIndex={-1}>
            {children}
          </h5>
        )
      },
      h6: ({ node, children, ...props }) => {
        return wrapAnnotatedBlock(
          'h6',
          node as MarkdownPreviewPositionNode,
          <h6 {...props} tabIndex={-1}>
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
    effectiveIsDark,
    isMac,
    imageRuntimeContext,
    getMarkdownCommentsForRange,
    handleAnnotatedMarkdownBlockClick,
    markdownDocumentIndex,
    onOpenDocument,
    openFile,
    openMarkdownPreview,
    renderAnnotationControls,
    scrollToAnchor,
    setMarkdownViewMode,
    setPendingEditorReveal,
    sourceConnectionId,
    resolvedSourceRuntimeEnvironmentId,
    sourceRoutingWorktreeId,
    worktreeRoot,
    worktreesByRepo,
    wrapAnnotatedBlock
  ])

  const lightSurfaceStyle = lightPreview ? { background: '#ffffff', color: '#24292f' } : undefined

  return (
    <div
      className={`markdown-preview-shell${lightPreview ? ' markdown-light' : ''}`}
      style={lightSurfaceStyle}
    >
      {showTableOfContents ? (
        <MarkdownTableOfContentsPanel
          items={tableOfContentsItems}
          onClose={onCloseTableOfContents ?? (() => {})}
          onNavigate={navigateToTableOfContentsItem}
        />
      ) : null}
      <div
        ref={setRootRef}
        tabIndex={0}
        style={{ fontSize: `${editorFontSize}px`, ...lightSurfaceStyle }}
        className={`markdown-preview h-full min-h-0 overflow-auto scrollbar-editor flex-1 ${previewThemeClass}`}
      >
        {isSearchOpen ? (
          <div className="markdown-preview-search" onKeyDown={(event) => event.stopPropagation()}>
            <div className="markdown-preview-search-field">
              <Input
                ref={setSearchInputElement}
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
                placeholder={translate(
                  'auto.components.editor.MarkdownPreview.517aea303b',
                  'Find in preview'
                )}
                className="markdown-preview-search-input h-7 !border-0 bg-transparent px-2 shadow-none focus-visible:!border-0 focus-visible:ring-0"
                aria-label={translate(
                  'auto.components.editor.MarkdownPreview.ec77985138',
                  'Find in markdown preview'
                )}
              />
            </div>
            <div className="markdown-preview-search-status">
              {query && matchCount === 0
                ? translate('auto.components.editor.MarkdownPreview.c5dc92cfe3', 'No results')
                : `${matchCount === 0 ? 0 : activeMatchIndex + 1}/${matchCount}`}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => moveToMatch(-1)}
              disabled={matchCount === 0}
              title={translate(
                'auto.components.editor.MarkdownPreview.1febd97f5c',
                'Previous match'
              )}
              aria-label={translate(
                'auto.components.editor.MarkdownPreview.1febd97f5c',
                'Previous match'
              )}
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
              title={translate('auto.components.editor.MarkdownPreview.b42c41bd0d', 'Next match')}
              aria-label={translate(
                'auto.components.editor.MarkdownPreview.b42c41bd0d',
                'Next match'
              )}
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
              title={translate('auto.components.editor.MarkdownPreview.12052c639c', 'Close search')}
              aria-label={translate(
                'auto.components.editor.MarkdownPreview.12052c639c',
                'Close search'
              )}
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
              onClick={() => {
                const firstNote = markdownReviewNotes[0]
                if (firstNote) {
                  scrollToReviewNote(firstNote)
                }
              }}
              disabled={markdownReviewNotes.length === 0}
              title={translate(
                'auto.components.editor.MarkdownPreview.0f9969a159',
                'Jump to first review note'
              )}
              aria-label={translate(
                'auto.components.editor.MarkdownPreview.0f9969a159',
                'Jump to first review note'
              )}
            >
              <MessageSquare className="size-3.5" />
              <span>
                {translate('auto.components.editor.MarkdownPreview.322afab6ff', 'Review notes')}
              </span>
              <span className="markdown-review-count">{markdownReviewNotes.length}</span>
            </button>
            <button
              type="button"
              className="markdown-review-icon-button"
              onClick={() => void handleCopyMarkdownReviewNotes()}
              disabled={markdownReviewNotes.length === 0}
              title={translate(
                'auto.components.editor.MarkdownPreview.bb629de58a',
                'Copy notes for agent'
              )}
              aria-label={translate(
                'auto.components.editor.MarkdownPreview.bb629de58a',
                'Copy notes for agent'
              )}
            >
              {reviewNotesCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
            {sourceWorktree ? (
              <NotesSendMenu
                worktreeId={sourceWorktree.id}
                groupId={sourceWorktree.id}
                modeIdParts={['markdown-notes', sourceWorktree.id, filePath, 'preview-toolbar']}
                scopes={unsentMarkdownReviewScope}
                triggerClassName="markdown-review-icon-button"
                onDelivered={(notes) => void clearDeliveredDiffComments(sourceWorktree.id, notes)}
              />
            ) : null}
          </div>
        ) : null}
        <div
          ref={bodyRef}
          className={`markdown-body${lightPreview ? ' markdown-light' : ''}`}
          style={lightSurfaceStyle}
        >
          {/* Why: remarkFrontmatter strips front matter from normal markdown
        output. When the user opts in from the preview actions menu, render the
        raw metadata as a compact read-only block above the document body. */}
          {frontMatter && frontmatterVisible ? (
            <div className="mb-4 rounded border border-border/60 bg-muted/40 px-3 py-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {translate('auto.components.editor.MarkdownPreview.2b2b31382c', 'Front Matter')}
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground font-mono scrollbar-editor">
                {frontMatterInner}
              </pre>
            </div>
          ) : null}
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
    </div>
  )
}

function MarkdownSingleNoteSendMenu({
  worktreeId,
  filePath,
  content,
  note,
  modeSlot,
  onDelivered
}: {
  worktreeId: string
  filePath: string
  content: string
  note: MarkdownReviewNote
  modeSlot: string
  onDelivered: (notes: readonly MarkdownReviewNote[]) => void
}): React.JSX.Element {
  return (
    <NotesSendMenu
      worktreeId={worktreeId}
      groupId={worktreeId}
      modeIdParts={['markdown-notes', worktreeId, filePath, modeSlot, note.id]}
      scopes={[
        {
          id: 'note',
          label: translate('auto.components.editor.MarkdownPreview.f37b98999e', 'This note'),
          notes: note.sentAt ? [] : [note],
          prompt: formatMarkdownReviewNotes([note], content)
        }
      ]}
      targetModeLabel="This note"
      triggerClassName="orca-diff-comment-pill-btn"
      disabledTooltip="Note already sent"
      onDelivered={onDelivered}
    />
  )
}

function MarkdownAnnotationComposer({
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
  const mountedRef = useMountedRef()

  const focusTextareaRef = useCallback((textarea: HTMLTextAreaElement | null): void => {
    // Why: opening an annotation composer should focus the draft field on the
    // mount edge; no external subscription is needed.
    textarea?.focus()
  }, [])

  const trimmed = body.trim()

  const submit = async (): Promise<void> => {
    if (submitting || !trimmed) {
      return
    }
    setSubmitting(true)
    try {
      const ok = await onSubmit(trimmed)
      if (!mountedRef.current) {
        return
      }
      if (ok) {
        setBody('')
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }

  return (
    <div className="markdown-annotation-composer" onClick={(event) => event.stopPropagation()}>
      <div className="orca-diff-comment-popover-label">
        {translate('auto.components.editor.MarkdownPreview.b1bfc04034', 'Selected text')}
      </div>
      <textarea
        ref={focusTextareaRef}
        className="orca-diff-comment-popover-textarea"
        placeholder={translate(
          'auto.components.editor.MarkdownPreview.d737791433',
          'Add note for the AI'
        )}
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
          {translate('auto.components.editor.MarkdownPreview.e4683f70c4', 'Cancel')}
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={submitting || !trimmed}>
          {submitting
            ? translate('auto.components.editor.MarkdownPreview.d652c87c91', 'Saving…')
            : translate('auto.components.editor.MarkdownPreview.13f94d760c', 'Add note')}
          {!submitting && <CornerDownLeft className="ml-1 size-3 opacity-70" />}
        </Button>
      </div>
    </div>
  )
}
