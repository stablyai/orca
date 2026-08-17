// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { AGENT_TOOL_STEP_DWELL_MS } from '@/hooks/use-settled-agent-tool-step'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PANE_KEY = 'tab-1:leaf-1'

function cursorAgentRow(toolName: string, toolInput: string): DashboardAgentRowData {
  return {
    paneKey: PANE_KEY,
    tab: { id: 'tab-1', worktreeId: 'wt-1' },
    agentType: 'cursor',
    rowSource: 'live',
    state: 'working',
    startedAt: 1000,
    entry: {
      prompt: 'Refactor the intake flow',
      state: 'working',
      paneKey: PANE_KEY,
      updatedAt: 1000,
      stateStartedAt: 1000,
      stateHistory: [],
      agentType: 'cursor',
      toolName,
      toolInput
    }
  } as unknown as DashboardAgentRowData
}

let container: HTMLDivElement
let root: Root

function renderRow(agent: DashboardAgentRowData): void {
  act(() => {
    root.render(
      <CompactAgentRow agent={agent} now={2000} onActivate={vi.fn()} cacheTimerActive={false} />
    )
  })
}

function rowText(): string {
  return container.querySelector('.compact-agent-row')?.textContent?.trim() ?? ''
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

describe('compact sidebar agent row tool-step flicker (#11075)', () => {
  it('does not repaint the row on every hook while a cursor turn runs', () => {
    renderRow(cursorAgentRow('Read', 'src/a.ts'))
    const settled = rowText()
    expect(settled).toContain('Read: src/a.ts')

    // A cursor turn emits pre/post tool hooks several times a second. Every one
    // of these rewrote the row's single truncated line before the fix.
    const burst: [string, string][] = [
      ['Grep', 'TODO'],
      ['Edit', 'src/b.ts'],
      ['Bash', 'pnpm test'],
      ['Read', 'src/c.ts']
    ]
    for (const [toolName, toolInput] of burst) {
      act(() => {
        vi.advanceTimersByTime(60)
      })
      renderRow(cursorAgentRow(toolName, toolInput))
      expect(rowText()).toBe(settled)
    }

    act(() => {
      vi.advanceTimersByTime(AGENT_TOOL_STEP_DWELL_MS)
    })
    // The newest step lands; 'Grep: TODO', 'Edit: src/b.ts', and 'Bash: pnpm test'
    // were never painted at all.
    expect(rowText()).toContain('Read: src/c.ts')
  })

  it('keeps the prompt visible the whole time', () => {
    renderRow(cursorAgentRow('Read', 'src/a.ts'))
    for (const [toolName, toolInput] of [
      ['Grep', 'TODO'],
      ['Edit', 'src/b.ts']
    ] as [string, string][]) {
      act(() => {
        vi.advanceTimersByTime(60)
      })
      renderRow(cursorAgentRow(toolName, toolInput))
      expect(rowText()).toContain('Refactor the intake flow')
    }
  })

  it('settles on the newest tool step once the burst stops', () => {
    renderRow(cursorAgentRow('Read', 'src/a.ts'))
    act(() => {
      vi.advanceTimersByTime(40)
    })
    renderRow(cursorAgentRow('Bash', 'pnpm build'))
    act(() => {
      vi.advanceTimersByTime(AGENT_TOOL_STEP_DWELL_MS)
    })

    expect(rowText()).toContain('Bash: pnpm build')
  })
})
