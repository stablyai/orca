import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { selectMarkdownDocumentWorktreePath } from './markdown-document-worktree-path-selector'

const PANEL_COUNT = 200
const UPDATE_COUNT = 200
const WORKTREE_COUNT = 100
const ACTIVE_ID = `worktree-${WORKTREE_COUNT - 1}`

type CountedFixture = {
  readCount: () => number
  replaceBackgroundWorktree: (worktrees: Worktree[], update: number) => Worktree[]
  resetReadCount: () => void
  worktrees: Worktree[]
}

function createCountedFixture(): CountedFixture {
  let reads = 0
  const makeWorktree = (index: number): Worktree => {
    const worktree = {
      path: `/worktrees/${index}`
    } as Worktree
    Object.defineProperty(worktree, 'id', {
      enumerable: true,
      get: () => {
        reads += 1
        return `worktree-${index}`
      }
    })
    return worktree
  }
  return {
    readCount: () => reads,
    replaceBackgroundWorktree: (worktrees, update) => {
      const next = [...worktrees]
      const index = update % (WORKTREE_COUNT - 1)
      next[index] = makeWorktree(index)
      return next
    },
    resetReadCount: () => {
      reads = 0
    },
    worktrees: Array.from({ length: WORKTREE_COUNT }, (_, index) => makeWorktree(index))
  }
}

describe('Markdown document worktree path selector', () => {
  it('keeps mounted editors stable across worktree metadata replacements', () => {
    const wholeMapFixture = createCountedFixture()
    let wholeMap = { repo: wholeMapFixture.worktrees }
    let wholeMapInvalidations = 0
    wholeMapFixture.resetReadCount()

    for (let update = 0; update < UPDATE_COUNT; update += 1) {
      const previousMap = wholeMap
      wholeMap = {
        repo: wholeMapFixture.replaceBackgroundWorktree(wholeMap.repo, update)
      }
      for (let panel = 0; panel < PANEL_COUNT; panel += 1) {
        wholeMapInvalidations += Number(previousMap !== wholeMap)
        expect(findWorktreeById(wholeMap, ACTIVE_ID)?.path).toBe(`/worktrees/${WORKTREE_COUNT - 1}`)
      }
    }

    const scopedFixture = createCountedFixture()
    let scopedMap = { repo: scopedFixture.worktrees }
    const selectedPaths = Array.from({ length: PANEL_COUNT }, () =>
      selectMarkdownDocumentWorktreePath({ worktreesByRepo: scopedMap }, ACTIVE_ID)
    )
    let scopedInvalidations = 0
    scopedFixture.resetReadCount()

    for (let update = 0; update < UPDATE_COUNT; update += 1) {
      scopedMap = {
        repo: scopedFixture.replaceBackgroundWorktree(scopedMap.repo, update)
      }
      for (let panel = 0; panel < PANEL_COUNT; panel += 1) {
        const nextPath = selectMarkdownDocumentWorktreePath(
          { worktreesByRepo: scopedMap },
          ACTIVE_ID
        )
        scopedInvalidations += Number(selectedPaths[panel] !== nextPath)
        selectedPaths[panel] = nextPath
      }
    }

    expect(wholeMapInvalidations).toBe(40_000)
    expect(scopedInvalidations).toBe(0)
    expect(wholeMapFixture.readCount()).toBe(4_000_000)
    expect(scopedFixture.readCount()).toBe(20_000)
  })

  it('publishes path replacements and handles an absent worktree', () => {
    const first = { id: 'active', path: '/worktrees/first' } as Worktree
    const next = { id: 'active', path: '/worktrees/next' } as Worktree

    expect(
      selectMarkdownDocumentWorktreePath({ worktreesByRepo: { repo: [first] } }, 'active')
    ).toBe('/worktrees/first')
    expect(
      selectMarkdownDocumentWorktreePath({ worktreesByRepo: { repo: [next] } }, 'active')
    ).toBe('/worktrees/next')
    expect(selectMarkdownDocumentWorktreePath({ worktreesByRepo: {} }, null)).toBeNull()
  })
})
