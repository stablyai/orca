import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import { resolveUnifiedTabCreatePlacement } from '@/store/slices/tabs/tabs-create-placement'
import {
  getUnifiedTabPaletteExecutionHostId,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'

const WT = 'wt-1'
const worktree = { id: WT, hostId: undefined, runtimeOwnerEnvironmentId: undefined }
const PROOF = new Set([WT])
const NO_AMBIGUITY = new Set<string>()

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'host-tab',
    entityId: 'host-tab',
    groupId: 'group-1',
    worktreeId: WT,
    contentType: 'terminal',
    executionHostId: 'runtime:env-b',
    projectHostSetupId: 'setup-b',
    label: 'Host terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

describe('isUnifiedTabOwnedByWorktree for host-stamped terminals', () => {
  it('owns a valid stamp only with state-derived local proof', () => {
    expect(isUnifiedTabOwnedByWorktree(tab(), worktree, NO_AMBIGUITY, PROOF)).toBe(true)
    expect(isUnifiedTabOwnedByWorktree(tab(), worktree, NO_AMBIGUITY)).toBe(false)
    expect(isUnifiedTabOwnedByWorktree(tab(), worktree, NO_AMBIGUITY, new Set())).toBe(false)
  })

  it('refuses an ambiguous source even with proof', () => {
    expect(isUnifiedTabOwnedByWorktree(tab(), worktree, new Set([WT]), PROOF)).toBe(false)
  })

  it.each([
    ['a blank stamp', { projectHostSetupId: '' }],
    ['a local host', { executionHostId: 'local' as const }],
    ['a missing host', { executionHostId: undefined }],
    ['an editor tab', { contentType: 'editor' as const }]
  ])('refuses %s', (_label, overrides) => {
    expect(isUnifiedTabOwnedByWorktree(tab(overrides), worktree, NO_AMBIGUITY, PROOF)).toBe(false)
  })

  it('does not widen foreign editor, browser or unstamped terminal ownership', () => {
    for (const contentType of ['editor', 'browser', 'terminal'] as const) {
      const foreign = tab({ contentType, projectHostSetupId: undefined })
      expect(isUnifiedTabOwnedByWorktree(foreign, worktree, NO_AMBIGUITY, PROOF)).toBe(false)
    }
    const local = tab({ executionHostId: undefined, projectHostSetupId: undefined })
    expect(isUnifiedTabOwnedByWorktree(local, worktree, NO_AMBIGUITY, PROOF)).toBe(true)
  })

  it('keeps the palette host on the SOURCE workspace while the tab keeps its target stamp', () => {
    const stampedTab = tab()
    expect(getUnifiedTabPaletteExecutionHostId(stampedTab, worktree)).toBeUndefined()
    expect(getUnifiedTabPaletteExecutionHostId(stampedTab, { ...worktree, hostId: 'local' })).toBe(
      'local'
    )
    expect(stampedTab.executionHostId).toBe('runtime:env-b')
  })
})

describe('resolveUnifiedTabCreatePlacement after a host-stamped terminal', () => {
  const group: TabGroup = {
    id: 'group-1',
    worktreeId: WT,
    activeTabId: 'host-tab',
    tabOrder: ['host-tab']
  }

  function place(
    anchor: Tab,
    isLocalSourceWorktree?: () => boolean,
    executionHostId?: Tab['executionHostId']
  ) {
    return resolveUnifiedTabCreatePlacement({
      groups: [group, { ...group, id: 'group-2', tabOrder: [] }],
      tabs: [anchor],
      activeGroupId: 'group-2',
      afterTabId: anchor.id,
      executionHostId,
      lookupWorktrees: () => [worktree],
      isLocalSourceWorktree
    })
  }

  it('follows the terminal in its local group with positive local proof', () => {
    expect(place(tab(), () => true)).toEqual({ groupId: 'group-1', anchorTabId: 'host-tab' })
    expect(place(tab(), () => true, 'local')).toEqual({
      groupId: 'group-1',
      anchorTabId: 'host-tab'
    })
  })

  it.each([
    ['without proof', tab(), undefined, undefined],
    ['when the proof is negative', tab(), () => false, undefined],
    ['for an invalid stamp', tab({ executionHostId: 'local' }), () => true, undefined],
    ['for a foreign requested host', tab(), () => true, 'runtime:env-c' as const]
  ])('falls back to the active group %s', (_label, anchor, proof, requestedHost) => {
    expect(place(anchor, proof, requestedHost)).toEqual({
      groupId: 'group-2',
      anchorTabId: undefined
    })
  })

  it('still rejects an unstamped foreign anchor', () => {
    const foreign = tab({ projectHostSetupId: undefined })
    expect(place(foreign, () => true, 'local')).toEqual({
      groupId: 'group-2',
      anchorTabId: undefined
    })
  })
})
