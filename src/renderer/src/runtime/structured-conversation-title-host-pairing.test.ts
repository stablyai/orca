// @vitest-environment happy-dom

import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { VisibilityResumeBatch } from './web-session-tabs-sync/visibility-resume-types'
import { applyVisibilityResumeRepairs } from './web-session-tabs-sync/visibility-resume-repair'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync'
import {
  cacheAiVaultSessionResult,
  readAiVaultSessionResultSnapshot
} from '@/components/right-sidebar/ai-vault-session-result-cache'
import { session, result } from '@/components/right-sidebar/ai-vault-structured-title-fixtures'

const initialState = useAppStore.getInitialState()
afterEach(() => {
  useAppStore.setState(initialState, true)
  resetWebSessionTabsSnapshotFreshnessForTests()
})
function frame(title: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'folder-workspace',
    publicationEpoch: 'host:one',
    snapshotVersion: 3,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    structuredConversationTitle: { sessionId: 'native-session', agent: 'codex', title }
  }
}
function cache(): void {
  resetWebSessionTabsSnapshotFreshnessForTests()
  cacheAiVaultSessionResult({
    key: 'host-pairing',
    executionHostScope: 'all',
    limit: 500,
    replaceHostEntries: false,
    result: { ...result(), sessions: [session('runtime:missing'), session('runtime:surviving')] }
  })
}
it('keeps a surviving title on its own host during a same-worktree visibility repair', () => {
  cache()
  const missing = { ...frame('Unused missing title'), removed: true as const }
  delete missing.structuredConversationTitle
  const surviving = frame('Surviving title')
  const batch: VisibilityResumeBatch = {
    visibilityGeneration: 1,
    environments: new Map(),
    pendingInventoryCount: 0,
    pendingMissingByWorktree: new Map(),
    deferredRepairWorktrees: new Set(),
    trackedWorktreeIds: new Set(),
    reapplyableSnapshotsByKey: new Map()
  }
  applyVisibilityResumeRepairs(batch, [
    { environmentId: 'missing', snapshot: missing },
    { environmentId: 'surviving', snapshot: surviving }
  ])
  expect(
    readAiVaultSessionResultSnapshot('host-pairing')?.sessions.map((row) => row.title)
  ).toEqual(['Codex Chat', 'Surviving title'])
})
it('does not borrow another accepted same-worktree verdict for a rejected title', () => {
  cache()
  const rejected = frame('Rejected title')
  const accepted = frame('Unused title')
  delete accepted.structuredConversationTitle
  applyWebSessionTabsStorePatch(
    (state) => state,
    {
      frames: [
        {
          environmentId: 'missing',
          worktreeId: accepted.worktree,
          snapshot: accepted,
          decision: { apply: true, settlesHostMirror: true }
        },
        {
          environmentId: 'surviving',
          worktreeId: rejected.worktree,
          snapshot: rejected,
          decision: { apply: false, settlesHostMirror: true }
        }
      ]
    },
    rejected
  )
  expect(
    readAiVaultSessionResultSnapshot('host-pairing')?.sessions.map((row) => row.title)
  ).toEqual(['Codex Chat', 'Codex Chat'])
})
