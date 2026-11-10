import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeMoveToThisComputer,
  cloudWorkspaceMoved,
  getCloudMoveState,
  noteCloudWorkspaceMoved,
  openMoveToThisComputer,
  setCloudMoveState
} from './orca-cloud-move-store'

describe('move to this computer store', () => {
  beforeEach(() => setCloudMoveState({ stage: 'closed' }))
  afterEach(() => vi.unstubAllGlobals())

  it('opens on confirm and closes', () => {
    openMoveToThisComputer('ws', 'fix-auth')
    expect(getCloudMoveState()).toMatchObject({
      stage: 'confirm',
      workspaceId: 'ws',
      name: 'fix-auth',
      archiveAfter: null
    })
    closeMoveToThisComputer()
    expect(getCloudMoveState().stage).toBe('closed')
  })

  it('never interrupts a move in flight', () => {
    setCloudMoveState({
      stage: 'running',
      workspaceId: 'ws',
      name: 'a',
      step: 'packing',
      skipped: ['waking'],
      startedAt: 1,
      bytes: null,
      totalBytes: null,
      archiveAfter: false,
      hidden: false
    })
    openMoveToThisComputer('other', 'b')
    closeMoveToThisComputer()
    expect(getCloudMoveState()).toMatchObject({ stage: 'running', workspaceId: 'ws' })
  })

  it('remembers when a workspace was moved', () => {
    const items = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value)
      }
    })
    expect(cloudWorkspaceMoved('never-moved')).toBeNull()
    noteCloudWorkspaceMoved('ws', 1_800_000_000_000, 'local-1')
    expect(cloudWorkspaceMoved('ws')).toEqual({ at: 1_800_000_000_000, localWorktreeId: 'local-1' })
    items.set('orca-cloud-moved-at:old', '1700000000000')
    expect(cloudWorkspaceMoved('old')).toEqual({ at: 1_700_000_000_000, localWorktreeId: null })
  })
})
