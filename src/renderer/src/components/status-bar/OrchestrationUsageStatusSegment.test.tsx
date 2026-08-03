// @vitest-environment happy-dom

import React from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OrchestrationCostReport } from '../../../../shared/orchestration-cost-report'
import { OrchestrationUsageStatusView } from './OrchestrationUsageStatusSegment'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))

afterEach(cleanup)

function report(
  overrides: {
    cost?: number | null
    costStatus?: 'known' | 'partial' | 'unavailable'
    completeness?: 'complete' | 'partial'
    attributionCertainty?: 'inferred' | 'unavailable'
    provider?: 'codex' | 'claude' | 'opencode'
  } = {}
): OrchestrationCostReport {
  const metrics = {
    inputTokens: 1_000,
    cachedInputTokens: null,
    outputTokens: 500,
    reasoningOutputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 1_500,
    estimatedCostUsd: overrides.cost === undefined ? 0.42 : overrides.cost,
    costStatus: overrides.costStatus ?? 'known'
  }
  const usage = {
    attributionCertainty: overrides.attributionCertainty ?? ('inferred' as const),
    providers:
      overrides.attributionCertainty === 'unavailable'
        ? []
        : [{ provider: overrides.provider ?? ('codex' as const), sessionCount: 1, metrics }]
  }
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-02T12:00:00.000Z',
    run: {
      id: 'run-123',
      createdAt: '2026-08-02T11:58:55.000Z',
      updatedAt: '2026-08-02T12:00:00.000Z'
    },
    graph: {
      rootTaskIds: ['task-root'],
      tasks: [
        {
          id: 'task-root',
          parentId: null,
          childIds: [],
          status: 'completed',
          createdAt: '2026-08-02T11:58:55.000Z',
          completedAt: '2026-08-02T12:00:00.000Z',
          dispatches: [],
          elapsed: {
            direct: { milliseconds: 65_000, status: 'available' },
            rolledUp: { milliseconds: 65_000, status: 'available' }
          },
          usage: { direct: usage, rolledUp: usage }
        }
      ]
    },
    totals: { elapsed: { milliseconds: 65_000, status: 'available' }, usage },
    attribution: {
      rule: 'exact_worktree_and_contained_dispatch_interval_unique_within_run',
      certainty: 'inferred_no_durable_terminal_provider_session_link',
      attributed: [
        {
          provider: 'codex',
          sessionId: 'private-session',
          dispatchId: 'dispatch-1',
          certainty: 'inferred'
        }
      ],
      unlinked: [],
      ambiguous: []
    },
    provenance: {
      orchestration: 'live_runtime_database_structured_rows',
      usage: 'live_runtime_in_memory_usage_snapshots',
      usageHostScope: 'runtime_host_local_only',
      attribution: 'inferred_no_durable_terminal_provider_session_link',
      excluded: []
    },
    completeness: {
      status: overrides.completeness ?? 'complete',
      taskRows: { included: 1, available: 1, limit: 500 },
      dispatchRows: { included: 0, available: 0, limit: 2_000 },
      providerSessions: [
        {
          provider: 'codex',
          scope: 'runtime_host_local_only',
          completeness: overrides.completeness ?? 'complete',
          included: 1,
          limit: 2_000,
          truncated: overrides.completeness === 'partial',
          status: 'available',
          lastScanCompletedAt: Date.parse('2026-08-02T12:00:00.000Z'),
          message: null,
          limitations: []
        }
      ],
      warnings: []
    }
  }
}

function renderView(
  props: Partial<React.ComponentProps<typeof OrchestrationUsageStatusView>> = {}
) {
  return render(
    <TooltipProvider>
      <OrchestrationUsageStatusView
        compact={false}
        iconOnly={false}
        selection={{ kind: 'selected', runId: 'run-123', source: 'live' }}
        report={report()}
        error={null}
        stale={false}
        refreshing={false}
        open={false}
        onOpenChange={() => {}}
        {...props}
      />
    </TooltipProvider>
  )
}

