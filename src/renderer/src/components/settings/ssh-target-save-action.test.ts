// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), success: vi.fn() }))
vi.mock('./managed-ssh-host-create', () => ({ createManagedSshHost: mocks.create }))
vi.mock('sonner', () => ({ toast: { success: mocks.success } }))
import { saveSshTargetForm } from './ssh-target-save-action'

const target = { label: 'Builder', host: 'builder', port: 22, username: 'dev' }
const payload = { target, updates: { label: 'Renamed' } }

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ssh: { updateTarget: mocks.update } }
  })
})

describe('SSH target form submission', () => {
  it('retains the same provisioning id after a lost response', async () => {
    mocks.create.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(undefined)
    const request = { current: null as string | null }
    await expect(saveSshTargetForm(null, payload, request)).rejects.toThrow('response lost')
    const firstId = request.current
    expect(firstId).toBeTruthy()
    await saveSshTargetForm(null, payload, request)
    expect(mocks.create.mock.calls).toEqual([
      [firstId, target],
      [firstId, target]
    ])
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('keeps edits on the existing target without provisioning another server', async () => {
    const request = { current: null }
    await saveSshTargetForm('ssh-existing', payload, request)
    expect(mocks.update).toHaveBeenCalledWith({ id: 'ssh-existing', updates: payload.updates })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(request.current).toBeNull()
    expect(mocks.success).toHaveBeenCalledOnce()
  })
})
