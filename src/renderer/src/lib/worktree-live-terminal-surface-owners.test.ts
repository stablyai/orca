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

function stubTerminalList(result: unknown) {
  const call = vi.fn(async () => ({ ok: true, result }))
  vi.stubGlobal('window', {
    api: { runtime: { call } }
  })
  return call
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

  it('records explicit live orphan evidence for a recovery tab', () => {
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

    expect(owners.get(ptyId)).toBe('unowned')
  })

  it('does not authorize adoption of a disconnected orphan', () => {
    const ptyId = `${WORKTREE_ID}@@orphan`
    const owners = indexLiveTerminalSurfaceOwners(
      [summary({ ptyId, orphaned: true, connected: false })],
      WORKTREE_ID
    )

    expect(owners.get(ptyId)).toBeNull()
  })

  it('does not infer orphan ownership from a legacy synthetic surface', () => {
    const ptyId = `${WORKTREE_ID}@@orphan`
    const owners = indexLiveTerminalSurfaceOwners(
      [summary({ ptyId, tabId: `pty:${ptyId}`, leafId: `pty:${ptyId}` })],
      WORKTREE_ID
    )

    expect(owners.get(ptyId)).toBeNull()
  })

  it.each([false, true])(
    'rejects conflicting owned and orphan rows (orphan first: %s)',
    (orphanFirst) => {
      const orphan = summary({ orphaned: true })
      const owned = summary({})
      const owners = indexLiveTerminalSurfaceOwners(
        orphanFirst ? [orphan, owned, orphan] : [owned, orphan, owned],
        WORKTREE_ID
      )

      expect(owners.get(owned.ptyId!)).toBeNull()
    }
  )

  it('ignores rows belonging to another workspace', () => {
    const owners = indexLiveTerminalSurfaceOwners(
      [summary({ worktreeId: 'repo::/other' })],
      WORKTREE_ID
    )

    expect(owners.size).toBe(0)
  })

  it('indexes a row the host spelled with an equivalent workspace path', () => {
    const owners = indexLiveTerminalSurfaceOwners(
      [summary({ worktreeId: `${WORKTREE_ID}/` })],
      WORKTREE_ID
    )

    expect(owners.get(`${WORKTREE_ID}@@live-agent`)).toMatchObject({ tabId: 'tab-live' })
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

    expect(owners?.get(`${WORKTREE_ID}@@live-agent`)).toMatchObject({ tabId: 'tab-live' })
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
    const call = stubTerminalList({
      terminals: [summary({})],
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    })

    const owners = await readWorktreeLiveTerminalSurfaceOwners(WORKTREE_ID)

    expect(owners?.get(`${WORKTREE_ID}@@live-agent`)).toMatchObject({ tabId: 'tab-live' })
    expect(call).toHaveBeenCalledWith({
      method: 'terminal.list',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        limit: 200,
        requireFreshPtyLiveness: true,
        includeVisualLayouts: false
      }
    })
  })

  it('refuses a census the host could not answer', async () => {
    vi.stubGlobal('window', {
      api: { runtime: { call: vi.fn(async () => ({ ok: false, error: { message: 'nope' } })) } }
    })

    await expect(readWorktreeLiveTerminalSurfaceOwners(WORKTREE_ID)).resolves.toBeNull()
  })
})
