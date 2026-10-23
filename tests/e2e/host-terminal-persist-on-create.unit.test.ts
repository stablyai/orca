/**
 * The composed host-terminal create the earlier tests mocked away: the real renderer create, the
 * real local `terminal.create` RPC on a real runtime over a real SQLite Store, then the renderer's
 * own session patch, read back from disk. Only the owner runtime's transport is faked.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { StoreApi, UseBoundStore } from 'zustand'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultPersistedState } from '../../src/shared/constants'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { TerminalCreateParams } from '../../src/shared/rpc-contract/terminal-unary-params'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import type { OrchestrationEnvironmentTransport } from '../../src/main/runtime/orchestration/environment-transport'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { RuntimeMachineName } from '../../src/main/runtime/runtime-machine-name'
import { eraseRpcMethods } from '../../src/main/runtime/rpc/core'
import { TERMINAL_METHODS } from '../../src/main/runtime/rpc/methods/terminal'
import { reopenTopologyStore } from '../../src/main/persistence/terminal-topology/terminal-topology-profile-fixture'
import { DelayedAuthority } from '../../src/main/persistence/loading-store/profile-state-delayed-authority-fixture'
import { ProfileStateSqliteAuthority } from '../../src/main/persistence/profile-state/profile-state-sqlite-authority'
import { Store } from '../../src/main/persistence/loading-store/store'
import type { AppState } from '@/store/types'
import { buildWorkspaceSessionPatch } from '@/lib/workspace-session-patch'
import { SESSION_RELEVANT_FIELDS } from '@/lib/workspace-session'
import { patchWorkspaceSessionByHost } from '@/lib/workspace-session-host-persistence'
import { createTestStore, makeWorktree, seedStore } from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { createTerminalTabOnHost } from '@/components/tab-bar/tab-bar-host-terminal-create'

type ComposedMocks = {
  callRuntimeRpc: ReturnType<typeof vi.fn>
  store: null | UseBoundStore<StoreApi<AppState>>
}

const mocks = vi.hoisted((): ComposedMocks => ({ callRuntimeRpc: vi.fn(), store: null }))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  app: { getPath: vi.fn(() => tmpdir()), getVersion: vi.fn(() => '0.0.0') }
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.store
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

const mockApi = createStoreCascadesMockApi()
// The preload session bridge, delivered to the real runtime's renderer-close handler.
const closeTerminalSurface = vi.fn()
Object.assign(mockApi, { session: { closeTerminalSurface } })

const REPO_ID = 'repo-local'
const PROJECT_ID = 'project-fixture'
const ENV = 'env-1'
const HOST = `runtime:${ENV}`
const OWNER_SETUP = 'owner-setup'
const OWNER_HANDLE = 'term-owner-1'
const OWNER_INCARNATION = 'owner-incarnation-1'
const OWNER_TAB = 'owner-tab-1'
const ORDINARY_TAB = 'tab-local'
const ORDINARY_LEAF = 'leaf-local'
const GROUP = 'group-1'
const REMOTE_PTY = `remote:${ENV}@@${OWNER_HANDLE}`

type OwnerCall = { destination: string; method: string; payload: unknown }
type OwnerHooks = Pick<Fixture, 'ownerCalls' | 'onOwnerCreate' | 'ownerReply'>

type Fixture = {
  directory: string
  worktreeId: string
  store: Store
  /** The real SQLite profile behind `store`, able to fail its next write like a full disk. */
  authority: DelayedAuthority
  runtime: OrcaRuntimeService
  /** Every call that reached an owner, with the environment it was sent to. */
  ownerCalls: OwnerCall[]
  onOwnerCreate: (() => void | Promise<void>) | null
  /** Extra members of the owner's created terminal, such as a reattach or adoption. */
  ownerReply: Record<string, unknown>
  /** A version-skewed main whose reply this renderer cannot trust. */
  rewriteReply: ((reply: unknown) => unknown) | null
}

