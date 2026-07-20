// Why: Phase 3 — the tree builder joins rows on content.url (never
// content.number, which collides across repos in a multi-repo org Project)
// and must stay crash-free on self-references and mutual-parent cycles.
import { describe, expect, it } from 'vitest'
import type { GitHubProjectRow } from './github-project-types'
import { buildProjectRowTree, flattenProjectRowTree } from './github-project-hierarchy-tree'

function makeRow(
  id: string,
  position: number,
  options: {
    url?: string | null
    parentUrl?: string | null
    number?: number | null
  } = {}
): GitHubProjectRow {
  const { url = null, parentUrl = null, number = 1 } = options
  return {
    id,
    itemType: 'ISSUE',
    content: {
      number,
      title: id,
      body: null,
      url,
      state: 'open',
      stateReason: null,
      isDraft: null,
      repository: 'acme/repo',
      assignees: [],
      labels: [],
      parentIssue: parentUrl ? { number: 999, title: 'parent', url: parentUrl } : null,
      issueType: null,
      subIssuesSummary: null,
      trackedIssues: [],
      trackedInIssues: []
    },
    fieldValuesByFieldId: {},
    updatedAt: '2026-01-01T00:00:00Z',
    position
  }
}

const URL_A = 'https://github.com/acme/repo/issues/1'
const URL_B = 'https://github.com/acme/repo/issues/2'
const URL_C = 'https://github.com/acme/repo/issues/3'
const URL_OTHER_REPO = 'https://github.com/acme/other/issues/1'

describe('buildProjectRowTree', () => {
  it('returns a single depth-0 node with no children for a lone root', () => {
    const root = makeRow('root', 0, { url: URL_A })
    const tree = buildProjectRowTree([root])
    expect(tree).toHaveLength(1)
    expect(tree[0].row).toBe(root)
    expect(tree[0].depth).toBe(0)
    expect(tree[0].children).toEqual([])
  })

  it('nests a child at depth 1 under its parent when urls match', () => {
    const parent = makeRow('parent', 0, { url: URL_A })
    const child = makeRow('child', 1, { url: URL_B, parentUrl: URL_A })
    const tree = buildProjectRowTree([parent, child])
    expect(tree).toHaveLength(1)
    expect(tree[0].row).toBe(parent)
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].row).toBe(child)
    expect(tree[0].children[0].depth).toBe(1)
  })

  it('nests a three-row chain at depths 0, 1, 2', () => {
    const parent = makeRow('parent', 0, { url: URL_A })
    const child = makeRow('child', 1, { url: URL_B, parentUrl: URL_A })
    const grandchild = makeRow('grandchild', 2, { url: URL_C, parentUrl: URL_B })
    const tree = buildProjectRowTree([parent, child, grandchild])
    expect(tree).toHaveLength(1)
    expect(tree[0].depth).toBe(0)
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].depth).toBe(1)
    expect(tree[0].children[0].children).toHaveLength(1)
    expect(tree[0].children[0].children[0].row.id).toBe('grandchild')
    expect(tree[0].children[0].children[0].depth).toBe(2)
  })

  it('renders a child whose parent url is absent from the input as a depth-0 root', () => {
    const orphan = makeRow('orphan', 0, { url: URL_B, parentUrl: URL_A })
    const tree = buildProjectRowTree([orphan])
    expect(tree).toHaveLength(1)
    expect(tree[0].row).toBe(orphan)
    expect(tree[0].depth).toBe(0)
  })

  it('treats a row with parentIssue null as a root', () => {
    const row = makeRow('plain', 0, { url: URL_A })
    const tree = buildProjectRowTree([row])
    expect(tree).toHaveLength(1)
    expect(tree[0].depth).toBe(0)
  })

  it('treats a self-referential row as a root without looping', () => {
    const selfRef = makeRow('self', 0, { url: URL_A, parentUrl: URL_A })
    const tree = buildProjectRowTree([selfRef])
    expect(tree).toHaveLength(1)
    expect(tree[0].row).toBe(selfRef)
    expect(tree[0].depth).toBe(0)
    expect(tree[0].children).toEqual([])
  })

  it('silently drops mutually-parented rows instead of crashing', () => {
    const a = makeRow('a', 0, { url: URL_A, parentUrl: URL_B })
    const b = makeRow('b', 1, { url: URL_B, parentUrl: URL_A })
    expect(buildProjectRowTree([a, b])).toEqual([])
  })

  it('never joins rows on content.number — same number in different repos stays flat', () => {
    const first = makeRow('first', 0, { url: URL_A, number: 1 })
    const second = makeRow('second', 1, { url: URL_OTHER_REPO, number: 1 })
    const tree = buildProjectRowTree([first, second])
    expect(tree).toHaveLength(2)
    expect(tree[0].depth).toBe(0)
    expect(tree[1].depth).toBe(0)
    expect(tree[0].children).toEqual([])
    expect(tree[1].children).toEqual([])
  })

  it('preserves sibling input order without re-sorting', () => {
    const parent = makeRow('parent', 0, { url: URL_A })
    const childC = makeRow('C', 1, { url: `${URL_B}c`, parentUrl: URL_A })
    const childA = makeRow('A', 2, { url: `${URL_B}a`, parentUrl: URL_A })
    const childB = makeRow('B', 3, { url: `${URL_B}b`, parentUrl: URL_A })
    const tree = buildProjectRowTree([parent, childC, childA, childB])
    expect(tree[0].children.map((n) => n.row.id)).toEqual(['C', 'A', 'B'])
  })
})

describe('flattenProjectRowTree', () => {
  const parent = makeRow('parent', 0, { url: URL_A })
  const child = makeRow('child', 1, { url: URL_B, parentUrl: URL_A })
  const grandchild = makeRow('grandchild', 2, { url: URL_C, parentUrl: URL_B })
  const sibling = makeRow('sibling', 3, { url: URL_OTHER_REPO })

  it('returns a depth-first pre-order list with an empty collapsed set', () => {
    const tree = buildProjectRowTree([parent, child, grandchild, sibling])
    const flat = flattenProjectRowTree(tree, new Set())
    expect(flat.map((n) => n.row.id)).toEqual(['parent', 'child', 'grandchild', 'sibling'])
    expect(flat.map((n) => n.depth)).toEqual([0, 1, 2, 0])
  })

  it('keeps a collapsed parent visible but omits its descendants', () => {
    const tree = buildProjectRowTree([parent, child, grandchild, sibling])
    const flat = flattenProjectRowTree(tree, new Set([parent.id]))
    expect(flat.map((n) => n.row.id)).toEqual(['parent', 'sibling'])
  })
})
