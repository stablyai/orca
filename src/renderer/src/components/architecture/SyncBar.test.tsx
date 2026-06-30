// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncBar } from './SyncBar'
import type { ScryerCompletionGateResult } from '../../../../shared/scryer/edit-session'

let root: Root | null = null
let container: HTMLDivElement | null = null

function gate(overrides: Partial<ScryerCompletionGateResult> = {}): ScryerCompletionGateResult {
  return {
    ok: true,
    foldAllowed: true,
    nextAction: 'fold_allowed',
    pending: {
      total: 1,
      foldable: true,
      byKind: { node: 1 },
      byChange: { added: 1 },
      changes: [],
      blockers: [],
      risks: []
    },
    validation: {
      blockingCount: 0,
      warningCount: 0,
      findings: []
    },
    lease: {
      active: false,
      blocked: false
    },
    ...overrides
  }
}

function render(completionGate: ScryerCompletionGateResult | null): string {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <SyncBar
        activeAgent={{ name: 'Codex', available: true }}
        driftedNodes={[]}
        structureChanged={false}
        implementing={false}
        syncStatus="idle"
        syncMessage={null}
        syncLog={[]}
        projectPath="/repo"
        completionGate={completionGate}
        onSync={vi.fn()}
        onCancelSync={vi.fn()}
        onDismissMessage={vi.fn()}
        onDismissDrift={vi.fn()}
        onToggleLock={vi.fn()}
      />
    )
  })
  return container.textContent ?? ''
}

afterEach(() => {
  root?.unmount()
  root = null
  container?.remove()
  container = null
})

describe('SyncBar completion gate rendering', () => {
  it('renders a foldable completion gate result', () => {
    expect(render(gate())).toContain('1 pending change ready to fold')
  })

  it('renders blocking completion gate actions', () => {
    expect(
      render(
        gate({
          ok: false,
          foldAllowed: false,
          nextAction: 'fix_validation',
          validation: { blockingCount: 2, warningCount: 0, findings: [] }
        })
      )
    ).toContain('Fix 2 validation errors before folding')
  })
})
