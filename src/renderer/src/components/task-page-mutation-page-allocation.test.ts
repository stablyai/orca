import { expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { patchTaskPageGitHubWorkItemPages } from './task-page-github-work-item-mutation-pages'

function item(id: string): GitHubWorkItem {
  return {
    id,
    type: 'issue',
    number: 1,
    title: id,
    state: 'open',
    url: '',
    labels: [],
    updatedAt: '',
    author: '',
    repoId: 'repo'
  }
}

it('avoids allocating copies of unaffected pages during an item mutation', () => {
  const pages = Array.from({ length: 20 }, (_, p) =>
    Array.from({ length: 200 }, (_, i) => item(`${p}:${i}`))
  )
  const inputs = new Set<unknown>([pages, ...pages])
  const map = Array.prototype.map
  const slice = Array.prototype.slice
  let allocations = 0
  Array.prototype.map = function <T, U>(
    this: T[],
    callback: (value: T, index: number, array: T[]) => U,
    thisArg?: unknown
  ): U[] {
    if (inputs.has(this)) {
      allocations++
    }
    return Reflect.apply(map, this, [callback, thisArg]) as U[]
  }
  Array.prototype.slice = function (this: unknown[], ...args: Parameters<typeof slice>) {
    if (inputs.has(this)) {
      allocations++
    }
    return slice.apply(this, args)
  }
  let result: ReturnType<typeof patchTaskPageGitHubWorkItemPages>
  let unchanged: ReturnType<typeof patchTaskPageGitHubWorkItemPages>
  try {
    unchanged = patchTaskPageGitHubWorkItemPages(
      pages,
      { id: 'missing', repoId: 'repo' },
      { title: 'New' }
    )
    result = patchTaskPageGitHubWorkItemPages(
      pages,
      { id: '19:199', repoId: 'repo' },
      { title: 'New' }
    )
  } finally {
    Array.prototype.map = map
    Array.prototype.slice = slice
  }
  expect(allocations).toBe(2)
  expect(unchanged).toBe(pages)
  expect(result[0]).toBe(pages[0])
  expect(result[19]?.[199].title).toBe('New')
  expect(pages[19][199].title).toBe('19:199')
})

it('preserves sparse pages, null pages, duplicate matches and predicate exclusions', () => {
  const page = [item('match'), item('match')]
  delete page[0]
  const pages = [page, null, [item('match'), item('match')]]
  const patched = patchTaskPageGitHubWorkItemPages(
    pages,
    { id: 'match', repoId: 'repo' },
    { title: 'new' },
    (row) => row !== pages[2]?.[0]
  )
  expect(0 in patched[0]!).toBe(false)
  expect(patched[1]).toBeNull()
  expect(patched[2]?.map((row) => row.title)).toEqual(['match', 'new'])
})
