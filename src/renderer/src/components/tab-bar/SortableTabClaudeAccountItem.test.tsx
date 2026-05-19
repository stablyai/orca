import { describe, expect, it } from 'vitest'
import {
  SortableTabClaudeAccountItemView,
  buildPerTabOverrideSubmit
} from './SortableTabClaudeAccountItem'

// Why: P2 T20 — per-tab account override is built from a submenu inside the
// existing tab dropdown. The pure builder maps the radio-group "use-default"
// sentinel to a clear action; any other value is treated as a concrete account
// id and maps to a set action.
//
// Renderer tests run under `environment: 'node'` (no jsdom). The view is
// exported as a stateless function and called directly here so we can walk
// the returned React element tree — same pattern as
// `src/renderer/src/components/sidebar/WorktreeOpenInMenu.test.tsx`.

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function collectText(node: unknown): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  const element = node as ReactElementLike
  return collectText(element.props?.children)
}

describe('buildPerTabOverrideSubmit', () => {
  it('"use-default" maps to clear', () => {
    expect(buildPerTabOverrideSubmit({ choice: 'use-default', worktreeId: 'r::/wt1' })).toEqual({
      action: 'clear',
      worktreeId: 'r::/wt1'
    })
  })

  it('account id maps to set', () => {
    expect(buildPerTabOverrideSubmit({ choice: 'account-A', worktreeId: 'r::/wt1' })).toEqual({
      action: 'set',
      worktreeId: 'r::/wt1',
      accountId: 'account-A'
    })
  })
})

describe('SortableTabClaudeAccountItemView', () => {
  it('renders a "Use account for new terminals here…" submenu trigger', () => {
    const tree = SortableTabClaudeAccountItemView({
      worktreeId: 'r::/wt1',
      accounts: [{ id: 'a1', label: 'OAuth' }],
      currentOverride: null,
      onChange: () => {}
    })
    expect(collectText(tree)).toMatch(/Use account for new terminals here/)
  })

  it('renders submenu items for each account plus "Use workspace default"', () => {
    const tree = SortableTabClaudeAccountItemView({
      worktreeId: 'r::/wt1',
      accounts: [
        { id: 'a1', label: 'OAuth' },
        { id: 'a2', label: 'API key' }
      ],
      currentOverride: null,
      onChange: () => {}
    })
    const text = collectText(tree)
    expect(text).toMatch(/Use workspace default/)
    expect(text).toMatch(/OAuth/)
    expect(text).toMatch(/API key/)
  })

  it('emits "applies to new terminals" hint text matching P1 toast wording', () => {
    const tree = SortableTabClaudeAccountItemView({
      worktreeId: 'r::/wt1',
      accounts: [],
      currentOverride: null,
      onChange: () => {}
    })
    expect(collectText(tree)).toMatch(/applies to new terminals|new terminals here/i)
  })

  it('wires the current override into the radio group value (account id selected)', () => {
    const tree = SortableTabClaudeAccountItemView({
      worktreeId: 'r::/wt1',
      accounts: [{ id: 'a1', label: 'OAuth' }],
      currentOverride: 'a1',
      onChange: () => {}
    })
    let radioGroupValue: unknown = undefined
    visit(tree, (entry) => {
      // DropdownMenuRadioGroup exposes its current value via a `value` prop
      // and an `onValueChange` callback. Match on both to skip unrelated
      // elements that also happen to carry a `value` prop (e.g. each radio
      // item also has one).
      if (
        entry.props &&
        'value' in entry.props &&
        'onValueChange' in entry.props &&
        typeof entry.props.onValueChange === 'function'
      ) {
        radioGroupValue = entry.props.value
      }
    })
    expect(radioGroupValue).toBe('a1')
  })

  it('falls back to the "use-default" sentinel when no override is set', () => {
    const tree = SortableTabClaudeAccountItemView({
      worktreeId: 'r::/wt1',
      accounts: [{ id: 'a1', label: 'OAuth' }],
      currentOverride: null,
      onChange: () => {}
    })
    let radioGroupValue: unknown = undefined
    visit(tree, (entry) => {
      if (
        entry.props &&
        'value' in entry.props &&
        'onValueChange' in entry.props &&
        typeof entry.props.onValueChange === 'function'
      ) {
        radioGroupValue = entry.props.value
      }
    })
    expect(radioGroupValue).toBe('use-default')
  })
})
