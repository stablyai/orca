import { describe, expect, it, vi } from 'vitest'
import { localPerforceBackend } from './perforce-backend'
import {
  PERFORCE_OPERATION_NAMES,
  PERFORCE_WORKSPACE_OPERATIONS,
  isPerforceOperationName,
  dispatchPerforceOperation
} from './perforce-operations'

const OK = { success: true as const, output: '' }

describe('Perforce operation table', () => {
  it('names every operation, and only those', () => {
    expect([...PERFORCE_OPERATION_NAMES].sort()).toEqual(
      Object.keys(PERFORCE_WORKSPACE_OPERATIONS).sort()
    )
    expect(isPerforceOperationName('status')).toBe(true)
    expect(isPerforceOperationName('toString')).toBe(false)
    expect(isPerforceOperationName(42)).toBe(false)
  })

  it('refuses an unknown operation before touching the backend', async () => {
    await expect(
      dispatchPerforceOperation(localPerforceBackend, 'constructor', '/ws', {})
    ).rejects.toThrow('Unknown Perforce operation')
  })

  it('validates arguments once, for every transport, before calling the backend', async () => {
    const open = vi.fn(async () => OK)
    const backend = { ...localPerforceBackend, open }
    await expect(
      dispatchPerforceOperation(backend, 'open', '/ws', { filePaths: ['../outside'] })
    ).rejects.toThrow('escapes')
    expect(open).not.toHaveBeenCalled()
    await dispatchPerforceOperation(backend, 'open', '/ws', { filePaths: ['a.cs'] })
    expect(open).toHaveBeenCalledWith('/ws', ['a.cs'])
  })

  it('caps history and lets a changelist be created without files', async () => {
    const history = vi.fn(async () => [])
    const createChangelist = vi.fn(async () => ({ ...OK, changelist: 7 }))
    const backend = { ...localPerforceBackend, history, createChangelist }
    await dispatchPerforceOperation(backend, 'history', '/ws', { limit: 5000 })
    await dispatchPerforceOperation(backend, 'history', '/ws', {})
    expect(history.mock.calls).toEqual([
      ['/ws', 200],
      ['/ws', 30]
    ])
    await dispatchPerforceOperation(backend, 'createChangelist', '/ws', {
      description: ' Fix spawn ',
      filePaths: []
    })
    expect(createChangelist).toHaveBeenCalledWith('/ws', 'Fix spawn', [])
    for (const filePaths of [null, 'a.cs', undefined]) {
      await expect(
        dispatchPerforceOperation(backend, 'createChangelist', '/ws', {
          description: 'x',
          filePaths
        })
      ).rejects.toThrow('Expected a list of files')
    }
    expect(createChangelist).toHaveBeenCalledOnce()
  })

  it('asks for a description only when submitting the default changelist', async () => {
    const submit = vi.fn(async () => OK)
    const backend = { ...localPerforceBackend, submit }
    await expect(
      dispatchPerforceOperation(backend, 'submit', '/ws', { changelist: 'default', message: ' ' })
    ).rejects.toThrow('Submit description is required')
    await dispatchPerforceOperation(backend, 'submit', '/ws', { changelist: 12 })
    expect(submit).toHaveBeenCalledWith('/ws', 12, undefined)
  })
})
