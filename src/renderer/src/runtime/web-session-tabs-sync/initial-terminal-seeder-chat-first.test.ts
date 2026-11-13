// CLOUD-CHAT-FIRST-TAB (END-PASS n51): an Orca Cloud create whose first agent opens as a chat got a
// second plain "Terminal" tab, in front: the mirror's first empty frame saw no terminal tabs (a chat
// is not one) and seeded a shell. A chat now counts as the workspace's first surface, and the create
// holds the seeder off while its chat launches.
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const value: {
    tabsByWorktree: Record<string, unknown[]>
    unifiedTabsByWorktree: Record<string, { id: string; contentType: string }[]>
    owner: string
  } = { tabsByWorktree: {}, unifiedTabsByWorktree: {}, owner: 'runtime:env-vm' }
  return value
})
vi.mock('../../store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => state.owner
}))
vi.mock('./frame-drawn-server-workspace-set', () => ({ isFrameDrawnServerWorkspace: () => false }))
vi.mock('./initial-terminal/web-runtime-initial-terminal-bootstrap-dispatch', () => ({
  dispatchWebRuntimeInitialTerminalBootstrap: async () => true
}))

const { createInitialTerminalSeeder } = await import('./initial-terminal-seeder')
const { claimFirstSurfaceForStructuredCreate } =
  await import('@/lib/workspace/creation/structured-create-first-surface-claim')
const { resetWebRuntimeInitialTerminalBootstrapForTests } =
  await import('./initial-terminal/web-runtime-initial-terminal-bootstrap')

const WT = 'wt-cloud'
// The host's first published answer: the workspace has no tabs yet.
const emptyFrame = {
  type: 'snapshot',
  worktree: WT,
  tabs: [],
  publicationEpoch: 'epoch-1'
} as const
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the decision reads only type, worktree, tabs and publicationEpoch
const frame = emptyFrame as unknown as Parameters<
  ReturnType<typeof createInitialTerminalSeeder>['decide']
>[0]

afterEach(() => {
  state.tabsByWorktree = {}
  state.unifiedTabsByWorktree = {}
  state.owner = 'runtime:env-vm'
  resetWebRuntimeInitialTerminalBootstrapForTests()
})

describe('the initial-terminal seeder beside a first chat', () => {
  it('an empty new workspace still gets its shell', () => {
    expect(createInitialTerminalSeeder('env-vm', WT).decide(frame, true)).toBe(true)
  })

  it('a workspace whose first tab is a chat gets no shell beside it', () => {
    state.unifiedTabsByWorktree[WT] = [{ id: 'agent-session:s1', contentType: 'agent-session' }]
    expect(createInitialTerminalSeeder('env-vm', WT).decide(frame, true)).toBe(false)
  })

  it('a non-chat unified tab (an editor) does not count as the first surface', () => {
    state.unifiedTabsByWorktree[WT] = [{ id: 'editor:1', contentType: 'editor' }]
    expect(createInitialTerminalSeeder('env-vm', WT).decide(frame, true)).toBe(true)
  })
})

describe('claimFirstSurfaceForStructuredCreate', () => {
  it('holds the seeder off while the chat launches, and lets go once it has answered', () => {
    const release = claimFirstSurfaceForStructuredCreate(WT)
    // The chat tab is not there yet: the empty frame must not seed a shell.
    expect(createInitialTerminalSeeder('env-vm', WT).decide(frame, true)).toBe(false)
    release()
    // A launch that opened nothing gets its shell after all.
    expect(createInitialTerminalSeeder('env-vm', WT).decide(frame, true)).toBe(true)
    // Releasing twice is harmless.
    release()
  })

  it('a create on this machine claims nothing', () => {
    state.owner = 'local'
    const release = claimFirstSurfaceForStructuredCreate(WT)
    expect(createInitialTerminalSeeder('env-vm', WT).decide(frame, true)).toBe(true)
    release()
  })

  it('a claim someone else holds is left to them', () => {
    const first = claimFirstSurfaceForStructuredCreate(WT)
    const second = claimFirstSurfaceForStructuredCreate(WT)
    second()
    expect(createInitialTerminalSeeder('env-vm', WT).decide(frame, true)).toBe(false)
    first()
  })
})