const directories: string[] = []
const fixtures: Fixture[] = []

beforeEach(() => {
  mocks.callRuntimeRpc.mockReset()
  closeTerminalSurface.mockReset()
  vi.spyOn(RuntimeMachineName.prototype, 'start').mockImplementation(() => {})
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.store.flushPendingOrThrowAsync().catch(() => {})
    await fixture.store.freezeWritesAsync().catch(() => {})
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

/** A local session the way the window last saved it: one ordinary terminal in one group. */
function localSession(worktreeId: string, revision: 'positive' | 'absent'): WorkspaceSessionState {
  const session: WorkspaceSessionState = {
    activeRepoId: REPO_ID,
    activeWorktreeId: worktreeId,
    activeTabId: ORDINARY_TAB,
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: ORDINARY_TAB,
          ptyId: 'pty-local',
          worktreeId,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [ORDINARY_TAB]: {
        root: { type: 'leaf', leafId: ORDINARY_LEAF },
        activeLeafId: ORDINARY_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [ORDINARY_LEAF]: 'pty-local' }
      }
    },
    unifiedTabs: {
      [worktreeId]: [
        {
          id: ORDINARY_TAB,
          entityId: ORDINARY_TAB,
          groupId: GROUP,
          worktreeId,
          contentType: 'terminal',
          label: 'Terminal 1',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      [worktreeId]: [{ id: GROUP, worktreeId, activeTabId: ORDINARY_TAB, tabOrder: [ORDINARY_TAB] }]
    },
    tabGroupLayouts: { [worktreeId]: { type: 'leaf', groupId: GROUP } },
    activeGroupIdByWorktree: { [worktreeId]: GROUP }
  }
  // Prime's frozen voyager document carries no topology revision map at all.
  return revision === 'positive'
    ? { ...session, terminalTopologyRevisionByRepoId: { [REPO_ID]: 2 } }
    : session
}

function ownerTransport(fixture: OwnerHooks) {
  const call = vi.fn<OrchestrationEnvironmentTransport['call']>(
    async (destination, method, payload) => {
      fixture.ownerCalls.push({ destination, method, payload })
      if (method === 'projectHostSetup.list') {
        return {
          id: 'r',
          ok: true,
          result: {
            setups: [
              {
                id: OWNER_SETUP,
                projectId: PROJECT_ID,
                hostId: 'local',
                setupState: 'ready',
                path: '/owner/project'
              }
            ]
          },
          _meta: { runtimeId: 'owner-runtime' }
        }
      }
      if (method === 'terminal.create') {
        await fixture.onOwnerCreate?.()
        return {
          id: 'r',
          ok: true,
          result: {
            terminal: {
              handle: OWNER_HANDLE,
              worktreeId: 'owner-worktree',
              title: null,
              tabId: OWNER_TAB,
              paneKey: `${OWNER_TAB}:owner-leaf`,
              incarnationId: OWNER_INCARNATION,
              ...fixture.ownerReply
            }
          },
          _meta: { runtimeId: 'owner-runtime' }
        }
      }
      return { id: 'r', ok: true, result: { closed: true }, _meta: { runtimeId: 'owner-runtime' } }
    }
  )
  return {
    call,
    resolve: () => ({
      environmentId: ENV,
      pairingRevision: 1,
      name: 'Owner',
      peerFingerprint: 'peer'
    })
  }
}

/** `openTopologyStore`, keeping its authority so a test can fail one durable write. */
async function openStore(directory: string, seed: string) {
  const inner = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'topology')
  inner.writeSerializedState(Buffer.from(seed))
  const authority = new DelayedAuthority(inner)
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: authority
  })
  await store.flushPendingOrThrowAsync()
  return { store, authority }
}

