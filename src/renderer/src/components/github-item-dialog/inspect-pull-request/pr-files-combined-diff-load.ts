import type React from 'react'
import { toast } from 'sonner'
import type { DiffSection } from '@/components/editor/diff-section-types'
import { addPRReviewCommentForRepo } from '@/components/github/github-work-item-comment-mutations'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { removeDiffSectionMeasuredHeight } from '@/components/editor/diff-section-height-cache'
import {
  getStoredTextDiffContent,
  getStoredTextDiffResult
} from '@/components/editor/large-diff-section-content'
import {
  getPRFileContentsRenderLimit,
  getPRFileDiffResult
} from '@/components/github/pr-file-diff-mapping'
import type { GitDiffResult } from '../../../../../shared/git-diff-compare-types'
import type {
  GitHubOwnerRepo,
  GitHubPRFile,
  GitHubPRFileContents
} from '../../../../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { loadPRFileContents } from '../load-item-details/pr-file-content-cache'

type LoadSectionArgs = {
  index: number
  sectionsRef: { current: DiffSection[] }
  loadedIndicesRef: { current: Set<number> }
  loadingIndicesRef: { current: Set<number> }
  fileByPath: Map<string, GitHubPRFile>
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo?: GitHubOwnerRepo | null
  headSha: string | undefined
  baseSha: string | undefined
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
}

export function loadPRFilesCombinedDiffSection({
  index,
  sectionsRef,
  loadedIndicesRef,
  loadingIndicesRef,
  fileByPath,
  repoPath,
  repoId,
  sourceContext,
  prNumber,
  prRepo,
  headSha,
  baseSha,
  setSections
}: LoadSectionArgs): void {
  const section = sectionsRef.current[index]
  if (!section || section.collapsed) {
    return
  }
  if (loadedIndicesRef.current.has(index) || loadingIndicesRef.current.has(index)) {
    return
  }
  const file = fileByPath.get(section.path)
  if (!file) {
    return
  }
  loadingIndicesRef.current.add(index)

  const load = async (): Promise<{
    result: GitDiffResult
    resultContents?: GitHubPRFileContents
    error?: string
  }> => {
    if (file.isBinary) {
      return {
        result: {
          kind: 'binary',
          originalContent: '',
          modifiedContent: '',
          originalIsBinary: true,
          modifiedIsBinary: true
        }
      }
    }
    if (!headSha || !baseSha) {
      return {
        result: {
          kind: 'text',
          originalContent: '',
          modifiedContent: '',
          originalIsBinary: false,
          modifiedIsBinary: false
        },
        error: translate(
          'auto.components.GitHubItemDialog.829674460a',
          'Diff unavailable because the PR commit SHAs are missing.'
        )
      }
    }
    const contents = await loadPRFileContents({
      repoPath,
      repoId,
      sourceContext,
      prNumber,
      prRepo,
      file,
      headSha,
      baseSha
    })
    return { result: getPRFileDiffResult(contents), resultContents: contents }
  }

  load()
    .catch((error) => ({
      result: {
        kind: 'text',
        originalContent: '',
        modifiedContent: '',
        originalIsBinary: false,
        modifiedIsBinary: false
      } as GitDiffResult,
      resultContents: undefined,
      error:
        error instanceof Error
          ? error.message
          : translate('auto.components.GitHubItemDialog.d9fa90b625', 'Failed to load diff.')
    }))
    .then(({ result, resultContents, error }) => {
      loadingIndicesRef.current.delete(index)
      const largeDiffRenderLimit =
        !error && result.kind === 'text' && resultContents
          ? getPRFileContentsRenderLimit(resultContents)
          : null
      const storedContent = getStoredTextDiffContent(result, largeDiffRenderLimit)
      const storedResult = getStoredTextDiffResult(result, largeDiffRenderLimit)
      loadedIndicesRef.current.add(index)
      setSections((prev) =>
        prev.map((current, currentIndex) =>
          currentIndex === index
            ? {
                ...current,
                diffResult: storedResult,
                originalContent: storedContent.originalContent,
                modifiedContent: storedContent.modifiedContent,
                loading: false,
                error,
                largeDiffRenderLimit
              }
            : current
        )
      )
    })
}

export function retryPRFilesCombinedDiffSection({
  index,
  loadedIndicesRef,
  loadingIndicesRef,
  setSectionHeights,
  setSections,
  loadSection
}: {
  index: number
  loadedIndicesRef: { current: Set<number> }
  loadingIndicesRef: { current: Set<number> }
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  loadSection: (index: number) => void
}): void {
  loadedIndicesRef.current.delete(index)
  loadingIndicesRef.current.delete(index)
  setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, index))
  setSections((prev) =>
    prev.map((section, sectionIndex) =>
      sectionIndex === index
        ? {
            ...section,
            diffResult: null,
            originalContent: '',
            modifiedContent: '',
            loading: true,
            error: undefined,
            largeDiffRenderLimit: null
          }
        : section
    )
  )
  loadSection(index)
}

export function togglePRFilesCombinedDiffSection({
  index,
  sectionsRef,
  setSections,
  loadSection
}: {
  index: number
  sectionsRef: { current: DiffSection[] }
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  loadSection: (index: number) => void
}): void {
  const shouldLoadAfterExpand = sectionsRef.current[index]?.collapsed ?? false
  setSections((prev) =>
    prev.map((section, sectionIndex) =>
      sectionIndex === index ? { ...section, collapsed: !section.collapsed } : section
    )
  )
  if (shouldLoadAfterExpand) {
    window.requestAnimationFrame(() => loadSection(index))
  }
}

export function setAllPRFilesCombinedDiffSectionsCollapsed({
  collapsed,
  setSections,
  sectionsRef,
  loadSection
}: {
  collapsed: boolean
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  sectionsRef: { current: DiffSection[] }
  loadSection: (index: number) => void
}): void {
  setSections((prev) => prev.map((section) => ({ ...section, collapsed })))
  if (!collapsed) {
    window.requestAnimationFrame(() => {
      sectionsRef.current.forEach((_, index) => loadSection(index))
    })
  }
}

export async function addPRFilesCombinedDiffLineComment({
  section,
  lineNumber,
  startLine,
  body,
  headSha,
  repoPath,
  repoId,
  sourceContext,
  prNumber,
  prRepo,
  onCommentAdded
}: {
  section: DiffSection
  lineNumber: number
  startLine?: number
  body: string
  headSha: string | undefined
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo?: GitHubOwnerRepo | null
  onCommentAdded: (comment: PRComment) => void
}): Promise<boolean> {
  if (!headSha) {
    toast.error(
      translate(
        'auto.components.GitHubItemDialog.d1fa2cf888',
        'Unable to comment without the PR head SHA.'
      )
    )
    return false
  }
  const result = await addPRReviewCommentForRepo({
    repoPath,
    repoId,
    sourceContext,
    prNumber,
    prRepo,
    commitId: headSha,
    path: section.path,
    line: lineNumber,
    startLine,
    body
  })
  if (!result.ok) {
    toast.error(
      result.error ||
        translate('auto.components.GitHubItemDialog.b0b09778c8', 'Failed to add review comment.')
    )
    return false
  }
  onCommentAdded(result.comment)
  toast.success(translate('auto.components.GitHubItemDialog.a341343303', 'Review comment added.'))
  return true
}
