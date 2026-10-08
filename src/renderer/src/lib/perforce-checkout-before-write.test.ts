import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerforceSaveBehavior } from '../../../shared/perforce/perforce-settings'
import {
  PERFORCE_EDIT_DECLINED_MESSAGE,
  checkoutPerforceFileBeforeWrite
} from './perforce-checkout-before-write'

type State = {
  behavior: PerforceSaveBehavior
  isPerforce: boolean
  readOnly: boolean
  answer: boolean
  calls: string[]
}

const state = vi.hoisted((): State => ({
  behavior: 'ask',
  isPerforce: true,
  readOnly: true,
  answer: true,
  calls: []
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: { perforce: { saveReadOnlyBehavior: state.behavior } } })
  }
}))
vi.mock('./perforce-workspace-target', () => ({
  perforceTargetForFile: async () =>
    state.isPerforce ? { settings: null, worktreeId: 'wt', worktreePath: '/ws' } : null
}))
vi.mock('./perforce-open-for-edit-prompt', () => ({
  askToOpenForEdit: async (path: string) => {
    state.calls.push(`ask:${path}`)
    return state.answer
  }
}))
vi.mock('../runtime/runtime-perforce-client', () => ({
  runPerforceOperation: async (
    _target: unknown,
    operation: string,
    params: { filePath: string }
  ) => {
    state.calls.push(`${operation}:${params.filePath}`)
    return operation === 'isReadOnlyFile' ? state.readOnly : undefined
  }
}))

const CONTEXT = { settings: null, worktreeId: 'wt', worktreePath: '/ws' }

beforeEach(() => {
  state.behavior = 'ask'
  state.isPerforce = true
  state.readOnly = true
  state.answer = true
  state.calls = []
})

describe('checkoutPerforceFileBeforeWrite', () => {
  it('asks, then opens a read-only Perforce file for edit before the write', async () => {
    await checkoutPerforceFileBeforeWrite(CONTEXT, '/ws/Assets/a.cs')
    expect(state.calls).toEqual([
      'isReadOnlyFile:Assets/a.cs',
      'ask:Assets/a.cs',
      'checkoutIfReadOnly:Assets/a.cs'
    ])
  })

  it('cancels the save when the user declines', async () => {
    state.answer = false
    await expect(checkoutPerforceFileBeforeWrite(CONTEXT, '/ws/a.cs')).rejects.toThrow(
      PERFORCE_EDIT_DECLINED_MESSAGE
    )
    expect(state.calls).toEqual(['isReadOnlyFile:a.cs', 'ask:a.cs'])
  })

  it('opens without asking when set to, and stays out of the way when set to never', async () => {
    state.behavior = 'auto'
    await checkoutPerforceFileBeforeWrite(CONTEXT, '/ws/a.cs')
    expect(state.calls).toEqual(['isReadOnlyFile:a.cs', 'checkoutIfReadOnly:a.cs'])
    state.calls = []
    state.behavior = 'never'
    await checkoutPerforceFileBeforeWrite(CONTEXT, '/ws/a.cs')
    expect(state.calls).toEqual([])
  })

  it('leaves writable files and files outside any Perforce workspace alone', async () => {
    state.readOnly = false
    await checkoutPerforceFileBeforeWrite(CONTEXT, '/ws/a.cs')
    expect(state.calls).toEqual(['isReadOnlyFile:a.cs'])
    state.calls = []
    state.isPerforce = false
    await checkoutPerforceFileBeforeWrite(CONTEXT, '/elsewhere/a.cs')
    expect(state.calls).toEqual([])
  })
})
