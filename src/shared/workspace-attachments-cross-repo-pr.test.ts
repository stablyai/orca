import { describe, expect, it } from 'vitest'
import type { WorkspaceAttachment } from './worktree/types'
import {
  getWorkspaceAttachments,
  normalizeWorkspaceAttachmentUpdate
} from './workspace-attachments'
import { WorktreeSet } from './rpc-contract/worktree-params'

const crossRepoPR: WorkspaceAttachment = {
  provider: 'github',
  type: 'pr',
  number: 2383,
  url: 'https://github.com/relayto/relayto-frontend/pull/2383'
}
const sameRepoPR: WorkspaceAttachment = { provider: 'github', type: 'pr', number: 11 }
// What `orca worktree set --pr <url>` sends: an add-only delta plus the selection.
const setPRUrl = { linkedItemsBase: [], linkedItems: [crossRepoPR], linkedPR: 2383 }

describe('cross-repository PR links in workspace metadata', () => {
  it('reads metadata persisted by older builds (number slot + URL item) unchanged', () => {
    const persisted = { linkedPR: 2383, linkedItems: [crossRepoPR] }
    expect(getWorkspaceAttachments(persisted)).toEqual([crossRepoPR])
  })

  it('set --pr <url> adds the URL reference beside existing links and selects it', () => {
    const result = normalizeWorkspaceAttachmentUpdate(
      { linkedPR: 11, linkedItems: [sameRepoPR] },
      setPRUrl
    )
    expect(result.linkedItems).toEqual([sameRepoPR, crossRepoPR])
    expect(result.linkedPR).toBe(2383)
  })

  it('set --pr <url> upgrades a bare link with the same number instead of hiding behind it', () => {
    for (const existing of [
      { linkedPR: 2383 },
      { linkedPR: 2383, linkedItems: [{ ...sameRepoPR, number: 2383 }] }
    ]) {
      const result = normalizeWorkspaceAttachmentUpdate(existing, setPRUrl)
      expect(result.linkedItems).toEqual([crossRepoPR])
      expect(result.linkedPR).toBe(2383)
    }
  })

  it('set --pr <url> is idempotent for an already linked URL', () => {
    const result = normalizeWorkspaceAttachmentUpdate(
      { linkedPR: 2383, linkedItems: [crossRepoPR] },
      setPRUrl
    )
    expect(result.linkedItems).toEqual([crossRepoPR])
    expect(result.linkedPR).toBe(2383)
  })

  it('set --pr null removes the URL-linked PR and its selection', () => {
    const result = normalizeWorkspaceAttachmentUpdate(
      { linkedPR: 2383, linkedItems: [sameRepoPR, crossRepoPR] },
      { linkedPR: null }
    )
    expect(result.linkedItems).toEqual([sameRepoPR])
    expect(result.linkedPR).toBeNull()
  })

  it('the host accepts the add-only delta over RPC', () => {
    expect(WorktreeSet.parse({ worktree: 'wt', ...setPRUrl })).toMatchObject(setPRUrl)
  })
})
