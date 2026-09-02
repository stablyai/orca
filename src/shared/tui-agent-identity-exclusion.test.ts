import { describe, expect, it, vi } from 'vitest'
import {
  excludeMisidentifiedAgents,
  identityProbeKeepsAgent,
  serializeIdentityExclusion,
  type SerializedIdentityExclusion
} from './tui-agent-identity-exclusion'

const BOB_EXCLUSION: SerializedIdentityExclusion = serializeIdentityExclusion({
  args: ['--help'],
  excludePattern: /\bneo\s?vim\b|\bnvim\b/i,
  requirePattern: /Bob in your terminal|\bIBM\b|\bbob ?shell\b/i
})

const COMMANDS = [
  { id: 'claude', cmd: 'claude' },
  { id: 'bob', cmd: 'bob', identityExclusion: BOB_EXCLUSION }
]

describe('serializeIdentityExclusion', () => {
  it('round-trips patterns through JSON so a relay can rebuild them', () => {
    const wire = JSON.parse(JSON.stringify(BOB_EXCLUSION)) as SerializedIdentityExclusion
    expect(identityProbeKeepsAgent(wire, { stdout: 'A version manager for Neovim' })).toBe(false)
    expect(identityProbeKeepsAgent(wire, { stdout: 'Bob in your terminal' })).toBe(true)
    expect(identityProbeKeepsAgent(wire, { stdout: 'usage: bob <target>' })).toBe(false)
  })

  it('reads stderr as well as stdout', () => {
    expect(identityProbeKeepsAgent(BOB_EXCLUSION, { stdout: '', stderr: 'IBM license' })).toBe(true)
  })
})

describe('excludeMisidentifiedAgents', () => {
  it('only probes commands that declare an exclusion', async () => {
    const probe = vi.fn(async () => ({ stdout: 'Bob in your terminal', stderr: '' }))

    await expect(
      excludeMisidentifiedAgents(COMMANDS, ['claude', 'bob'], new Set(['claude', 'bob']), probe)
    ).resolves.toEqual(['claude', 'bob'])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith('bob', ['--help'])
  })

  it('drops an agent whose probe output names the unrelated tool', async () => {
    const probe = vi.fn(async () => ({ stdout: 'A version manager for Neovim', stderr: '' }))

    await expect(
      excludeMisidentifiedAgents(COMMANDS, ['bob'], new Set(['bob']), probe)
    ).resolves.toEqual([])
  })

  it('keeps an agent whose probe rejects', async () => {
    const probe = vi.fn(async () => {
      throw new Error('spawn ENOENT')
    })

    await expect(
      excludeMisidentifiedAgents(COMMANDS, ['bob'], new Set(['bob']), probe)
    ).resolves.toEqual(['bob'])
  })

  it('skips the probe when the exclusion-bearing command was not the one found', async () => {
    // Why: an alias entry without an exclusion may be the actual hit; probing a
    // command that was never found would only fail open anyway.
    const probe = vi.fn(async () => ({ stdout: 'A version manager for Neovim', stderr: '' }))

    await expect(
      excludeMisidentifiedAgents(COMMANDS, ['bob'], new Set(['bob-alias']), probe)
    ).resolves.toEqual(['bob'])
    expect(probe).not.toHaveBeenCalled()
  })
})
