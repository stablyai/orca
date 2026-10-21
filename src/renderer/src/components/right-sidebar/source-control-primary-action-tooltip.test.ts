import { describe, expect, it } from 'vitest'
import { shouldShowPrimaryTooltip } from './source-control-primary-action-tooltip'
import type { PrimaryActionKind } from './source-control-primary-action'

function action(kind: PrimaryActionKind, disabled: boolean) {
  return { kind, disabled, label: kind, title: kind }
}

describe('shouldShowPrimaryTooltip', () => {
  it('shows the tooltip when disabled — the title carries the blocking reason', () => {
    for (const kind of ['stage', 'create_pr', 'create_pr_intent', 'commit'] as const) {
      expect(shouldShowPrimaryTooltip(action(kind, true))).toBe(true)
    }
  })

  it('hides pure repeats on enabled Stage All and Create PR', () => {
    expect(shouldShowPrimaryTooltip(action('stage', false))).toBe(false)
    expect(shouldShowPrimaryTooltip(action('create_pr', false))).toBe(false)
  })

  it('keeps the Create PR intent tooltip — it explains the prepare step the label omits', () => {
    expect(shouldShowPrimaryTooltip(action('create_pr_intent', false))).toBe(true)
  })

  it('shows informative tooltips for commit and remote counts', () => {
    for (const kind of ['commit', 'push', 'pull', 'sync', 'publish'] as const) {
      expect(shouldShowPrimaryTooltip(action(kind, false))).toBe(true)
    }
  })
})
