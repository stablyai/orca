import { describe, expect, it, vi } from 'vitest'
import { filterOpenCodeDetectedIds } from './opencode-cli-detection'
import { classifyOpenCodeCliGeneration } from './opencode-cli-generation'

describe('filterOpenCodeDetectedIds', () => {
  it('reports only the v2 id on a v2-only machine', async () => {
    // The reported case: opencode v2 declares BOTH bins, so name-only detection
    // yields both ids, but the version says v2.
    const probe = vi.fn().mockResolvedValue('v2')
    await expect(filterOpenCodeDetectedIds(['opencode', 'opencode2'], probe)).resolves.toEqual([
      'opencode2'
    ])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('keeps the v1 id for a genuine v1 install', async () => {
    const probe = vi.fn().mockResolvedValue('v1')
    await expect(filterOpenCodeDetectedIds(['opencode', 'opencode2'], probe)).resolves.toEqual([
      'opencode',
      'opencode2'
    ])
  })

  it('never suppresses the v2 id, so a mixed install keeps opencode2', async () => {
    // `opencode2` exists only in the v2 package; dropping it could hide a
    // genuine opencode2 behind a v1 `opencode`.
    const probe = vi.fn().mockResolvedValue('v1')
    await expect(filterOpenCodeDetectedIds(['opencode2'], probe)).resolves.toEqual(['opencode2'])
    await expect(filterOpenCodeDetectedIds(['opencode', 'opencode2'], probe)).resolves.toContain(
      'opencode2'
    )
  })

  it('does not probe when only one opencode id is present', async () => {
    const probe = vi.fn().mockResolvedValue('v1')
    await expect(filterOpenCodeDetectedIds(['opencode'], probe)).resolves.toEqual(['opencode'])
    await expect(filterOpenCodeDetectedIds(['opencode2'], probe)).resolves.toEqual(['opencode2'])
    expect(probe).not.toHaveBeenCalled()
  })

  it('collapses an unknown probe to opencode2, not the v1 false positive', async () => {
    // Probe failure is not proof of v1; #24987 is a v2-only machine misreported
    // as v1, so unknown must not reproduce that.
    const probe = vi.fn().mockResolvedValue(null)
    await expect(filterOpenCodeDetectedIds(['opencode', 'opencode2'], probe)).resolves.toEqual([
      'opencode2'
    ])
  })

  it('leaves unrelated agents untouched', async () => {
    const probe = vi.fn()
    const detected = ['claude', 'codex', 'opencode', 'opencode2', 'cursor']
    await expect(filterOpenCodeDetectedIds(detected, probe)).resolves.toEqual([
      'claude',
      'codex',
      'opencode2',
      'cursor'
    ])
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('relay wiring of the shared filter', () => {
  it('classifies the relay `--version` output through the same contract', () => {
    // Guards the seam: classify is what the relay variant delegates to.
    expect(classifyOpenCodeCliGeneration('opencode v2.0.22')).toBe('v2')
    expect(classifyOpenCodeCliGeneration('1.18.34')).toBe('v1')
  })
})
