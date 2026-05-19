import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  renderWorktreeClaudeAccountSection,
  type WorktreeClaudeAccountSectionProps
} from './WorktreeMetaDialog'

// The full `WorktreeMetaDialog` component is heavily wired to `useAppStore`
// and Radix portals. We can't easily render the dialog itself in
// `environment: 'node'`. Instead this suite tests the pure section helper
// that the dialog mounts — that's where the multi-provider gating + picker
// wiring lives.

function makeProps(
  overrides: Partial<WorktreeClaudeAccountSectionProps> = {}
): WorktreeClaudeAccountSectionProps {
  return {
    multiProviderEnabled: true,
    worktreeId: 'repo-1::/repo/worktrees/wt1',
    accounts: [
      { id: 'global-A', label: 'OAuth (a@b.com)' },
      { id: 'ws-B', label: 'API key (Work)' }
    ],
    currentOverride: null,
    onSetOverride: vi.fn(),
    onClearOverride: vi.fn(),
    ...overrides
  }
}

describe('WorktreeMetaDialog — Claude account picker section (P2)', () => {
  it('renders the picker when multi-provider flag is on', () => {
    const section = renderWorktreeClaudeAccountSection(makeProps())
    expect(section).not.toBeNull()
    const markup = renderToStaticMarkup(section!)
    expect(markup).toMatch(/Use global default/)
    expect(markup).toMatch(/OAuth \(a@b\.com\)/)
    expect(markup).toMatch(/API key \(Work\)/)
  })

  it('omits the picker when multi-provider flag is off', () => {
    const section = renderWorktreeClaudeAccountSection(makeProps({ multiProviderEnabled: false }))
    expect(section).toBeNull()
  })

  it('omits the picker when no worktreeId is set (dialog is closed / no target)', () => {
    const section = renderWorktreeClaudeAccountSection(makeProps({ worktreeId: '' }))
    expect(section).toBeNull()
  })

  it('routes a "set override" choice through onSetOverride', () => {
    const onSetOverride = vi.fn()
    const onClearOverride = vi.fn()
    const section = renderWorktreeClaudeAccountSection(
      makeProps({ onSetOverride, onClearOverride })
    )
    expect(section).not.toBeNull()
    // Find the apply callback via the picker's onApply prop.
    const sectionEl = section as unknown as { props: { children: unknown } }
    // The section is a wrapper <div> whose children include the picker. Walk
    // until we find the WorktreeClaudeAccountPicker element by its onApply.
    let onApply: ((u: unknown) => void) | null = null
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const el = node as { props?: Record<string, unknown> }
      if (el.props && typeof el.props.onApply === 'function' && !onApply) {
        onApply = el.props.onApply as (u: unknown) => void
      }
      if (el.props?.children) visit(el.props.children)
      if (Array.isArray(node)) node.forEach(visit)
    }
    visit(sectionEl)
    expect(onApply).not.toBeNull()
    onApply!({ action: 'set', worktreeId: 'repo-1::/repo/worktrees/wt1', accountId: 'ws-B' })
    expect(onSetOverride).toHaveBeenCalledWith({
      worktreeId: 'repo-1::/repo/worktrees/wt1',
      accountId: 'ws-B'
    })
    expect(onClearOverride).not.toHaveBeenCalled()
  })

  it('routes a "clear override" choice through onClearOverride', () => {
    const onSetOverride = vi.fn()
    const onClearOverride = vi.fn()
    const section = renderWorktreeClaudeAccountSection(
      makeProps({ onSetOverride, onClearOverride, currentOverride: 'ws-B' })
    )
    let onApply: ((u: unknown) => void) | null = null
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const el = node as { props?: Record<string, unknown> }
      if (el.props && typeof el.props.onApply === 'function' && !onApply) {
        onApply = el.props.onApply as (u: unknown) => void
      }
      if (el.props?.children) visit(el.props.children)
      if (Array.isArray(node)) node.forEach(visit)
    }
    visit(section)
    expect(onApply).not.toBeNull()
    onApply!({ action: 'clear', worktreeId: 'repo-1::/repo/worktrees/wt1' })
    expect(onClearOverride).toHaveBeenCalledWith({
      worktreeId: 'repo-1::/repo/worktrees/wt1'
    })
    expect(onSetOverride).not.toHaveBeenCalled()
  })
})