async function createFixture(revision: 'positive' | 'absent'): Promise<Fixture> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-persist-on-create-')))
  directories.push(directory)
  const repoPath = join(directory, 'source')
  execFileSync('git', ['init', '-q', repoPath])
  const worktreeId = `${REPO_ID}::${repoPath}`
  const state = getDefaultPersistedState(join(directory, 'home'))
  state.repos = [
    { id: REPO_ID, path: repoPath, displayName: 'Source', badgeColor: '#737373', addedAt: 1 }
  ]
  state.projects = [
    {
      id: PROJECT_ID,
      displayName: 'Fixture project',
      badgeColor: '#737373',
      sourceRepoIds: [REPO_ID],
      createdAt: 1,
      updatedAt: 1
    }
  ]
  state.projectHostSetups = [
    {
      id: 'local-setup',
      projectId: PROJECT_ID,
      hostId: 'local',
      repoId: REPO_ID,
      path: repoPath,
      displayName: 'Source',
      setupState: 'ready',
      setupMethod: 'imported-existing-folder',
      createdAt: 1,
      updatedAt: 1
    }
  ]
  // The source worktree's ownership, as discovery records it for a set-up local checkout.
  state.worktreeMeta = {
    [worktreeId]: {
      instanceId: 'instance-local',
      projectId: PROJECT_ID,
      hostId: 'local',
      projectHostSetupId: 'local-setup',
      displayName: 'Source',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1,
      createdAt: 1
    }
  }
  state.workspaceSession = localSession(worktreeId, revision)
  state.workspaceSessionsByHostId = {}
  const { store, authority } = await openStore(directory, JSON.stringify(state))
  const partial: OwnerHooks = { ownerCalls: [], onOwnerCreate: null, ownerReply: {} }
  const runtime = new OrcaRuntimeService(store, undefined, {
    orchestrationEnvironmentTransport: ownerTransport(partial)
  })
  const fixture: Fixture = {
    directory,
    worktreeId,
    store,
    runtime,
    authority,
    ownerCalls: partial.ownerCalls,
    rewriteReply: null,
    get onOwnerCreate() {
      return partial.onOwnerCreate
    },
    set onOwnerCreate(value) {
      partial.onOwnerCreate = value
    },
    get ownerReply() {
      return partial.ownerReply
    },
    set ownerReply(value) {
      partial.ownerReply = value
    }
  }
  fixtures.push(fixture)
  seedRenderer(fixture)
  routeRpc(fixture)
  return fixture
}

/** The window as hydrated from that session: the same ordinary tab, group and worktree. */
function seedRenderer(fixture: Fixture): void {
  const store = createTestStore()
  const worktreeId = fixture.worktreeId
  const session = fixture.store.getWorkspaceSession()
  seedStore(store, {
    repos: [
      {
        id: REPO_ID,
        path: worktreeId.slice(REPO_ID.length + 2),
        displayName: 'Source',
        badgeColor: '#737373',
        addedAt: 1,
        executionHostId: 'local'
      }
    ],
    worktreesByRepo: {
      [REPO_ID]: [
        makeWorktree({
          id: worktreeId,
          repoId: REPO_ID,
          path: worktreeId.slice(REPO_ID.length + 2)
        })
      ]
    },
    tabsByWorktree: session.tabsByWorktree,
    terminalLayoutsByTabId: session.terminalLayoutsByTabId,
    unifiedTabsByWorktree: session.unifiedTabs ?? {},
    groupsByWorktree: session.tabGroups ?? {},
    layoutByWorktree: session.tabGroupLayouts ?? {},
    activeGroupIdByWorktree: session.activeGroupIdByWorktree ?? {}
  })
  mocks.store = store
}

