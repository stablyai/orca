import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalSummary } from '../../../shared/runtime-types'
import {
  indexLiveTerminalSurfaceOwners,
  readWorktreeLiveTerminalSurfaceOwners
} from './worktree-live-terminal-surface-owners'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

function summary(overrides: Partial<RuntimeTerminalSummary>): RuntimeTerminalSummary {
  return {
    handle: 'term-1',
    ptyId: `${WORKTREE_ID}@@live-agent`,
    worktreeId: WORKTREE_ID,
    worktreePath: '/worktree',
    branch: 'main',
    tabId: 'tab-live',
    leafId: LEAF_ID,
    title: 'Codex',
    connected: true,
    writable: true,
    lastOutputAt: 1,
    preview: '',
    ...overrides
  }
}

function stubTerminalList(result: unknown): void {
  vi.stubGlobal('window', {
    api: { runtime: { call: vi.fn(async () => ({ ok: true, result })) } }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('live terminal surface owners', () => {
  it('records the exact pane the host binds a live PTY to', () => {
    const owners = indexLiveTerminalSurfaceOwners([summary({})], WORKTREE_ID)

    expect(owners.get(`${WORKTREE_ID}@@live-agent`)).toEqual({
      paneKey: `tab-live:${LEAF_ID}`,
      ptyId: `${WORKTREE_ID}@@live-agent`,
      tabId: 'tab-live'
    })
  })

  it('leaves an orphaned PTY absent so it stays eligible for a recovery tab', () => {
    const ptyId = `${WORKTREE_ID}@@orphan`
    const owners = indexLiveTerminalSurfaceOwners(
      [
        summary({
          ptyId,
          orphaned: true,
          tabId: `pty:${ptyId}`,
          leafId: `pty:${ptyId}`
        })
      ],
      WORKTREE_ID
    )

    expect(owners.has(ptyId)).toBe(false)
  })

  it('ignores rows belonging to another workspace', () => {
    const owners = indexLiveTerminalSurfaceOwners(
      [summary({ worktreeId: 'repo::/other' })],
      WORKTREE_ID
    )

    expect(owners.size).toBe(0)
  })

  // Dropping the host's row over path spelling would read as `unowned` and mint a duplicate.
  it('indexes a row the host spelled with an equivalent workspace path', () => {
    const owners = indexLiveTerminalSurfaceOwners(
      [summary({ worktreeId: `${WORKTREE_ID}/` })],
      WORKTREE_ID
    )

    expect(owners.get(`${WORKTREE_ID}@@live-agent`)?.tabId).toBe('tab-live')
  })

  it('reports a PTY claimed by two panes as unverifiable rather than unowned', () => {
    const ptyId = `${WORKTREE_ID}@@live-agent`
    const owners = indexLiveTerminalSurfaceOwners(
      [summary({}), summary({ handle: 'term-2', leafId: OTHER_LEAF_ID })],
      WORKTREE_ID
    )

    expect(owners.has(ptyId)).toBe(true)
    expect(owners.get(ptyId)).toBeNull()
  })

  it('reports an unaddressable surface as unverifiable rather than unowned', () => {
    const ptyId = `${WORKTREE_ID}@@live-agent`
    const owners = indexLiveTerminalSurfaceOwners([summary({ leafId: 'legacy-0' })], WORKTREE_ID)

    expect(owners.has(ptyId)).toBe(true)
    expect(owners.get(ptyId)).toBeNull()
  })

  it('refuses a census whose own execution host never answered', async () => {
    stubTerminalList({
      terminals: [],
      truncated: false,
      hostScope: { hostIds: [], omittedHostIds: ['local', 'ssh:box'] }
    })

    await expect(readWorktreeLiveTerminalSurfaceOwners(WORKTREE_ID)).resolves.toBeNull()
  })

  it('indexes a scoped census that omits the hosts of other workspaces', async () => {
    stubTerminalList({
      terminals: [summary({})],
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:box-1'] }
    })

    const owners = await readWorktreeLiveTerminalSurfaceOwners(WORKTREE_ID)

    expect(owners?.get(`${WORKTREE_ID}@@live-agent`)?.tabId).toBe('tab-live')
  })

  it('refuses a census from a host that cannot name the scope it answered for', async () => {
    stubTerminalList({ terminals: [summary({})], truncated: false })

    await expect(readWorktreeLiveTerminalSurfaceOwners(WORKTREE_ID)).resolves.toBeNull()
  })

  it('refuses a truncated census', async () => {
    stubTerminalList({
      terminals: [summary({})],
      truncated: true,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    })

    await expect(readWorktreeLiveTerminalSurfaceOwners(WORKTREE_ID)).resolves.toBeNull()
  })

  it('indexes a complete census', async () => {
    stubTerminalList({
      terminals: [summary({})],
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    })

    const owners = await readWorktreeLiveTerminalSurfaceOwners(WORKTREE_ID)

    expect(owners?.get(`${WORKTREE_ID}@@live-agent`)?.tabId).toBe('tab-live')
  })

  it('refuses a census the host could not answer', async () => {
    vi.stubGlobal('window', {
      api: { runtime: { call: vi.fn(async () => ({ ok: false, error: { message: 'nope' } })) } }
    })

    await expect(readWorktreeLiveTerminalSurfaceOwners(WORKTREE_ID)).resolves.toBeNull()
  })
})
