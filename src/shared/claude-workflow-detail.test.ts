import { describe, expect, it, vi } from 'vitest'
import {
  readClaudeWorkflowDetail,
  type ClaudeWorkflowDetailReaderIo,
  type ClaudeWorkflowDetailTarget
} from './claude-workflow-detail'

function target(overrides: Partial<ClaudeWorkflowDetailTarget> = {}): ClaudeWorkflowDetailTarget {
  return {
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'repo::/repo/work',
    connectionId: null,
    worktreePath: '/repo/work',
    state: 'working',
    prompt: 'Implement feature',
    updatedAt: 1000,
    stateStartedAt: 900,
    stateHistory: [],
    agentType: 'claude',
    selectors: { transcriptPath: '/repo/work/.claude/transcript.jsonl' },
    ...overrides
  }
}

function io(files: Record<string, string>): ClaudeWorkflowDetailReaderIo {
  return {
    readPreview: vi.fn(async (filePath: string, maxBytes: number) => {
      const content = files[filePath] ?? ''
      const truncated = Buffer.byteLength(content, 'utf8') > maxBytes
      return {
        content: truncated ? content.slice(0, maxBytes) : content,
        bytesRead: Math.min(Buffer.byteLength(content, 'utf8'), maxBytes),
        truncated,
        mtimeMs: 123
      }
    }),
    stat: vi.fn(async () => ({ mtimeMs: 123, size: 10 }))
  }
}

describe('readClaudeWorkflowDetail', () => {
  it('skips malformed transcript lines and returns bounded parsed detail', async () => {
    const detail = await readClaudeWorkflowDetail(
      target(),
      io({
        '/repo/work/.claude/transcript.jsonl': [
          '{"timestamp":"2026-05-30T10:00:00Z","message":{"usage":{"input_tokens":3,"output_tokens":4},"content":[{"type":"tool_use","id":"tool-1","name":"Task","input":{"description":"Research agent","prompt":"Find context"}}]}}',
          'not json',
          '{"timestamp":"2026-05-30T10:01:00Z","tool_use_id":"tool-1","content":"done"}'
        ].join('\n')
      })
    )

    expect(detail.summaryOnly).toBe(false)
    expect(detail.agents[0]).toMatchObject({ id: 'tool-1', label: 'Research agent', state: 'done' })
    expect(detail.metrics?.totalTokens).toBe(7)
    expect(detail.warnings.some((warning) => warning.includes('malformed'))).toBe(true)
  })

  it('rejects renderer-supplied paths outside the owning worktree', async () => {
    const reader = io({ '/tmp/outside.jsonl': '{}' })
    const detail = await readClaudeWorkflowDetail(
      target({ selectors: { transcriptPath: '/tmp/outside.jsonl' } }),
      reader
    )

    expect(detail.summaryOnly).toBe(true)
    expect(reader.readPreview).not.toHaveBeenCalled()
    expect(detail.warnings.join('\n')).toContain('outside')
  })

  it('handles Windows drive-letter containment without POSIX slash assumptions', async () => {
    const reader = io({ 'C:\\repo\\work\\.claude\\transcript.jsonl': '{}' })
    const detail = await readClaudeWorkflowDetail(
      target({
        worktreeId: 'repo::C:\\repo\\work',
        worktreePath: 'C:\\repo\\work',
        selectors: { transcriptPath: 'C:\\repo\\work\\.claude\\transcript.jsonl' }
      }),
      reader
    )

    expect(detail.summaryOnly).toBe(false)
    expect(reader.readPreview).toHaveBeenCalled()
  })

  it('hides binary-looking script previews and reports truncation', async () => {
    const detail = await readClaudeWorkflowDetail(
      target({
        selectors: {
          transcriptPath: '/repo/work/.claude/transcript.jsonl',
          scriptPath: '/repo/work/generated.js'
        }
      }),
      io({
        '/repo/work/.claude/transcript.jsonl': '{}',
        '/repo/work/generated.js': `\0${'x'.repeat(40_000)}`
      })
    )

    expect(detail.scriptPreview?.binary).toBe(true)
    expect(detail.scriptPreview?.content).toBe('')
    expect(detail.warnings.join('\n')).toContain('binary')
  })

  it('returns summary-only detail for unsupported remote reads', async () => {
    const detail = await readClaudeWorkflowDetail(target({ connectionId: 'ssh-1' }), null)

    expect(detail.summaryOnly).toBe(true)
    expect(detail.source).toBe('remote-unsupported')
    expect(detail.warnings.join('\n')).toContain('Remote workflow detail reads are not supported')
  })
})