/** The renderer's RPC client, delivered in-process: local calls reach the real RPC handler. */
function routeRpc(fixture: Fixture): void {
  const methods = eraseRpcMethods(TERMINAL_METHODS)
  mocks.callRuntimeRpc.mockImplementation(
    async (target: { kind: string; environmentId?: string }, method: string, params: unknown) => {
      if (target.kind === 'local') {
        const entry = methods.find((candidate) => candidate.name === method)
        if (!entry) {
          throw new Error(`unrouted local method ${method}`)
        }
        const reply = await entry.handler(
          TerminalCreateParams.parse(params),
          { runtime: fixture.runtime },
          vi.fn()
        )
        return fixture.rewriteReply ? fixture.rewriteReply(reply) : reply
      }
      fixture.ownerCalls.push({
        destination: target.environmentId ?? target.kind,
        method: `renderer:${method}`,
        payload: params
      })
      return { closed: true }
    }
  )
  closeTerminalSurface.mockImplementation((args) =>
    fixture.runtime.closeTerminalSurfaceFromRenderer(args)
  )
}

async function applyRendererSave(fixture: Fixture): Promise<void> {
  const state = mocks.store!.getState()
  const patch = buildWorkspaceSessionPatch(state, SESSION_RELEVANT_FIELDS)
  await patchWorkspaceSessionByHost(
    {
      get: async (hostId) => fixture.store.getWorkspaceSession(hostId),
      patch: async (args, hostId) => fixture.store.patchWorkspaceSession(args, hostId)
    },
    patch,
    state
  ).written
}

async function readDisk(fixture: Fixture): Promise<WorkspaceSessionState> {
  const reopened = await reopenTopologyStore(fixture.store, fixture.directory)
  fixture.store = reopened
  return reopened.getWorkspaceSession()
}

function stampedRow(session: WorkspaceSessionState, worktreeId: string, tabId: string) {
  return {
    tab: session.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId),
    unified: session.unifiedTabs?.[worktreeId]?.find((tab) => tab.id === tabId),
    layout: session.terminalLayoutsByTabId[tabId]
  }
}

function expectAdmittedStampedTab(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string
): void {
  const { tab, unified, layout } = stampedRow(session, worktreeId, tabId)
  // Soft, so a baseline run reports each missing piece rather than only the first.
  expect.soft(tab, 'local tab row').toBeDefined()
  expect
    .soft(unified, 'stamped unified tab')
    .toMatchObject({ executionHostId: HOST, projectHostSetupId: OWNER_SETUP })
  const leafId = Object.keys(layout?.ptyIdsByLeafId ?? {})[0]
  expect.soft(layout?.ptyIdsByLeafId?.[leafId ?? ''], 'remote binding').toBe(REMOTE_PTY)
  expect
    .soft(
      session.terminalPtyIncarnationsByPaneKey?.[makePaneKey(tabId, leafId ?? '')],
      'owner incarnation'
    )
    .toBe(OWNER_INCARNATION)
  // Owner identities never become local ones.
  expect.soft(JSON.stringify(session.tabsByWorktree), 'no owner tab id').not.toContain(OWNER_TAB)
}

