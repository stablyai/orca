import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineRecord } from '../../../../shared/machine-inventory'
import { waitForCreatedMachine } from './machine-start'

const PROVIDER = 'plugin:omarchy/omarchy' as const

function record(state: MachineRecord['state']): MachineRecord {
  return {
    id: 'box-old',
    name: 'feature',
    lifetime: 'persistent',
    state,
    createdAt: '2026-10-01T00:00:00.000Z',
    providerKey: PROVIDER,
    lastSeenAt: 0
  }
}

const get = vi.fn()
const noDelay = (): Promise<void> => Promise.resolve()

beforeEach(() => {
  get.mockReset()
  vi.stubGlobal('window', { api: { machines: { get } } })
})

describe('waitForCreatedMachine', () => {
  it('re-reads an adopted machine still being created until it runs', async () => {
    get
      .mockResolvedValueOnce({ ok: true, value: record('creating') })
      .mockResolvedValueOnce({ ok: true, value: record('running') })

    const settled = await waitForCreatedMachine(record('creating'), () => false, noDelay)

    expect(get).toHaveBeenCalledTimes(2)
    expect(settled).toEqual({ ok: true, value: record('running') })
  })

  it('hands a machine that already runs straight back', async () => {
    const settled = await waitForCreatedMachine(record('running'), () => false, noDelay)
    expect(get).not.toHaveBeenCalled()
    expect(settled?.ok).toBe(true)
  })

  it('stops when the create is canceled, and reports a failed read', async () => {
    expect(await waitForCreatedMachine(record('creating'), () => true, noDelay)).toBeNull()
    get.mockResolvedValueOnce({ ok: false, code: 'unavailable', message: 'down' })
    const failed = await waitForCreatedMachine(record('creating'), () => false, noDelay)
    expect(failed).toMatchObject({ ok: false, detail: 'down' })
  })
})
