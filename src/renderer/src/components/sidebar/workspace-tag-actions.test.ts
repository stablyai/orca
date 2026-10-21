import { describe, expect, it } from 'vitest'
import {
  collectWorkspaceTags,
  getTagSelectionState,
  countAtTagLimit,
  planTagAdd,
  planTagDelete,
  planTagRename,
  planTagToggle
} from './workspace-tag-actions'

const api = { id: 'api', tags: ['Billing', 'backend'] }
const web = { id: 'web', tags: ['billing'] }
const docs = { id: 'docs' }

function tagsById(updates: { workspace: { id: string }; tags: string[] }[]) {
  return Object.fromEntries(updates.map((update) => [update.workspace.id, update.tags]))
}

describe('collectWorkspaceTags', () => {
  it('lists each tag once, alphabetically, with how many workspaces use it', () => {
    expect(collectWorkspaceTags([web, api, docs])).toEqual([
      { tag: 'backend', count: 1 },
      { tag: 'Billing', count: 2 }
    ])
  })

  it('forgets a tag once no workspace carries it', () => {
    expect(collectWorkspaceTags([docs])).toEqual([])
  })
})

describe('getTagSelectionState', () => {
  it('reports all, some, or none across a selection, ignoring case', () => {
    expect(getTagSelectionState([api, web], 'BILLING')).toBe('all')
    expect(getTagSelectionState([api, web], 'backend')).toBe('some')
    expect(getTagSelectionState([docs], 'backend')).toBe('none')
  })
})

describe('planTagToggle', () => {
  it('adds the tag to every selected workspace that lacks it', () => {
    expect(tagsById(planTagToggle([api, docs], 'backend'))).toEqual({ docs: ['backend'] })
  })

  it('removes the tag from all when every selected workspace has it', () => {
    expect(tagsById(planTagToggle([api, web], 'billing'))).toEqual({
      api: ['backend'],
      web: []
    })
  })

  it('ignores a blank tag', () => {
    expect(planTagToggle([docs], '   ')).toEqual([])
  })
})

describe('planTagRename', () => {
  it('renames the tag on every workspace, keeping other tags in place', () => {
    expect(tagsById(planTagRename([api, web, docs], 'billing', 'Payments'))).toEqual({
      api: ['Payments', 'backend'],
      web: ['Payments']
    })
  })

  it('merges into an existing tag without duplicating it', () => {
    expect(tagsById(planTagRename([api], 'billing', 'Backend'))).toEqual({ api: ['Backend'] })
  })

  it('skips workspaces whose tags would not change', () => {
    expect(planTagRename([api], 'Billing', 'Billing')).toEqual([])
    expect(planTagRename([api], 'billing', '  ')).toEqual([])
  })
})

describe('planTagDelete', () => {
  it('removes the tag everywhere and leaves untagged workspaces alone', () => {
    expect(tagsById(planTagDelete([api, web, docs], 'Billing'))).toEqual({
      api: ['backend'],
      web: []
    })
  })
})

describe('planTagAdd', () => {
  it('adds the tag only where it is missing and never removes it', () => {
    expect(tagsById(planTagAdd([api, web, docs], 'Billing'))).toEqual({ docs: ['Billing'] })
    expect(planTagAdd([api, web], 'billing')).toEqual([])
  })
})

describe('tag limit', () => {
  const full = { id: 'full', tags: Array.from({ length: 32 }, (_, index) => `t${index}`) }

  it('skips workspaces that already hold the maximum and reports them', () => {
    expect(tagsById(planTagToggle([full, docs], 'extra'))).toEqual({ docs: ['extra'] })
    expect(tagsById(planTagAdd([full, docs], 'extra'))).toEqual({ docs: ['extra'] })
    expect(countAtTagLimit([full, docs], 'extra')).toBe(1)
    expect(countAtTagLimit([full], 't0')).toBe(0)
  })
})
