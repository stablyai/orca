import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareContinuationSourceForTarget } from './continuation-handoff'
import type { AgentSessionContinuationSource } from '@/lib/agent-session-continuation'

const prepareSessionHandoff = vi.fn()

vi.stubGlobal('window', { api: { aiVault: { prepareSessionHandoff } } })

const SOURCE: AgentSessionContinuationSource = {
  sourceAgent: 'claude',
  capturedText: 'user: keep going',
  transcriptPath: '/home/marabel/.claude/projects/orca/session.jsonl'
}

const ORIGIN = {
  agent: 'claude',
  sessionId: 'abc-123',
  transcriptPath: '/home/marabel/.claude/projects/orca/session.jsonl',
  executionHostId: 'local' as const
}

const HOST_LABELS = { sourceHostLabel: 'Local Mac', targetHostLabel: 'Hetzner VPS' }

describe('prepareContinuationSourceForTarget', () => {
  beforeEach(() => {
    prepareSessionHandoff.mockReset()
  })

  it('leaves a same-host handoff untouched', async () => {
    const result = await prepareContinuationSourceForTarget({
      source: SOURCE,
      origin: ORIGIN,
      bridge: { kind: 'same-host' },
      targetExecutionHostId: 'local',
      ...HOST_LABELS
    })
    expect(result).toEqual({ kind: 'ready', source: SOURCE, degradedToDigest: false })
    expect(prepareSessionHandoff).not.toHaveBeenCalled()
  })

  it('repoints the transcript at its copy on the target host', async () => {
    prepareSessionHandoff.mockResolvedValue({
      kind: 'transferred',
      transcriptPath: '/root/.orca/handoffs/claude-abc-123.jsonl',
      byteLength: 2048
    })
    const result = await prepareContinuationSourceForTarget({
      source: SOURCE,
      origin: ORIGIN,
      bridge: { kind: 'transfer', sourceConnectionId: null, targetConnectionId: 'hetzner' },
      targetExecutionHostId: 'ssh:hetzner',
      ...HOST_LABELS
    })
    expect(result).toEqual({
      kind: 'ready',
      degradedToDigest: false,
      source: {
        ...SOURCE,
        transcriptPath: '/root/.orca/handoffs/claude-abc-123.jsonl',
        hostChange: { fromLabel: 'Local Mac', toLabel: 'Hetzner VPS' }
      }
    })
  })

  it('inlines the transcript tail when the file was too large to move', async () => {
    prepareSessionHandoff.mockResolvedValue({
      kind: 'digest',
      text: 'assistant: nearly done',
      byteLength: 90_000_000,
      omittedBytes: 89_000_000
    })
    const result = await prepareContinuationSourceForTarget({
      source: SOURCE,
      origin: ORIGIN,
      bridge: { kind: 'transfer', sourceConnectionId: null, targetConnectionId: 'hetzner' },
      targetExecutionHostId: 'ssh:hetzner',
      ...HOST_LABELS
    })
    expect(result).toMatchObject({
      kind: 'ready',
      degradedToDigest: true,
      source: {
        transcriptPath: null,
        capturedText: 'assistant: nearly done',
        capturedTextKind: 'transcript-tail'
      }
    })
  })

  it('surfaces a failed transfer instead of launching with a dead path', async () => {
    prepareSessionHandoff.mockResolvedValue({ kind: 'failed', reason: 'target-unavailable' })
    const result = await prepareContinuationSourceForTarget({
      source: SOURCE,
      origin: ORIGIN,
      bridge: { kind: 'transfer', sourceConnectionId: null, targetConnectionId: 'hetzner' },
      targetExecutionHostId: 'ssh:hetzner',
      ...HOST_LABELS
    })
    expect(result.kind).toBe('failed')
  })

  it('still continues with the preview when there is no stored transcript to move', async () => {
    const result = await prepareContinuationSourceForTarget({
      source: SOURCE,
      origin: { ...ORIGIN, transcriptPath: null },
      bridge: { kind: 'transfer', sourceConnectionId: null, targetConnectionId: 'hetzner' },
      targetExecutionHostId: 'ssh:hetzner',
      ...HOST_LABELS
    })
    expect(result).toMatchObject({
      kind: 'ready',
      degradedToDigest: true,
      source: { transcriptPath: null, capturedText: 'user: keep going' }
    })
    expect(prepareSessionHandoff).not.toHaveBeenCalled()
  })

  it('asks for text delivery when the target accepts no file, and never blocks', async () => {
    prepareSessionHandoff.mockResolvedValue({
      kind: 'digest',
      text: 'assistant: still going',
      byteLength: 4096,
      omittedBytes: 0
    })
    const result = await prepareContinuationSourceForTarget({
      source: SOURCE,
      origin: ORIGIN,
      bridge: { kind: 'inline', content: 'transcript-tail' },
      targetExecutionHostId: 'runtime:builder',
      ...HOST_LABELS
    })
    expect(prepareSessionHandoff).toHaveBeenCalledWith(expect.objectContaining({ deliver: 'text' }))
    expect(result).toMatchObject({
      kind: 'ready',
      source: { transcriptPath: null, capturedTextKind: 'transcript-tail' }
    })
  })

  it('falls back to the preview for a source whose transcript cannot be read', async () => {
    const result = await prepareContinuationSourceForTarget({
      source: SOURCE,
      origin: ORIGIN,
      bridge: { kind: 'inline', content: 'preview' },
      targetExecutionHostId: 'local',
      ...HOST_LABELS
    })
    expect(prepareSessionHandoff).not.toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'ready', source: { transcriptPath: null } })
  })
})
