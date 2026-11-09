import { beforeEach, describe, expect, it } from 'vitest'
import {
  closeMoveToThisComputer,
  cloudWorkspaceMovedAt,
  getCloudMoveState,
  noteCloudWorkspaceMoved,
  openMoveToThisComputer,
  setCloudMoveState
} from './orca-cloud-move-store'

describe('move to this computer store', () => {
  beforeEach(() => setCloudMoveState({ stage: 'closed' }))

  it('opens on confirm and closes', () => {
    openMoveToThisComputer('ws', 'fix-auth')
    expect(getCloudMoveState()).toEqual({ stage: 'confirm', workspaceId: 'ws', name: 'fix-auth' })
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
      totalBytes: null
    })
    openMoveToThisComputer('other', 'b')
    closeMoveToThisComputer()
    expect(getCloudMoveState()).toMatchObject({ stage: 'running', workspaceId: 'ws' })
  })

  it('remembers when a workspace was moved', () => {
    const items = new Map<string, string>()
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value)
      }
    }
    expect(cloudWorkspaceMovedAt('never-moved')).toBeNull()
    noteCloudWorkspaceMoved('ws', 1_800_000_000_000)
    expect(cloudWorkspaceMovedAt('ws')).toBe(1_800_000_000_000)
  })
})
