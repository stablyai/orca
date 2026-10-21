import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decommissionConvertedHost } from './orcad-convert-teardown'

const owned = { environmentId: 'managed-test', targetId: 'test-ssh', worktreeId: 'test-worktree' }

function fixture() {
  const order: string[] = []
  const list = vi.fn<
    () => Promise<{ id: string; orcadDeployment: { sshTargetId: string; kind?: string } }[]>
  >(async () => [
    { id: 'unrelated', orcadDeployment: { sshTargetId: 'another-target' } },
    { id: owned.environmentId, orcadDeployment: { sshTargetId: owned.targetId } }
  ])
  const close = vi.fn<(args: unknown) => Promise<unknown>>(async () => {
    order.push('close')
    return { ok: true, result: { closed: 1, stopped: 1, retiredSurfaces: true } }
  })
  const stop = vi.fn<(args: unknown) => Promise<unknown>>(async () => {
    order.push('stop')
    return {
      outcome: 'unlinked',
      verdict: 'exited',
      environmentId: owned.environmentId,
      sshTargetId: owned.targetId
    }
  })
  const rendererWindow = {
    api: { runtimeEnvironments: { list, call: close, managedOrcad: { stop } } }
  }
  vi.stubGlobal('window', rendererWindow)
  return { list, close, stop, order, rendererWindow }
}

afterEach(() => vi.unstubAllGlobals())

describe('converted host fixture teardown', () => {
  it('closes the owned remote workspace before requesting instance-bound decommission', async () => {
    const { close, stop, order } = fixture()
    await expect(decommissionConvertedHost(owned)).resolves.toMatchObject({
      outcome: 'unlinked',
      verdict: 'exited'
    })
    expect(close).toHaveBeenCalledWith({
      selector: owned.environmentId,
      method: 'terminal.closeAll',
      params: { worktree: `id:${owned.worktreeId}` },
      timeoutMs: 120_000
    })
    expect(stop).toHaveBeenCalledWith({ selector: owned.environmentId })
    expect(order).toEqual(['close', 'stop'])
  })

  it('runs the serialized renderer callback without test-process closures', async () => {
    const { rendererWindow } = fixture()
    const callback: unknown = runInNewContext(`(${decommissionConvertedHost.toString()})`, {
      window: rendererWindow
    })
    if (typeof callback !== 'function') {
      throw new Error('Serialized renderer callback was not a function')
    }
    await expect(callback(owned)).resolves.toMatchObject({ outcome: 'unlinked', verdict: 'exited' })
  })

  it.each(['missing', 'different-target', 'wsl', 'duplicate'])(
    'refuses %s ownership',
    async (kind) => {
      const { list, close, stop } = fixture()
      const correct = { id: owned.environmentId, orcadDeployment: { sshTargetId: owned.targetId } }
      list.mockResolvedValue(
        kind === 'missing'
          ? []
          : kind === 'different-target'
            ? [{ ...correct, orcadDeployment: { sshTargetId: 'another-target' } }]
            : kind === 'wsl'
              ? [{ ...correct, orcadDeployment: { ...correct.orcadDeployment, kind: 'wsl' } }]
              : [correct, correct]
      )
      await expect(decommissionConvertedHost(owned)).rejects.toThrow('verify its environment')
      expect(close).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
    }
  )

  it.each([
    { ok: false, error: { code: 'disconnected' } },
    { ok: true, result: null },
    { ok: true, result: { retiredSurfaces: false } },
    { ok: true, result: { retiredSurfaces: true, ptyStopVerdict: 'live' } },
    { ok: true, result: { retiredSurfaces: true, ptyStopVerdict: 'unverifiable' } }
  ])('keeps the server when workspace stop is not proven: %j', async (response) => {
    const { close, stop } = fixture()
    close.mockResolvedValue(response)
    await expect(decommissionConvertedHost(owned)).rejects.toThrow('terminal stop was not proven')
    expect(stop).not.toHaveBeenCalled()
  })

  it.each(['live', 'unverifiable'])('never calls %s decommission a success', async (verdict) => {
    const { stop } = fixture()
    stop.mockResolvedValue({ outcome: 'refused', verdict, code: 'not-stopped' })
    await expect(decommissionConvertedHost(owned)).rejects.toThrow(`"verdict":"${verdict}"`)
  })

  it.each(['environmentId', 'sshTargetId'])(
    'refuses a stop receipt for another %s',
    async (field) => {
      const { stop } = fixture()
      stop.mockResolvedValue({
        outcome: 'unlinked',
        verdict: 'exited',
        environmentId: owned.environmentId,
        sshTargetId: owned.targetId,
        [field]: 'unrelated'
      })
      await expect(decommissionConvertedHost(owned)).rejects.toThrow('decommission was not proven')
    }
  )

  it('refuses before closing any terminal when the desktop API is missing', async () => {
    const { list, close } = fixture()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { list, call: close } } })
    await expect(decommissionConvertedHost(owned)).rejects.toThrow('desktop managed server API')
    expect(close).not.toHaveBeenCalled()
  })

  it('preserves loss of contact as a failed observation', async () => {
    const { stop } = fixture()
    stop.mockRejectedValue(new Error('host unreachable'))
    await expect(decommissionConvertedHost(owned)).rejects.toThrow('host unreachable')
  })
})
