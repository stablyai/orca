import { it, vi, expect, afterEach } from 'vitest'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/drafts/native-chat-composer-draft-storage'
import { createTestStore } from '../testing/app-store-test-fixture'
import { TEST_REPO } from './repo.test-fixture'
import {
  nativeChatPastedTextToken,
  nativeChatPastedTextOperations
} from '@/components/native-chat/paste/native-chat-pasted-text-reference'
import { promptSkillRefs } from '@/components/native-chat/composer/editor/native-chat-prompt-document'
import {
  nativeChatPastedTextState,
  settleNativeChatPastedText
} from '@/components/native-chat/paste/native-chat-composer-pasted-text-references'
import * as drafts from '@/components/native-chat/drafts/native-chat-draft-reset'
import * as draftsOwner1 from '@/components/native-chat/drafts/native-chat-composer-draft-load'
import * as draftsOwner2 from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import * as draftsOwner3 from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import * as draftsOwner4 from '@/components/native-chat/drafts/native-chat-composer-draft-memory'
import * as draftsOwner5 from '@/components/native-chat/drafts/native-chat-composer-draft-persistence'
import * as pending from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'

afterEach(() => vi.restoreAllMocks())

it('accepted collision/replay and committed new-writer revocation', async () => {
  const count = 2
  drafts.clearNativeChatComposerDraftsForTests()
  pending.clearNativeChatPendingAttachmentsForTests()
  const storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  await draftsOwner1.hydrateNativeChatComposerDrafts()
  const store = createTestStore()
  const repo = {
    ...TEST_REPO,
    id: 'repo',
    executionHostId: 'ssh:old' as const,
    connectionId: 'old'
  }
  const nextRepo = { ...repo, executionHostId: 'ssh:new' as const, connectionId: 'new' }
  store.setState({ repos: [repo, nextRepo] })
  vi.stubGlobal('window', {
    api: {
      repos: { removeForHost: vi.fn().mockResolvedValue(undefined) },
      pty: { kill: vi.fn() }
    }
  })
  const rich = (path: string, id: string) => ({
    text: '$review',
    images: [
      { id: 'shared', path: '/shared.png' },
      { id, path: `${id}.png` }
    ],
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'nativeChatSkill', attrs: { token: '$review', path } }]
        }
      ]
    }
  })
  const control = draftsOwner2.nativeChatLaunchPromptDraftScopeKey(
    'live::/x',
    'claude',
    'ssh:other'
  )
  draftsOwner3.updateNativeChatComposerDraft(control, { text: 'keep' }, 'immediate')
  const untouched = vi.fn()
  const unsubControl = draftsOwner3.subscribeToNativeChatComposerDraft(control, untouched)
  const rows = Array.from({ length: count }, (_, i) => {
    const id = `repo::/w${i}`
    const from = draftsOwner2.nativeChatLaunchPromptDraftScopeKey(id, 'claude', 'ssh:old')
    const to = draftsOwner2.nativeChatLaunchPromptDraftScopeKey(id, 'claude', 'ssh:new')
    draftsOwner3.updateNativeChatComposerDraft(
      from,
      rich(`/from${i}/SKILL.md`, `from${i}`),
      'immediate'
    )
    draftsOwner3.updateNativeChatComposerDraft(to, rich(`/to${i}/SKILL.md`, `to${i}`), 'immediate')
    draftsOwner4.writeLaunchSetupOptions(from, {
      agent: 'claude',
      surface: 'terminal',
      choices: { model: 'source' }
    })
    draftsOwner4.writeLaunchSetupOptions(to, {
      agent: 'claude',
      surface: 'chat',
      choices: { model: 'target' }
    })
    const token = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    draftsOwner3.appendToNativeChatComposerDraft(from, { text: nativeChatPastedTextToken(token) })
    nativeChatPastedTextOperations.set(token, { scopeKey: from, text: 'held source bytes' })
    const attempt = draftsOwner4.captureNativeChatComposerSubmission(from)
    const targetAttempt = draftsOwner4.captureNativeChatComposerSubmission(to)
    const stop = vi.fn(draftsOwner4.subscribeToNativeChatComposerDraftAppend(from, vi.fn()))
    attempt.stopObserving = stop
    if (i % 2) {
      draftsOwner3.updateNativeChatComposerDraft(
        from,
        { text: '', document: undefined, images: [] },
        'immediate'
      )
    }
    const changed = vi.fn()
    const targetChanged = vi.fn()
    const unsubscribe = draftsOwner3.subscribeToNativeChatComposerDraft(from, changed)
    const unsubTarget = draftsOwner3.subscribeToNativeChatComposerDraft(to, targetChanged)
    pending.addNativeChatPendingAttachment(to, { id: `target-${i}`, path: '', pending: true })
    pending.addNativeChatPendingAttachment(from, { id: `source-${i}`, path: '', pending: true })
    return {
      id,
      from,
      to,
      token,
      attempt,
      targetAttempt,
      stop,
      changed,
      targetChanged,
      unsubscribe,
      unsubTarget
    }
  })
  draftsOwner5.flushNativeChatComposerDrafts()
  await draftsOwner5.nativeChatComposerDraftWritesSettled()
  const copied = vi.fn()
  const update = storage.update
  vi.spyOn(storage, 'update').mockImplementation((scope, apply) =>
    update(scope, (stored) => {
      const next = apply(stored)
      if (next) {
        copied(next)
      }
      return next
    })
  )
  const write = storage.write
  vi.spyOn(storage, 'write').mockImplementation((scope, draft) => {
    copied(draft)
    return write(scope, draft)
  })
  const descriptor = { oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }
  store.getState().recordSshRepoReadoptions([descriptor])
  draftsOwner5.flushNativeChatComposerDrafts()
  await draftsOwner5.nativeChatComposerDraftWritesSettled()
  expect(copied).not.toHaveBeenCalled()
  expect(untouched).not.toHaveBeenCalled()
  const before = rows.map((row, i) => {
    const held = draftsOwner3.readNativeChatComposerDraft(row.from)
    expect(promptSkillRefs(held.document)).toEqual(
      (i % 2 ? [`/to${i}/SKILL.md`] : [`/to${i}/SKILL.md`, `/from${i}/SKILL.md`]).map((path) => ({
        name: 'review',
        path
      }))
    )
    expect(draftsOwner2.readLaunchSetupOptions(row.from)?.choices.model).toBe('target')
    expect(pending.nativeChatPendingAttachmentSnapshot(row.from).map((chip) => chip.id)).toEqual([
      `target-${i}`,
      `source-${i}`
    ])
    row.unsubscribe()
    row.changed.mockClear()
    row.targetChanged.mockClear()
    return held
  })
  const successor = draftsOwner2.nativeChatLaunchPromptDraftScopeKey(
    rows[0].id,
    'claude',
    'ssh:old'
  )
  draftsOwner3.updateNativeChatComposerDraft(successor, { text: 'old address reused' }, 'immediate')
  store.getState().recordSshRepoReadoptions([{ ...descriptor }])
  rows.forEach((row, i) => {
    expect(draftsOwner3.readNativeChatComposerDraft(row.to)).toBe(before[i])
    expect(row.changed).not.toHaveBeenCalled()
  })
  expect(draftsOwner3.readNativeChatComposerDraft(successor).text).toBe('old address reused')
  const thirdRepo = { ...nextRepo, executionHostId: 'ssh:third' as const, connectionId: 'third' }
  store.setState({ repos: [nextRepo, thirdRepo] })
  store
    .getState()
    .recordSshRepoReadoptions([{ oldTargetId: 'new', newTargetId: 'third', repoIds: ['repo'] }])
  rows.forEach((row, i) => {
    if (i % 2 === 0) {
      expect(nativeChatPastedTextState(row.to, nativeChatPastedTextToken(row.token))).toBe('saving')
    }
    expect(settleNativeChatPastedText(row.token, `/saved-${i}.txt`)).toBe(i % 2 === 0)
  })
  await store.getState().removeProject('repo', { hostId: 'ssh:third' })
  // Source-only records/chips are deliberately subject to ordinary pre-call membership and stale-stamp limits.
  for (const row of rows) {
    expect(row.stop).toHaveBeenCalled()
    expect(row.attempt.draft).toBeUndefined()
    expect(row.targetAttempt.draft).toBeUndefined()
    expect(draftsOwner3.readNativeChatComposerDraft(row.from)).toBeDefined()
    expect(pending.nativeChatPendingAttachmentSnapshot(row.from)).toHaveLength(2)
    row.unsubTarget()
  }
  const fresh = draftsOwner2.nativeChatLaunchPromptDraftScopeKey(rows[0].id, 'claude', 'ssh:third')
  draftsOwner3.updateNativeChatComposerDraft(fresh, rich('/fresh/SKILL.md', 'fresh'), 'immediate')
  const held = draftsOwner3.readNativeChatComposerDraft(fresh)
  rows.forEach((row) =>
    draftsOwner3.finishNativeChatComposerSubmission(row.from, row.attempt, true)
  )
  expect(draftsOwner3.readNativeChatComposerDraft(fresh)).toBe(held)
  expect(draftsOwner3.readNativeChatComposerDraft(control).text).toBe('keep')
  unsubControl()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  pending.clearNativeChatPendingAttachmentsForTests()
  drafts.clearNativeChatComposerDraftsForTests()
})