function expectNoGhost(session: WorkspaceSessionState, worktreeId: string): void {
  expect(session.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([ORDINARY_TAB])
  expect(Object.keys(session.terminalLayoutsByTabId)).toEqual([ORDINARY_TAB])
  expect(JSON.stringify(session)).not.toContain(OWNER_SETUP)
  expect(JSON.stringify(session)).not.toContain(REMOTE_PTY)
}

const ownerCloses = (fixture: Fixture) =>
  fixture.ownerCalls.filter((call) => call.method.endsWith('terminal.close'))

/** The loaded session, before any create: the absent fixture has no revision map at all. */
function expectLoadedRevision(fixture: Fixture, revision: 'positive' | 'absent'): void {
  const session = fixture.store.getWorkspaceSession()
  if (revision === 'absent') {
    expect(Object.hasOwn(session, 'terminalTopologyRevisionByRepoId')).toBe(false)
  } else {
    expect(session.terminalTopologyRevisionByRepoId?.[REPO_ID]).toBeGreaterThan(0)
  }
}

const createOnHost = (fixture: Fixture) =>
  createTerminalTabOnHost({
    worktreeId: fixture.worktreeId,
    groupId: GROUP,
    executionHostId: HOST,
    projectHostSetupId: OWNER_SETUP
  })

/** The tab main admitted for this create, which the window has not drawn yet. */
function admittedTabId(fixture: Fixture): string | undefined {
  const tabs = fixture.store.getWorkspaceSession().tabsByWorktree[fixture.worktreeId] ?? []
  return tabs.find((tab) => tab.id !== ORDINARY_TAB)?.id
}

/** Main's copy and, after the window's save and a cold reload, the disk both hold no trace. */
async function expectNoGhostAnywhere(fixture: Fixture): Promise<void> {
  // Main's commit of each close the window sent, not just the send.
  await Promise.all(closeTerminalSurface.mock.results.map((result) => result.value))
  expectNoGhost(fixture.store.getWorkspaceSession(), fixture.worktreeId)
  await applyRendererSave(fixture)
  expectNoGhost(await readDisk(fixture), fixture.worktreeId)
}

const OWNER_CLOSE: OwnerCall = {
  destination: ENV,
  method: 'terminal.close',
  payload: { terminal: OWNER_HANDLE, expectedIncarnationId: OWNER_INCARNATION }
}
const RENDERER_OWNER_CLOSE: OwnerCall = {
  destination: ENV,
  method: 'renderer:terminal.close',
  payload: { terminal: OWNER_HANDLE }
}

// The contract's only non-created shapes (`runtime-terminal-contracts.ts`): a reattach, an adoption.
const CREATED_REPLIES = [
  ['no disposition', {}],
  ['created', { agentSessionDisposition: 'created' }]
] as const
const NON_CREATED_REPLIES = [
  ['a reattach', { isReattach: true }],
  ['an adopted session', { agentSessionDisposition: 'adopted' }],
  ['an adopted reattach', { isReattach: true, agentSessionDisposition: 'adopted' }]
] as const

describe.each(['positive', 'absent'] as const)(
  'host terminal create persists locally (topology revision %s)',
  (revision) => {
    it('main holds the stamped tab and its owner binding before any renderer save', async () => {
      const fixture = await createFixture(revision)
      expectLoadedRevision(fixture, revision)
      const created = await createOnHost(fixture)
      expect(created).toEqual({ status: 'created', tabId: expect.any(String) })
      const tabId = created.status === 'created' ? created.tabId : ''
      expectAdmittedStampedTab(fixture.store.getWorkspaceSession(), fixture.worktreeId, tabId)
    })

    it('keeps the stamped tab on disk through the renderer save and a cold reload', async () => {
      const fixture = await createFixture(revision)
      expectLoadedRevision(fixture, revision)
      const created = await createOnHost(fixture)
      const tabId = created.status === 'created' ? created.tabId : ''
      await applyRendererSave(fixture)
      const disk = await readDisk(fixture)
      expectAdmittedStampedTab(disk, fixture.worktreeId, tabId)
      expect(disk.tabsByWorktree[fixture.worktreeId]?.map((tab) => tab.id)).toContain(ORDINARY_TAB)
      expect(ownerCloses(fixture)).toEqual([])
    })
  }
)

describe('host terminal create failure leaves no local ghost', () => {
  it('withdraws nothing it never wrote when the owner refuses the setup', async () => {
    const fixture = await createFixture('positive')
    const created = await createTerminalTabOnHost({
      worktreeId: fixture.worktreeId,
      groupId: GROUP,
      executionHostId: HOST,
      projectHostSetupId: 'missing-setup'
    })
    expect(created.status).toBe('refused')
    await applyRendererSave(fixture)
    expectNoGhost(await readDisk(fixture), fixture.worktreeId)
    expect(fixture.ownerCalls.map((call) => call.method)).not.toContain('terminal.create')
  })

  // Deferred with N2/R4: refusing or deduplicating a create whose local ids already name a pane.
  it.todo('refuses a create whose local ids are already a pane, before asking the owner')

  describe.each(['positive', 'absent'] as const)('topology revision %s', (revision) => {
    describe('binding refused because the window closed the admitted tab while the owner answered', () => {
      const closeAdmittedTab = (fixture: Fixture) => async () => {
        const tabId = admittedTabId(fixture)
        expect(tabId, 'admitted tab before the owner answers').toBeDefined()
        await fixture.runtime.closeTerminalSurfaceFromRenderer({
          worktreeId: fixture.worktreeId,
          target: { kind: 'tab', tabId: tabId ?? '' },
          reason: 'cleanup'
        })
      }

      it.each(CREATED_REPLIES)(
        'closes exactly the new owner terminal at its environment (%s)',
        async (_label, reply) => {
          const fixture = await createFixture(revision)
          fixture.ownerReply = reply
          fixture.onOwnerCreate = closeAdmittedTab(fixture)
          const created = await createOnHost(fixture)
          expect(created.status).toBe('refused')
          expect(ownerCloses(fixture)).toEqual([OWNER_CLOSE])
          await expectNoGhostAnywhere(fixture)
        }
      )

      it.each(NON_CREATED_REPLIES)('closes no owner terminal for %s', async (_label, reply) => {
        const fixture = await createFixture(revision)
        fixture.ownerReply = reply
        fixture.onOwnerCreate = closeAdmittedTab(fixture)
        const created = await createOnHost(fixture)
        expect(created.status).toBe('refused')
        expect(ownerCloses(fixture)).toEqual([])
        await expectNoGhostAnywhere(fixture)
      })
    })

    describe('binding write rejected by a failing disk while the owner answered', () => {
      // The next durable write after the owner replies is main's binding of the returned PTY.
      const failBindingWrite = (fixture: Fixture) => () => {
        fixture.authority.failNextWrite()
      }

      it.each(CREATED_REPLIES)(
        'closes exactly the new owner terminal at its environment (%s)',
        async (_label, reply) => {
          const fixture = await createFixture(revision)
          fixture.ownerReply = reply
          fixture.onOwnerCreate = failBindingWrite(fixture)
          const created = await createOnHost(fixture)
          expect(created).toMatchObject({ status: 'refused', refusal: { code: 'create_failed' } })
          expect(ownerCloses(fixture)).toEqual([OWNER_CLOSE])
          await expectNoGhostAnywhere(fixture)
        }
      )

      it.each(NON_CREATED_REPLIES)('closes no owner terminal for %s', async (_label, reply) => {
        const fixture = await createFixture(revision)
        fixture.ownerReply = reply
        fixture.onOwnerCreate = failBindingWrite(fixture)
        const created = await createOnHost(fixture)
        expect(created).toMatchObject({ status: 'refused', refusal: { code: 'create_failed' } })
        expect(ownerCloses(fixture)).toEqual([])
        await expectNoGhostAnywhere(fixture)
      })

      it("fails main's create with the write's own error, not a binding refusal", async () => {
        const fixture = await createFixture(revision)
        fixture.onOwnerCreate = failBindingWrite(fixture)
        await expect(
          fixture.runtime.createTerminalOnHost({
            worktree: `id:${fixture.worktreeId}`,
            executionHostId: HOST,
            projectHostSetupId: OWNER_SETUP,
            presentation: 'background'
          })
        ).rejects.toThrow('profile_state_write_failed')
        expect(ownerCloses(fixture)).toEqual([OWNER_CLOSE])
        await expectNoGhostAnywhere(fixture)
      })
    })

    describe('source worktree gone while the owner answers', () => {
      const dropSource = () => {
        mocks.store!.setState({ worktreesByRepo: { [REPO_ID]: [] } })
      }

      it.each(CREATED_REPLIES)(
        'adopts the tab and closes it once through the native close at its owner (%s)',
        async (_label, reply) => {
          const fixture = await createFixture(revision)
          fixture.ownerReply = reply
          fixture.onOwnerCreate = dropSource
          const created = await createOnHost(fixture)
          expect(created.status).toBe('refused')
          await vi.waitFor(() => expect(closeTerminalSurface).toHaveBeenCalledTimes(1))
          expect(
            mocks.store!.getState().unifiedTabsByWorktree[fixture.worktreeId]?.map((tab) => tab.id)
          ).toEqual([ORDINARY_TAB])
          await vi.waitFor(() => expect(ownerCloses(fixture)).toEqual([RENDERER_OWNER_CLOSE]))
          await expectNoGhostAnywhere(fixture)
          expect(ownerCloses(fixture)).toEqual([RENDERER_OWNER_CLOSE])
        }
      )

      // Off the owner contract, so only a version-skewed main could hand the window these.
      it.each([
        ['a null disposition', { agentSessionDisposition: null }],
        ['an unknown disposition', { agentSessionDisposition: 'other' }],
        ['a false reattach flag', { isReattach: false }]
      ])(
        'withdraws membership only and closes no owner terminal for %s',
        async (_label, members) => {
          const fixture = await createFixture(revision)
          fixture.rewriteReply = (reply) => {
            const parsed = z.object({ terminal: z.record(z.string(), z.unknown()) }).parse(reply)
            return { terminal: { ...parsed.terminal, ...members } }
          }
          fixture.onOwnerCreate = dropSource
          const created = await createOnHost(fixture)
          expect(created.status).toBe('refused')
          await vi.waitFor(() => expect(closeTerminalSurface).toHaveBeenCalledTimes(1))
          await expectNoGhostAnywhere(fixture)
          expect(ownerCloses(fixture)).toEqual([])
        }
      )

      it.each(NON_CREATED_REPLIES)(
        'withdraws membership only and closes no owner terminal for %s',
        async (_label, reply) => {
          const fixture = await createFixture(revision)
          fixture.ownerReply = reply
          fixture.onOwnerCreate = dropSource
          const created = await createOnHost(fixture)
          expect(created.status).toBe('refused')
          await vi.waitFor(() => expect(closeTerminalSurface).toHaveBeenCalledTimes(1))
          await expectNoGhostAnywhere(fixture)
          expect(ownerCloses(fixture)).toEqual([])
        }
      )
    })

    describe('reply this window cannot trust', () => {
      const terminalOf = (reply: unknown) =>
        z.object({ terminal: z.record(z.string(), z.unknown()) }).parse(reply).terminal
      const UNTRUSTED = [
        // An older main's reply that names no host: nothing in it identifies an owner to close.
        [
          'names no host',
          (reply: unknown) => {
            const { executionHostId: _dropped, ...terminal } = terminalOf(reply)
            return { terminal }
          }
        ],
        [
          'names a different host',
          (reply: unknown) => ({
            terminal: { ...terminalOf(reply), executionHostId: 'runtime:env-2' }
          })
        ],
        [
          'binds a PTY at a different owner',
          (reply: unknown) => ({
            terminal: { ...terminalOf(reply), ptyId: `remote:env-2@@${OWNER_HANDLE}` }
          })
        ]
      ] as const

      it.each(UNTRUSTED)(
        'withdraws membership only and closes no owner terminal when it %s',
        async (_label, rewrite) => {
          const fixture = await createFixture(revision)
          fixture.rewriteReply = rewrite
          const created = await createOnHost(fixture)
          expect(created).toEqual({
            status: 'refused',
            refusal: { code: 'invalid_host_reply', executionHostId: HOST }
          })
          await vi.waitFor(() => expect(closeTerminalSurface).toHaveBeenCalledTimes(1))
          await expectNoGhostAnywhere(fixture)
          expect(ownerCloses(fixture)).toEqual([])
        }
      )
    })
  })
})