describe('OrchestrationUsageStatusView', () => {
  it('renders compact elapsed, attributed tokens, and available cost with an accessible label', () => {
    renderView()
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveTextContent('1m 5s · 1.5k · $0.42')
    expect(trigger).toHaveAccessibleName(/Orchestration usage.*1m 5s.*1.5k tokens.*inferred/)
  })

  it('uses icon-only responsive rendering without losing accessible status', () => {
    renderView({ iconOnly: true })
    const trigger = screen.getByRole('button')
    expect(trigger).not.toHaveTextContent('1.5k')
    expect(trigger).toHaveAccessibleName(/1.5k tokens/)
  })

  it('shows only elapsed time in compact mode while preserving full accessible metrics', () => {
    renderView({ compact: true })
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveTextContent('1m 5s')
    expect(trigger).not.toHaveTextContent('1.5k')
    expect(trigger).not.toHaveTextContent('$0.42')
    expect(trigger).toHaveAccessibleName(/1.5k tokens.*\$0.42/)
  })

  it('discloses partial, inferred, stale, missing-cost, run identity, and node data', () => {
    renderView({
      report: report({ cost: null, costStatus: 'unavailable', completeness: 'partial' }),
      stale: true,
      open: true
    })
    expect(screen.getByText('run-123')).toBeInTheDocument()
    expect(screen.getByText(/Stale: the latest refresh failed/)).toBeInTheDocument()
    expect(screen.getByText(/Partial: one or more report inputs/)).toBeInTheDocument()
    expect(screen.getByText(/Attribution is inferred/)).toBeInTheDocument()
    expect(screen.getByText(/Cost unavailable/)).toBeInTheDocument()
    expect(screen.getByText(/task-root · completed/)).toBeInTheDocument()
    expect(screen.queryByText('private-session')).not.toBeInTheDocument()
  })

  it('names, focuses, and viewport-bounds the report dialog', async () => {
    renderView({ open: true })
    const dialog = screen.getByRole('dialog', { name: 'Orchestration usage' })
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    expect(dialog).toHaveClass(
      'max-h-[var(--radix-popover-content-available-height)]',
      'overflow-y-auto',
      'popover-scroll-content'
    )
  })

  it('discloses unavailable attribution without claiming inference for zero usage', () => {
    renderView({
      report: report({ attributionCertainty: 'unavailable' }),
      open: true
    })
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveAccessibleName(/attribution unavailable/)
    expect(trigger).not.toHaveAccessibleName(/inferred/)
    expect(screen.getByText(/Attribution unavailable: no provider usage/)).toBeInTheDocument()
    expect(screen.getByText('No attributed provider usage is available.')).toBeInTheDocument()
  })

  it('signals partial cost in the trigger and renders OpenCode brand casing', () => {
    renderView({
      report: report({ cost: 0.2, costStatus: 'partial', provider: 'opencode' }),
      open: true
    })
    expect(screen.getByRole('button')).toHaveAccessibleName(/partial/)
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText(/Cost partial/)).toBeInTheDocument()
  })

  it('renders no-run, ambiguity, and older-runtime states without claiming usage', () => {
    const { rerender } = renderView({ selection: { kind: 'none' }, report: null })
    expect(screen.getByRole('button')).toHaveAccessibleName(/no exact run/)
    rerender(
      <TooltipProvider>
        <OrchestrationUsageStatusView
          compact
          iconOnly={false}
          selection={{ kind: 'ambiguous', runIds: ['run-a', 'run-b'] }}
          report={null}
          error={null}
          stale={false}
          refreshing={false}
          open={false}
          onOpenChange={() => {}}
        />
      </TooltipProvider>
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(/multiple active runs/)
    rerender(
      <TooltipProvider>
        <OrchestrationUsageStatusView
          compact
          iconOnly={false}
          selection={{ kind: 'selected', runId: 'run-a', source: 'live' }}
          report={null}
          error="older-runtime"
          stale={false}
          refreshing={false}
          open={false}
          onOpenChange={() => {}}
        />
      </TooltipProvider>
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(/unavailable on this runtime version/)
  })
})
