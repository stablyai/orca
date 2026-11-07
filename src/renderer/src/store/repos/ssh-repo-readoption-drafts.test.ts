import { it, vi, expect, afterEach } from 'vitest'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import { createTestStore } from '../slices/store-test-helpers'
import { TEST_REPO } from '../slices/worktrees-slice-test-fixtures'
import {
  nativeChatPastedTextToken,
  nativeChatPastedTextOperations
} from '@/components/native-chat/native-chat-pasted-text-reference'
import { promptSkillRefs } from '@/components/native-chat/native-chat-prompt-document'
import {
  nativeChatPastedTextState,
  settleNativeChatPastedText
} from '@/components/native-chat/native-chat-composer-pasted-text-references'
import * as drafts from '@/components/native-chat/native-chat-composer-draft-store'
import * as pending from '@/components/native-chat/native-chat-pending-attachment-cache'
import * as memory from '@/components/native-chat/native-chat-composer-draft-memory'
import * as sources from '@/components/native-chat/native-chat-launch-draft-source'

afterEach(() => vi.restoreAllMocks())

it('accepted collision/replay and committed new-writer revocation', async () => {
  const count = 2
  drafts.clearNativeChatComposerDraftsForTests()
  pending.clearNativeChatPendingAttachmentsForTests()
  const storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  await drafts.hydrateNativeChatComposerDrafts()
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
  const control = drafts.nativeChatLaunchPromptDraftScopeKey('live::/x', 'claude', 'ssh:other')
  drafts.updateNativeChatComposerDraft(control, { text: 'keep' }, 'immediate')
  const untouched = vi.fn()
  const unsubControl = drafts.subscribeToNativeChatComposerDraft(control, untouched)
  const rows = Array.from({ length: count }, (_, i) => {
    const id = `repo::/w${i}`
    const from = drafts.nativeChatLaunchPromptDraftScopeKey(id, 'claude', 'ssh:old')
    const to = drafts.nativeChatLaunchPromptDraftScopeKey(id, 'claude', 'ssh:new')
    drafts.updateNativeChatComposerDraft(from, rich(`/from${i}/SKILL.md`, `from${i}`), 'immediate')
    drafts.updateNativeChatComposerDraft(to, rich(`/to${i}/SKILL.md`, `to${i}`), 'immediate')
    drafts.writeLaunchSetupOptions(from, {
      agent: 'claude',
      surface: 'terminal',
      choices: { model: 'source' }
    })
    drafts.writeLaunchSetupOptions(to, {
      agent: 'claude',
      surface: 'chat',
      choices: { model: 'target' }
    })
    const token = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    drafts.appendToNativeChatComposerDraft(from, { text: nativeChatPastedTextToken(token) })
    nativeChatPastedTextOperations.set(token, { scopeKey: from, text: 'held source bytes' })
    const attempt = drafts.captureNativeChatComposerSubmission(from)
    const targetAttempt = drafts.captureNativeChatComposerSubmission(to)
    const stop = vi.fn(memory.subscribeToNativeChatComposerDraftAppend(from, vi.fn()))
    attempt.stopObserving = stop
    if (i % 2) {
      drafts.updateNativeChatComposerDraft(
        from,
        { text: '', document: undefined, images: [] },
        'immediate'
      )
    }
    const changed = vi.fn()
    const targetChanged = vi.fn()
    const unsubscribe = drafts.subscribeToNativeChatComposerDraft(from, changed)
    const unsubTarget = drafts.subscribeToNativeChatComposerDraft(to, targetChanged)
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
  drafts.flushNativeChatComposerDrafts()
  await drafts.nativeChatComposerDraftWritesSettled()
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
  drafts.flushNativeChatComposerDrafts()
  await drafts.nativeChatComposerDraftWritesSettled()
  expect(copied).not.toHaveBeenCalled()
  expect(untouched).not.toHaveBeenCalled()
  const before = rows.map((row, i) => {
    const held = drafts.readNativeChatComposerDraft(row.from)
    expect(promptSkillRefs(held.document)).toEqual(
      (i % 2 ? [`/to${i}/SKILL.md`] : [`/to${i}/SKILL.md`, `/from${i}/SKILL.md`]).map((path) => ({
        name: 'review',
        path
      }))
    )
    expect(sources.readLaunchSetupOptions(row.from)?.choices.model).toBe('target')
    expect(pending.nativeChatPendingAttachmentSnapshot(row.from).map((chip) => chip.id)).toEqual([
      `target-${i}`,
      `source-${i}`
    ])
    row.unsubscribe()
    row.changed.mockClear()
    row.targetChanged.mockClear()
    return held
  })
  const successor = drafts.nativeChatLaunchPromptDraftScopeKey(rows[0].id, 'claude', 'ssh:old')
  drafts.updateNativeChatComposerDraft(successor, { text: 'old address reused' }, 'immediate')
  store.getState().recordSshRepoReadoptions([{ ...descriptor }])
  rows.forEach((row, i) => {
    expect(drafts.readNativeChatComposerDraft(row.to)).toBe(before[i])
    expect(row.changed).not.toHaveBeenCalled()
  })
  expect(drafts.readNativeChatComposerDraft(successor).text).toBe('old address reused')
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
    expect(drafts.readNativeChatComposerDraft(row.from)).toBeDefined()
    expect(pending.nativeChatPendingAttachmentSnapshot(row.from)).toHaveLength(2)
    row.unsubTarget()
  }
  const fresh = drafts.nativeChatLaunchPromptDraftScopeKey(rows[0].id, 'claude', 'ssh:third')
  drafts.updateNativeChatComposerDraft(fresh, rich('/fresh/SKILL.md', 'fresh'), 'immediate')
  const held = drafts.readNativeChatComposerDraft(fresh)
  rows.forEach((row) => drafts.finishNativeChatComposerSubmission(row.from, row.attempt, true))
  expect(drafts.readNativeChatComposerDraft(fresh)).toBe(held)
  expect(drafts.readNativeChatComposerDraft(control).text).toBe('keep')
  unsubControl()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  pending.clearNativeChatPendingAttachmentsForTests()
  drafts.clearNativeChatComposerDraftsForTests()
})
