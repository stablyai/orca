// @vitest-environment happy-dom
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SubagentRawTranscriptBar, SubagentTranscriptViewer } from './SubagentTranscriptViewer'

describe('SubagentTranscriptViewer', () => {
  const sampleJsonl = [
    JSON.stringify({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Fix bug in auth service' }]
      }
    }),
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Analyzing auth service logic...' },
          { type: 'tool_use', name: 'run_command', input: { CommandLine: 'pnpm test' } }
        ]
      }
    })
  ].join('\n')

  it('renders subagent transcript steps correctly', () => {
    render(
      <SubagentTranscriptViewer
        content={sampleJsonl}
        filePath="/Users/test/.claude/projects/proj/subagents/agent-123.jsonl"
      />
    )

    expect(screen.getByText('Fix bug in auth service')).toBeDefined()
    expect(screen.getByText(/run_command/)).toBeDefined()
  })

  it('toggles thinking step expansion', () => {
    render(
      <SubagentTranscriptViewer
        content={sampleJsonl}
        filePath="/Users/test/.claude/projects/proj/subagents/agent-123.jsonl"
      />
    )

    const filterButtons = screen.getAllByRole('button')
    const thinkingFilterBtn = filterButtons.find(
      (btn) => btn.getAttribute('title') === 'Toggle Thinking Steps'
    )
    expect(thinkingFilterBtn).toBeDefined()
    if (thinkingFilterBtn) {
      fireEvent.click(thinkingFilterBtn)
    }

    expect(screen.getByText(/Analyzing auth service logic/)).toBeDefined()
  })

  it('triggers raw mode toggle callback when clicked', () => {
    const onToggleRawMode = vi.fn()
    render(
      <SubagentTranscriptViewer
        content={sampleJsonl}
        filePath="/Users/test/.claude/projects/proj/subagents/agent-123.jsonl"
        onToggleRawMode={onToggleRawMode}
      />
    )

    const rawBtn = screen.getByTitle('Switch to Raw JSONL Monaco Editor')
    fireEvent.click(rawBtn)

    expect(onToggleRawMode).toHaveBeenCalledTimes(1)
  })
})

describe('SubagentRawTranscriptBar', () => {
  it('returns to the transcript view from raw mode', () => {
    const onToggleRawMode = vi.fn()
    // Why: this suite renders without cleanup between cases, so scope the query
    // to this render instead of the shared document body.
    const { container } = render(
      <SubagentRawTranscriptBar
        filePath="/Users/test/.claude/projects/proj/subagents/agent-123.jsonl"
        onToggleRawMode={onToggleRawMode}
      />
    )
    const bar = within(container)

    expect(bar.getByText('agent-123.jsonl')).toBeDefined()
    fireEvent.click(bar.getByTitle('Back to the subagent transcript view'))

    expect(onToggleRawMode).toHaveBeenCalledTimes(1)
  })
})
