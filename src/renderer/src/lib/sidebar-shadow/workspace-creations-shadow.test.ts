import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestCreationFromHost } from './host-creation-requests'
import { workspaceCreationsShadow } from './workspace-creations-shadow'
import type { SidebarShadowMismatch } from './sidebar-shadow-comparison'

function hostListing(creations: Record<string, { repoId: string; worktreeId?: string }>): void {
  vi.stubGlobal('window', {
    api: {
      runtime: { call: vi.fn(async () => ({ ok: true, result: { revision: 1, creations } })) }
    }
  })
}

async function settledMismatches(): Promise<SidebarShadowMismatch[]> {
  const mismatches: SidebarShadowMismatch[] = []
  // A disagreement counts once it holds across two checks.
  await workspaceCreationsShadow((mismatch) => mismatches.push(mismatch))
  await workspaceCreationsShadow((mismatch) => mismatches.push(mismatch))
  return mismatches
}

describe('workspaceCreationsShadow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('agrees while the host lists the request in flight, and ignores creations others asked for', async () => {
    let release: () => void = () => {}
    const request = requestCreationFromHost(
      { creationId: 'agree-1', repoId: 'repo-1' },
      () => new Promise<void>((resolve) => (release = resolve))
    )
    hostListing({ 'agree-1': { repoId: 'repo-1' }, 'phone-1': { repoId: 'repo-2' } })

    expect(await settledMismatches()).toEqual([])
    release()
    await request
  })

  it('flags a request the host never listed and a host entry that outlived its request', async () => {
    let release: () => void = () => {}
    const unlisted = requestCreationFromHost(
      { creationId: 'unlisted-1', repoId: 'repo-1' },
      () => new Promise<void>((resolve) => (release = resolve))
    )
    await requestCreationFromHost({ creationId: 'leaked-1', repoId: 'repo-1' }, async () => {})
    hostListing({ 'leaked-1': { repoId: 'repo-1' } })

    const mismatches = await settledMismatches()
    expect(mismatches.map(({ key, window, main }) => ({ key, window, main }))).toEqual([
      { key: 'unlisted-1', window: 'repo-1', main: null },
      { key: 'leaked-1', window: null, main: 'repo-1' }
    ])
    release()
    await unlisted
  })
})
