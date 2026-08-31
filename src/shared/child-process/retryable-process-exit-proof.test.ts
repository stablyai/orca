import { describe, expect, it, vi } from 'vitest'

import { RetryableProcessExitProof } from './retryable-process-exit-proof'

describe('RetryableProcessExitProof', () => {
  it('shares a concurrent attempt and retains proven exit', async () => {
    const proof = new RetryableProcessExitProof()
    const proveExit = vi.fn(async () => true)

    const first = proof.run(proveExit)
    const concurrent = proof.run(proveExit)

    await expect(Promise.all([first, concurrent])).resolves.toEqual([true, true])
    await expect(proof.run(proveExit)).resolves.toBe(true)
    expect(proveExit).toHaveBeenCalledOnce()
  })

  it('permits another attempt after exit was not proven', async () => {
    const proof = new RetryableProcessExitProof()
    const proveExit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(proof.run(proveExit)).resolves.toBe(false)
    await expect(proof.run(proveExit)).resolves.toBe(true)
    expect(proveExit).toHaveBeenCalledTimes(2)
  })

  it('permits another attempt after proof rejects', async () => {
    const proof = new RetryableProcessExitProof()
    const proveExit = vi
      .fn()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValue(true)

    await expect(proof.run(proveExit)).rejects.toThrow('probe failed')
    await expect(proof.run(proveExit)).resolves.toBe(true)
  })
})
