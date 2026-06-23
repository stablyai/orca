import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { resolveImageAbsolutePath } from './markdown-preview-links'
import { getLocalImageCacheKey, loadLocalImageAbsolutePath } from './useLocalImageSrc'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'

export const MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_LIMIT = 64
export const MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_CONCURRENCY = 4

type MarkdownImageRuntimeContext = Omit<RuntimeFileOperationArgs, 'connectionId'> & {
  connectionId?: string | null
}

export type MarkdownPreviewLocalImageCandidate = {
  absolutePath: string
  cacheKey: string
  rawSrc: string
}

type MarkdownImageAstNode = {
  children?: MarkdownImageAstNode[]
  identifier?: string
  label?: string
  type?: string
  url?: string
}

type ExtractLocalImageCandidatesOptions = {
  connectionId?: string | null
  limit?: number
  runtimeContext?: MarkdownImageRuntimeContext
}

type PrewarmMarkdownPreviewLocalImagesOptions = ExtractLocalImageCandidatesOptions & {
  concurrency?: number
  loadImage?: (candidate: MarkdownPreviewLocalImageCandidate) => Promise<unknown>
}

export type MarkdownPreviewLocalImagePrewarm = {
  cancel: () => void
  done: Promise<void>
}

function normalizeReferenceIdentifier(identifier: string): string {
  return identifier.trim().replace(/\s+/g, ' ').toLowerCase()
}

function collectImageDefinitions(
  node: MarkdownImageAstNode,
  definitions: Map<string, string>
): void {
  if (
    node.type === 'definition' &&
    typeof node.identifier === 'string' &&
    typeof node.url === 'string'
  ) {
    definitions.set(normalizeReferenceIdentifier(node.identifier), node.url)
  }
  for (const child of node.children ?? []) {
    collectImageDefinitions(child, definitions)
  }
}

export function extractMarkdownPreviewLocalImageCandidates(
  markdown: string,
  filePath: string,
  options: ExtractLocalImageCandidatesOptions = {}
): MarkdownPreviewLocalImageCandidate[] {
  const limit = Math.max(0, options.limit ?? MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_LIMIT)
  if (limit === 0) {
    return []
  }

  // Why: parser extraction matches rendered Markdown image/reference/table
  // nodes without scanning raw text or accidentally prewarming HTML <img> tags.
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .parse(markdown) as MarkdownImageAstNode
  const definitions = new Map<string, string>()
  const candidates: MarkdownPreviewLocalImageCandidate[] = []
  const seenCacheKeys = new Set<string>()

  collectImageDefinitions(tree, definitions)

  function appendRawSrc(rawSrc: string): void {
    if (candidates.length >= limit) {
      return
    }
    const absolutePath = resolveImageAbsolutePath(rawSrc, filePath)
    if (!absolutePath) {
      return
    }
    const cacheKey = getLocalImageCacheKey(
      absolutePath,
      options.connectionId,
      options.runtimeContext
    )
    if (seenCacheKeys.has(cacheKey)) {
      return
    }
    seenCacheKeys.add(cacheKey)
    candidates.push({ absolutePath, cacheKey, rawSrc })
  }

  function visit(node: MarkdownImageAstNode): void {
    if (candidates.length >= limit) {
      return
    }
    if (node.type === 'image' && typeof node.url === 'string') {
      appendRawSrc(node.url)
    } else if (node.type === 'imageReference' && typeof node.identifier === 'string') {
      const rawSrc = definitions.get(normalizeReferenceIdentifier(node.identifier))
      if (rawSrc) {
        appendRawSrc(rawSrc)
      }
    }
    for (const child of node.children ?? []) {
      visit(child)
    }
  }

  visit(tree)
  return candidates
}

export function prewarmMarkdownPreviewLocalImages(
  markdown: string,
  filePath: string,
  options: PrewarmMarkdownPreviewLocalImagesOptions = {}
): MarkdownPreviewLocalImagePrewarm {
  const candidates = extractMarkdownPreviewLocalImageCandidates(markdown, filePath, options)
  const concurrency = Math.max(
    1,
    options.concurrency ?? MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_CONCURRENCY
  )
  const loadImage =
    options.loadImage ??
    ((candidate: MarkdownPreviewLocalImageCandidate) =>
      loadLocalImageAbsolutePath(
        candidate.absolutePath,
        options.connectionId,
        options.runtimeContext
      ))
  let cancelled = false
  let nextIndex = 0
  let activeCount = 0
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const settleIfFinished = (): void => {
    if ((cancelled || nextIndex >= candidates.length) && activeCount === 0) {
      resolveDone()
    }
  }

  const scheduleNext = (): void => {
    while (!cancelled && activeCount < concurrency && nextIndex < candidates.length) {
      const candidate = candidates[nextIndex]
      nextIndex += 1
      if (!candidate) {
        continue
      }
      activeCount += 1
      let loadPromise: Promise<unknown>
      try {
        loadPromise = loadImage(candidate)
      } catch {
        loadPromise = Promise.resolve()
      }
      loadPromise
        .catch(() => undefined)
        .finally(() => {
          activeCount -= 1
          scheduleNext()
          settleIfFinished()
        })
    }
    settleIfFinished()
  }

  scheduleNext()

  return {
    cancel: () => {
      cancelled = true
      settleIfFinished()
    },
    done
  }
}
