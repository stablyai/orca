import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import {
  ATTACHMENT_INPUT_KINDS,
  buildWorkspaceAttachmentEdits,
  canUseWorkspaceReviewForChecks
} from './worktree-attachment-editing'

const language = vi.hoisted(() => ({ prefix: '' }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => language.prefix + fallback
}))

function repo(host: string): Repo {
  return {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '',
    addedAt: 0,
    gitRemoteIdentity: {
      canonicalKey: `${host}/acme/repo`,
      remoteName: 'origin',
      remoteUrl: `https://${host}/acme/repo.git`
    }
  }
}
const review: WorkspaceAttachment = { provider: 'github', type: 'pr', number: 1 }

describe('workspace attachment editing', () => {
  it('translates reference type labels when rendered after a language change', () => {
    expect(ATTACHMENT_INPUT_KINDS[0].label()).toBe('GitHub PR')
    language.prefix = 'translated: '
    expect(ATTACHMENT_INPUT_KINDS[0].label()).toBe('translated: GitHub PR')
    language.prefix = ''
  })
  it('requires a compatible provider before a bare review can drive checks', () => {
    expect(canUseWorkspaceReviewForChecks(review, repo('github.com'))).toBe(true)
    expect(
      canUseWorkspaceReviewForChecks(
        { provider: 'gitlab', type: 'mr', number: 1 },
        repo('github.com')
      )
    ).toBe(false)
    expect(canUseWorkspaceReviewForChecks(review, repo('git.example.com'))).toBe(false)
    expect(canUseWorkspaceReviewForChecks(review, repo('git.example.com'), 'github')).toBe(true)
    expect(canUseWorkspaceReviewForChecks(review, undefined)).toBe(false)
  })

  it('submits base and draft snapshots without pre-merging concurrent changes', () => {
    const initial = [{ ...review, title: 'Old' }]
    const draft = [
      { ...review, title: 'New', origins: [{ kind: 'observed' as const, tabId: 'tab' }] }
    ]
    expect(buildWorkspaceAttachmentEdits({ initial, draft })).toEqual({
      linkedItemsBase: initial,
      linkedItems: draft
    })
  })
  it('removes a review through the collection without emitting a scalar selection', () => {
    const mr: WorkspaceAttachment = { provider: 'gitlab', type: 'mr', number: 2 }
    const initial = [review, mr]
    expect(buildWorkspaceAttachmentEdits({ initial, draft: [mr] })).toEqual({
      linkedItemsBase: initial,
      linkedItems: [mr]
    })
  })
  it('omits untouched collections', () => {
    expect(buildWorkspaceAttachmentEdits({ initial: [review], draft: [{ ...review }] })).toEqual({})
  })
})
