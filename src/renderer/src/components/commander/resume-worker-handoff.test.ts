// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { beginPendingTab } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeRepo } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { resumeWorkerHandoff } from './resume-worker-handoff'
import { handoffWorkspaces } from './handoff-workspaces'
import type { CommanderMemoryRevision } from '../../../../shared/commander/memory-contract'

const actions = vi.hoisted(() => ({
  plan: vi.fn(),
  insert: vi.fn(),
  prepare: vi.fn(),
  reveal: vi.fn(),
  activate: vi.fn(),
  open: vi.fn()
}))
const repo = { ...makeRepo(), upstream: { owner: 'team', repo: 'app' } }
const wt = makeWorktree({
  repoId: repo.id,
  id: 'checkout-id',
  instanceId: 'first',
  branch: 'release',
  head: 'def456'
})
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ repos: [repo], worktreesByRepo: { [repo.id]: [wt] } }) }
}))
vi.mock('@/lib/agent-session/launch/routing/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: actions.plan
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-execution-context', () => ({
  agentTabLaunchStore: (store: unknown) => store
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: actions.reveal
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-surface', () => ({
  openStructuredAgentSessionProvisionalTab: actions.open
}))
vi.mock('@/lib/agent-session/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: actions.activate
}))
vi.mock('../native-chat/drafts/native-chat-composer-draft-load', () => ({
  hydrateNativeChatComposerDrafts: async () => undefined
}))
vi.mock('../native-chat/composer/focus/native-chat-composer-focus-intent', () => ({
  requestNativeChatComposerFocus: () => undefined
}))
vi.mock('./open-commander-chat', () => ({ prepareHandoffDraft: actions.prepare }))
const account = { profileId: 'profile', userId: 'user', activeOrgId: 'org' }
const page: CommanderMemoryRevision = {
  pageId: 'handoff-00000000-0000-4000-8000-000000000001',
  projectId: 'github:team/app',
  title: 'Continue billing migration',
  body: '## Progress\n\nSchema drafted\n\n## Next step\n\nReview SQL',
  kind: 'note',
  links: [],
  version: 3,
  deleted: false,
  actor: { type: 'commander', id: 'commander' },
  createdBy: { type: 'commander', id: 'commander' },
  createdAt: '2026-01-01T00:00:00Z'
}
const target = {
  agent: 'codex' as const,
  hostId: 'local' as const,
  worktreeId: 'checkout-id',
  instanceId: 'first'
}
beforeEach(() => {
  actions.open.mockReturnValue({ id: 'chat-tab' })
})
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

function stubHandoffReads(latest = page, guidelines: string[] = [], truncated = false) {
  const get = vi.fn(async () => ({ page: latest, history: [] }))
  const workerGuidance = vi.fn(async () => ({ guidelines, truncated }))
  vi.stubGlobal('api', { commanderMemory: { get, workerGuidance } })
  return { get, workerGuidance }
}

it.each(['codex', 'claude'] as const)(
  'opens a blank %s chat then inserts the selected handoff and scoped, budgeted guidance into its editable draft',
  async (agent) => {
    const { get, workerGuidance } = stubHandoffReads(
      page,
      ['Check migrations (v3)\nUse staged schema tests.'],
      true
    )
    actions.plan.mockReturnValue({
      launch: async () => ({ kind: 'structured', sessionId: 'new-codex' })
    })
    actions.prepare.mockReturnValue(actions.insert)
    actions.activate.mockReturnValue(true)
    expect(await resumeWorkerHandoff(account, page, { ...target, agent }, () => true)).toBe(true)
    expect(get).toHaveBeenCalledWith(account, page.pageId, 1)
    expect(workerGuidance).toHaveBeenCalledWith(account, 'github:team/app')
    const [, request] = actions.plan.mock.calls[0]!
    expect(request).toMatchObject({
      agent,
      workspace: { kind: 'git-worktree', worktreeId: 'checkout-id' },
      selectedExecutionHostId: 'local',
      requestedSurface: 'chat'
    })
    expect(request).not.toHaveProperty('prompt')
    const [session, text, owner] = actions.prepare.mock.calls[0]!
    expect(session).toBe('new-codex')
    expect(owner).toEqual({ workspaceId: 'checkout-id', executionHostId: 'local' })
    for (const snippet of [
      'Schema drafted',
      'Review SQL',
      'release at def456',
      'Use staged schema tests.',
      'commander_ask_preference',
      'Review the remaining guidelines in Commander Memory'
    ]) {
      expect(text).toContain(snippet)
    }
    expect(actions.activate).toHaveBeenCalledWith({
      worktreeId: 'checkout-id',
      sessionId: 'new-codex',
      target: { kind: 'local' },
      callerOnly: true
    })
    expect(actions.insert).toHaveBeenCalledOnce()
  }
)

