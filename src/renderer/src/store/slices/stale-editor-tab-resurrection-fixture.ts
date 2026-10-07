import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../../shared/workspace-session-state-types'

/**
 * Scrubbed copy of a real corrupted `workspaceSession`: a LOCAL git worktree whose editor
 * records were stamped with a paired REMOTE runtime, duplicated once per in-session write.
 */
export const STALE_TAB_REPO_ID = '2fa91e38-9145-422c-8bd7-f2438886fb57'
export const STALE_TAB_WORKTREE_PATH = '/Users/tester/work/egongegong/eppo'
export const STALE_TAB_WORKTREE_ID = `${STALE_TAB_REPO_ID}::${STALE_TAB_WORKTREE_PATH}`
export const STALE_TAB_RUNTIME_ENV_ID = '107a064f-7bd8-42b4-95e1-192ffc9f5014'
export const STALE_TAB_GROUP_ID = '77437b43-6004-4d4f-921b-4fe2d7c91660'

const CSV_RELATIVE_PATH = 'sandbox/2026-09-14-kahi-e2e-data-survey/kahi-2026-07-qty-by-listing.csv'
const BRAND_RELATIVE_PATH = 'sandbox/2026-09-16-listings-survey/handout/brand-requests.txt'
export const STALE_TAB_CSV_PATH = `${STALE_TAB_WORKTREE_PATH}/${CSV_RELATIVE_PATH}`
export const STALE_TAB_BRAND_PATH = `${STALE_TAB_WORKTREE_PATH}/${BRAND_RELATIVE_PATH}`

const encodedWorktreeId = encodeURIComponent(STALE_TAB_WORKTREE_ID)
const compositeTabId = (filePath: string): string =>
  `editor:${encodedWorktreeId}:${STALE_TAB_RUNTIME_ENV_ID}:${encodeURIComponent(filePath)}`

export const STALE_TAB_CSV_TAB_ID = compositeTabId(STALE_TAB_CSV_PATH)
export const STALE_TAB_BRAND_COMPOSITE_TAB_ID = compositeTabId(STALE_TAB_BRAND_PATH)
export const STALE_TAB_BRAND_PLAIN_TAB_ID = '0279b787-cef3-4a63-9c32-e1d167c1e30a'

function persistedFile(
  filePath: string,
  relativePath: string,
  language: string,
  runtimeEnvironmentId: string | null
): PersistedOpenFile {
  return {
    filePath,
    relativePath,
    worktreeId: STALE_TAB_WORKTREE_ID,
    language,
    runtimeEnvironmentId
  }
}

function csvRecord(runtimeEnvironmentId: string | null): PersistedOpenFile {
  return persistedFile(STALE_TAB_CSV_PATH, CSV_RELATIVE_PATH, 'csv', runtimeEnvironmentId)
}

function brandRecord(runtimeEnvironmentId: string | null): PersistedOpenFile {
  return persistedFile(STALE_TAB_BRAND_PATH, BRAND_RELATIVE_PATH, 'plaintext', runtimeEnvironmentId)
}

function editorTab(id: string, entityId: string, label: string, sortOrder: number): Tab {
  return {
    id,
    entityId,
    groupId: STALE_TAB_GROUP_ID,
    worktreeId: STALE_TAB_WORKTREE_ID,
    executionHostId: `runtime:${STALE_TAB_RUNTIME_ENV_ID}`,
    contentType: 'editor',
    label,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1_789_550_578_678,
    isPreview: false,
    isPinned: false
  }
}

function tabGroup(): TabGroup {
  return {
    id: STALE_TAB_GROUP_ID,
    worktreeId: STALE_TAB_WORKTREE_ID,
    activeTabId: '0621f040-05e5-4b80-a286-6d47cb3a7e9d',
    tabOrder: [
      'd53f0978-4ac0-4523-8b7c-58ded597d25e',
      '0621f040-05e5-4b80-a286-6d47cb3a7e9d',
      STALE_TAB_BRAND_PLAIN_TAB_ID,
      'd12834f3-4903-48d0-8fcf-09142b36fbad',
      STALE_TAB_CSV_TAB_ID,
      STALE_TAB_BRAND_COMPOSITE_TAB_ID
    ],
    recentTabIds: [
      'd53f0978-4ac0-4523-8b7c-58ded597d25e',
      STALE_TAB_BRAND_PLAIN_TAB_ID,
      'd12834f3-4903-48d0-8fcf-09142b36fbad',
      '0621f040-05e5-4b80-a286-6d47cb3a7e9d'
    ]
  }
}

/** Fresh deep copy so a test can mutate one field without leaking into the next case. */
export function buildStaleEditorTabSession(): WorkspaceSessionState {
  return {
    activeRepoId: STALE_TAB_REPO_ID,
    activeWorktreeId: STALE_TAB_WORKTREE_ID,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: {
      [STALE_TAB_WORKTREE_ID]: [
        csvRecord(STALE_TAB_RUNTIME_ENV_ID),
        brandRecord(null),
        brandRecord(STALE_TAB_RUNTIME_ENV_ID),
        csvRecord(STALE_TAB_RUNTIME_ENV_ID),
        brandRecord(STALE_TAB_RUNTIME_ENV_ID),
        brandRecord(STALE_TAB_RUNTIME_ENV_ID)
      ]
    },
    activeFileIdByWorktree: { [STALE_TAB_WORKTREE_ID]: STALE_TAB_BRAND_PATH },
    activeTabTypeByWorktree: { [STALE_TAB_WORKTREE_ID]: 'terminal' },
    unifiedTabs: {
      [STALE_TAB_WORKTREE_ID]: [
        editorTab(STALE_TAB_CSV_TAB_ID, STALE_TAB_CSV_PATH, 'kahi-2026-07-qty-by-listing.csv', 0),
        editorTab(STALE_TAB_BRAND_PLAIN_TAB_ID, STALE_TAB_BRAND_PATH, 'brand-requests.txt', 1),
        editorTab(STALE_TAB_BRAND_COMPOSITE_TAB_ID, STALE_TAB_BRAND_PATH, 'brand-requests.txt', 2)
      ]
    },
    tabGroups: { [STALE_TAB_WORKTREE_ID]: [tabGroup()] },
    activeGroupIdByWorktree: { [STALE_TAB_WORKTREE_ID]: STALE_TAB_GROUP_ID }
  }
}
