import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  WorktreeClaudeAccountPicker,
  WorktreeClaudeAccountPickerView,
  buildOverrideUpdate
} from './WorktreeClaudeAccountPicker'

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

function findAllByRole(node: unknown, role: string): ReactElementLike[] {
  const out: ReactElementLike[] = []
  visit(node, (entry) => {
    if (entry.props.role === role) {
      out.push(entry)
    }
  })
  return out
}

describe('buildOverrideUpdate', () => {
  it('"global-default" maps to clearing the override', () => {
    expect(buildOverrideUpdate({ choice: 'global-default', worktreeId: 'r::/wt1' })).toEqual({
      action: 'clear',
      worktreeId: 'r::/wt1'
    })
  })

  it('a specific accountId maps to set', () => {
    expect(buildOverrideUpdate({ choice: 'account-A', worktreeId: 'r::/wt1' })).toEqual({
      action: 'set',
      worktreeId: 'r::/wt1',
      accountId: 'account-A'
    })
  })
})

describe('WorktreeClaudeAccountPickerView markup', () => {
  it('renders all accounts plus the "Use global default" option', () => {
    const markup = renderToStaticMarkup(
      <WorktreeClaudeAccountPickerView
        worktreeId="r::/wt1"
        accounts={[
          { id: 'global-A', label: 'OAuth (a@b.com)' },
          { id: 'ws-B', label: 'API key (Work)' }
        ]}
        currentOverride={null}
        onChange={() => {}}
      />
    )
    expect(markup).toMatch(/Use global default/)
    expect(markup).toMatch(/OAuth \(a@b\.com\)/)
    expect(markup).toMatch(/API key \(Work\)/)
  })

  it('marks the current override with aria-pressed', () => {
    const markup = renderToStaticMarkup(
      <WorktreeClaudeAccountPickerView
        worktreeId="r::/wt1"
        accounts={[{ id: 'ws-B', label: 'API key (Work)' }]}
        currentOverride="ws-B"
        onChange={() => {}}
      />
    )
    expect(markup).toMatch(/aria-pressed="true"[\s\S]*?API key \(Work\)/)
  })

  it('marks "Use global default" as pressed when currentOverride is null', () => {
    const tree = WorktreeClaudeAccountPickerView({
      worktreeId: 'r::/wt1',
      accounts: [{ id: 'ws-B', label: 'API key (Work)' }],
      currentOverride: null,
      onChange: () => {}
    })
    const options = findAllByRole(tree, 'radio')
    expect(options).toHaveLength(2)
    const globalDefault = options[0]
    expect(globalDefault.props['aria-pressed']).toBe(true)
    const accountOption = options[1]
    expect(accountOption.props['aria-pressed']).toBe(false)
  })

  it('renders an empty-state hint when there are no accounts', () => {
    const markup = renderToStaticMarkup(
      <WorktreeClaudeAccountPickerView
        worktreeId="r::/wt1"
        accounts={[]}
        currentOverride={null}
        onChange={() => {}}
      />
    )
    // The picker should still render the "Use global default" option, but
    // there should be no per-account options.
    expect(markup).toMatch(/Use global default/)
    // No second radio.
    const tree = WorktreeClaudeAccountPickerView({
      worktreeId: 'r::/wt1',
      accounts: [],
      currentOverride: null,
      onChange: () => {}
    })
    expect(findAllByRole(tree, 'radio')).toHaveLength(1)
  })

  it('onChange fires with "global-default" when the default option is clicked', () => {
    const onChange = vi.fn()
    const tree = WorktreeClaudeAccountPickerView({
      worktreeId: 'r::/wt1',
      accounts: [{ id: 'ws-B', label: 'API key (Work)' }],
      currentOverride: 'ws-B',
      onChange
    })
    const options = findAllByRole(tree, 'radio')
    const onClick = options[0].props.onClick as () => void
    onClick()
    expect(onChange).toHaveBeenCalledWith('global-default')
  })

  it('onChange fires with the account id when an account option is clicked', () => {
    const onChange = vi.fn()
    const tree = WorktreeClaudeAccountPickerView({
      worktreeId: 'r::/wt1',
      accounts: [
        { id: 'ws-B', label: 'API key (Work)' },
        { id: 'ws-C', label: 'OAuth (a@b.com)' }
      ],
      currentOverride: null,
      onChange
    })
    const options = findAllByRole(tree, 'radio')
    const onClick = options[2].props.onClick as () => void
    onClick()
    expect(onChange).toHaveBeenCalledWith('ws-C')
  })
})

describe('WorktreeClaudeAccountPicker (stateful wrapper)', () => {
  it('translates the picker choice into a buildOverrideUpdate payload via onApply', () => {
    const onApply = vi.fn()
    // Call the wrapper as a function (no hook dispatcher needed — it's a thin
    // delegator). The returned element is the inner view; pull its onChange
    // and verify the wrapper routes choices through buildOverrideUpdate.
    const view = WorktreeClaudeAccountPicker({
      worktreeId: 'r::/wt1',
      accounts: [{ id: 'ws-B', label: 'API key (Work)' }],
      currentOverride: null,
      onApply
    }) as unknown as ReactElementLike
    expect(view.type).toBe(WorktreeClaudeAccountPickerView)
    const onChange = view.props.onChange as (choice: string) => void
    onChange('ws-B')
    expect(onApply).toHaveBeenCalledWith({
      action: 'set',
      worktreeId: 'r::/wt1',
      accountId: 'ws-B'
    })
    onChange('global-default')
    expect(onApply).toHaveBeenCalledWith({ action: 'clear', worktreeId: 'r::/wt1' })
  })
})