it('leaves a newly created worker draft untouched if the source revision changed before insertion', async () => {
  stubHandoffReads({ ...page, version: 4, body: 'Superseded after opening chat' })
  actions.plan.mockReturnValue({
    launch: async () => ({ kind: 'structured', sessionId: 'fresh' })
  })
  await expect(resumeWorkerHandoff(account, page, target, () => true)).rejects.toThrow(
    'handoff changed'
  )
  expect(actions.prepare).not.toHaveBeenCalled()
  expect(actions.reveal).not.toHaveBeenCalled()
})

it('drops account context if the user switches account during chat creation, and refuses replaced checkouts', async () => {
  let current = true
  stubHandoffReads()
  actions.plan.mockReturnValue({
    launch: async () => {
      current = false
      return { kind: 'structured', sessionId: 'late' }
    }
  })
  expect(await resumeWorkerHandoff(account, page, target, () => current)).toBe(false)
  expect(
    await resumeWorkerHandoff(account, page, { ...target, instanceId: 'stale' }, () => true)
  ).toBe(false)
  expect(actions.prepare).not.toHaveBeenCalled()
  expect(actions.reveal).not.toHaveBeenCalled()
})

it('never offers an ambiguous legacy row for two hosts sharing the same repo and checkout IDs', () => {
  const twin = { ...repo, executionHostId: 'runtime:another' as const }
  expect(
    handoffWorkspaces('github:team/app', 'runtime:another', [repo, twin], { [repo.id]: [wt] })
  ).toEqual([])
  expect(handoffWorkspaces('repo:repo-1', 'local', [repo], { [repo.id]: [wt] })).toEqual([])
})

it.each(['revealed', 'activated'] as const)(
  'drops the draft when the destination changes after the chat is %s',
  async (step) => {
    let current = true
    stubHandoffReads()
    actions.plan.mockReturnValue({
      launch: async () => ({ kind: 'structured', sessionId: 'fresh' })
    })
    actions.prepare.mockReturnValue(actions.insert)
    actions.activate.mockReturnValue(true)
    const action = step === 'revealed' ? actions.reveal : actions.activate
    action.mockImplementation(() => {
      current = false
      return true
    })
    expect(
      await resumeWorkerHandoff(
        account,
        page,
        target,
        () => true,
        () => current
      )
    ).toBe(false)
    expect(actions.insert).not.toHaveBeenCalled()
  }
)

it.each(['chat-tab', null])(
  'waits for the layout owner to answer a new chat open (%s)',
  async (shown) => {
    const settle = beginPendingTab('chat-tab', target.worktreeId, 'fresh', { kind: 'open' })
    const opened = Promise.withResolvers<void>()
    actions.open.mockImplementation(() => {
      opened.resolve()
      return { id: 'chat-tab' }
    })
    stubHandoffReads()
    actions.plan.mockReturnValue({
      launch: async () => ({ kind: 'structured', sessionId: 'fresh' })
    })
    actions.prepare.mockReturnValue(actions.insert)
    actions.activate.mockReturnValue(true)
    let panelOpen = true
    actions.reveal.mockImplementation(() => {
      panelOpen = false
      return true
    })
    const result = resumeWorkerHandoff(
      account,
      page,
      target,
      () => panelOpen,
      () => true
    )
    await opened.promise
    expect(actions.open).toHaveBeenCalledWith({
      worktreeId: 'checkout-id',
      executionHostId: 'local',
      sessionId: 'fresh',
      agent: 'codex',
      activate: false
    })
    expect(actions.reveal).not.toHaveBeenCalled()
    expect(actions.insert).not.toHaveBeenCalled()
    settle(shown)
    expect(await result).toBe(shown !== null)
    expect(actions.insert).toHaveBeenCalledTimes(shown === null ? 0 : 1)
  }
)
