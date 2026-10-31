// @vitest-environment happy-dom
import { useLayoutEffect, useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DiffSection } from './diff-section-types'
import type { GitHubPRFileContents } from '../../../../shared/github/pull-request-types'
import { useDiffSectionHeights } from './diff-section-height-cache'
import { usePRFileSectionLoader } from '../pull-request-page/files/section-loader'
import {
  loadPRFilesCombinedDiffSection,
  retryPRFilesCombinedDiffSection
} from '../github-item-dialog/inspect-pull-request/pr-files-combined-diff-load'

const network = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../pull-request-page/cache/file-content', () => ({
  loadPRFileContents: network.load,
  evictPRFileContentRequest: vi.fn()
}))
vi.mock('../github-item-dialog/load-item-details/pr-file-content-cache', () => ({
  loadPRFileContents: network.load
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it.each(['page', 'inspect'] as const)(
  'retains the live %s file height while Retry replaces its native binding',
  async (host) => {
    let finish: (contents: GitHubPRFileContents) => void = () => {}
    network.load.mockReturnValue(
      new Promise<GitHubPRFileContents>((resolve) => {
        finish = resolve
      })
    )
    const initial: DiffSection = {
      key: 'file:a',
      path: 'a',
      status: 'modified',
      collapsed: false,
      loading: false,
      dirty: false,
      originalContent: 'before',
      modifiedContent: 'after',
      diffResult: null,
      largeDiffRenderLimit: null
    }
    const hook = renderHook(() => {
      const [sections, setSections] = useState([initial])
      const [heights, setSectionHeights] = useDiffSectionHeights('pr', sections)
      const sectionsRef = useRef(sections)
      useLayoutEffect(() => {
        sectionsRef.current = sections
      }, [sections])
      const loadedIndicesRef = useRef(new Set([0]))
      const loadingIndicesRef = useRef(new Set<number>())
      const generationRef = useRef(0)
      const args = {
        sectionsRef,
        loadedIndicesRef,
        loadingIndicesRef,
        generationRef,
        fileByPath: new Map([
          [
            'a',
            { path: 'a', status: 'modified' as const, additions: 1, deletions: 1, isBinary: false }
          ]
        ]),
        repoPath: '/repo',
        repoId: 'repo',
        prNumber: 1,
        headSha: 'head',
        baseSha: 'base',
        setSections,
        setSectionHeights
      }
      const page = usePRFileSectionLoader(args)
      const retry = () =>
        host === 'page'
          ? page.retrySection(0)
          : retryPRFilesCombinedDiffSection({
              ...args,
              index: 0,
              loadSection: (index) => loadPRFilesCombinedDiffSection({ ...args, index })
            })
      return { heights, setSectionHeights, sections, retry }
    })
    act(() => hook.result.current.setSectionHeights({ 0: 20021 }))
    act(() => hook.result.current.retry())
    expect(hook.result.current.sections[0]?.loading).toBe(true)
    expect(hook.result.current.sections[0]?.contentGeneration).toBe(1)
    expect(hook.result.current.heights).toEqual({ 0: 20021 })
    await act(async () => {
      finish({
        original: 'before',
        modified: 'after changed',
        originalIsBinary: false,
        modifiedIsBinary: false
      })
    })
    expect(hook.result.current.sections[0]?.loading).toBe(false)
    expect(hook.result.current.heights).toEqual({ 0: 20021 })
    act(() => hook.result.current.setSectionHeights({ 0: 20221 }))
    expect(hook.result.current.heights).toEqual({ 0: 20221 })
  }
)
