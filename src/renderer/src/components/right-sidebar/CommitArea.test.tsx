import { describe, expect, it, vi } from 'vitest'
import { Check, RefreshCw } from 'lucide-react'
import { CommitArea } from './SourceControl'
import { Button } from '@/components/ui/button'
import { resolvePrimaryAction, type PrimaryActionInputs } from './source-control-primary-action'
import { resolveDropdownItems, type DropdownActionKind } from './source-control-dropdown-items'

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

function findTextarea(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === 'textarea') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('textarea not found')
  }
  return found
}

// Why: the split button renders two Button instances back-to-back — the
// primary action and the chevron trigger. The primary is always the first
// Button encountered in a depth-first walk, so we key on that position.
function findPrimaryButton(node: unknown): ReactElementLike {
  const buttons: ReactElementLike[] = []
  visit(node, (entry) => {
    if (entry.type === Button) {
      buttons.push(entry)
    }
  })
  if (buttons.length === 0) {
    throw new Error('primary button not found')
  }
  return buttons[0]
}

function primaryHasSpinner(node: unknown): boolean {
  const primary = findPrimaryButton(node)
  let found = false
  visit(primary, (entry) => {
    if (entry.type === RefreshCw) {
      found = true
    }
  })
  return found
}

function primaryHasCheck(node: unknown): boolean {
  const primary = findPrimaryButton(node)
  let found = false
  visit(primary, (entry) => {
    if (entry.type === Check) {
      found = true
    }
  })
  return found
}

function hasText(node: unknown, text: string): boolean {
  let found = false
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.includes(text)) {
        found = true
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    const element = value as ReactElementLike | null
    if (element && typeof element === 'object' && 'props' in element) {
      walk(element.props?.children)
    }
  }
  visit(node, (entry) => {
    walk(entry.props?.children)
  })
  return found
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function buildInputs(overrides: Partial<PrimaryActionInputs> = {}): PrimaryActionInputs {
  return {
    stagedCount: 1,
    hasUnstagedChanges: false,
    hasMessage: true,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
    ...overrides
  }
}

function baseProps(overrides: Partial<PrimaryActionInputs> = {}) {
  const inputs = buildInputs(overrides)
  return {
    commitMessage: 'feat: add commit area',
    commitError: null as string | null,
    isCommitting: inputs.isCommitting,
    isRemoteOperationActive: inputs.isRemoteOperationActive,
    inFlightRemoteOpKind: inputs.inFlightRemoteOpKind ?? null,
    primaryAction: resolvePrimaryAction(inputs),
    dropdownItems: resolveDropdownItems(inputs),
    onCommitMessageChange: vi.fn(),
    onPrimaryAction: vi.fn(),
    onDropdownAction: vi.fn() as (kind: DropdownActionKind) => void
  }
}

describe('CommitArea', () => {
  it('disables the primary button when no staged files', () => {
    const element = CommitArea(baseProps({ stagedCount: 0 }))
    const button = findPrimaryButton(element)
    expect(button.props.disabled).toBe(true)
  })

  it('disables the primary button when the commit message is empty', () => {
    const props = baseProps({ hasMessage: false })
    const element = CommitArea({ ...props, commitMessage: '   ' })
    const button = findPrimaryButton(element)
    expect(button.props.disabled).toBe(true)
  })

  it('disables the primary button when unresolved conflicts exist', () => {
    const element = CommitArea(baseProps({ hasUnresolvedConflicts: true }))
    const button = findPrimaryButton(element)
    expect(button.props.disabled).toBe(true)
  })

  it('enables the primary button when staged + message + no conflicts', () => {
    const element = CommitArea(baseProps())
    const button = findPrimaryButton(element)
    expect(button.props.disabled).toBe(false)
  })

  it('fires onPrimaryAction when the primary button is clicked', () => {
    const onPrimaryAction = vi.fn()
    const element = CommitArea({ ...baseProps(), onPrimaryAction })
    const button = findPrimaryButton(element)
    ;(button.props.onClick as () => void)()
    expect(onPrimaryAction).toHaveBeenCalledTimes(1)
  })

  it('keeps the textarea enabled while the commit is in flight', () => {
    const element = CommitArea({
      ...baseProps({ isCommitting: true }),
      isCommitting: true
    })
    const textarea = findTextarea(element)
    expect(textarea.props.disabled).toBeFalsy()
  })

  it('clears the message and keeps error hidden after a successful commit lifecycle', async () => {
    let commitMessage = 'feat: add commit area'
    let commitError: string | null = null
    let isCommitting = false

    const runCommit = vi.fn(async () => {
      isCommitting = true
      commitError = null
      await Promise.resolve()
      commitMessage = ''
      isCommitting = false
    })

    const render = () => {
      const inputs = buildInputs({
        hasMessage: commitMessage.trim().length > 0,
        isCommitting
      })
      return CommitArea({
        ...baseProps(),
        commitMessage,
        commitError,
        isCommitting,
        primaryAction: resolvePrimaryAction(inputs),
        dropdownItems: resolveDropdownItems(inputs),
        onPrimaryAction: () => {
          void runCommit()
        }
      })
    }

    const button = findPrimaryButton(render())
    ;(button.props.onClick as () => void)()
    await flushPromises()

    const updated = render()
    expect(findTextarea(updated).props.value).toBe('')
    expect(hasText(updated, 'failed')).toBe(false)
    expect(runCommit).toHaveBeenCalledTimes(1)
  })

  it('preserves the message and shows the error after a failed commit lifecycle', async () => {
    const initialMessage = 'feat: add commit area'
    let commitMessage = initialMessage
    let commitError: string | null = null
    let isCommitting = false

    const runCommit = vi.fn(async () => {
      isCommitting = true
      commitError = null
      await Promise.resolve()
      commitError = 'pre-commit hook failed'
      isCommitting = false
    })

    const render = () => {
      const inputs = buildInputs({
        hasMessage: commitMessage.trim().length > 0,
        isCommitting
      })
      return CommitArea({
        ...baseProps(),
        commitMessage,
        commitError,
        isCommitting,
        primaryAction: resolvePrimaryAction(inputs),
        dropdownItems: resolveDropdownItems(inputs),
        onPrimaryAction: () => {
          void runCommit()
        }
      })
    }

    const button = findPrimaryButton(render())
    ;(button.props.onClick as () => void)()
    await flushPromises()

    const updated = render()
    expect(findTextarea(updated).props.value).toBe(initialMessage)
    expect(hasText(updated, 'pre-commit hook failed')).toBe(true)
    expect(runCommit).toHaveBeenCalledTimes(1)
  })

  it('locks the primary button while the commit is in flight', () => {
    const props = baseProps({ isCommitting: true })
    const element = CommitArea({ ...props, isCommitting: true })
    const button = findPrimaryButton(element)
    expect(button.props.disabled).toBe(true)
  })

  it('shows an inline error message when the commit fails', () => {
    const element = CommitArea({ ...baseProps(), commitError: 'pre-commit hook failed' })
    expect(hasText(element, 'pre-commit hook failed')).toBe(true)
  })

  it('keeps the primary button labelled Commit when the tree is staged, even with commits to push', () => {
    // Why: the primary never compounds ("Commit & Push"). Users commit first,
    // then the primary rotates to Push. Compound flows remain in the dropdown,
    // so we check only the primary button, not the whole tree.
    const props = baseProps({
      stagedCount: 1,
      hasMessage: true,
      upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 }
    })
    const element = CommitArea(props)
    const primary = findPrimaryButton(element)
    expect(hasText(primary, 'Commit')).toBe(true)
    expect(hasText(primary, 'Commit & Push')).toBe(false)
    expect(hasText(primary, 'Commit & Sync')).toBe(false)
    expect(hasText(primary, 'Commit & Publish')).toBe(false)
  })

  // Why: fetching from the dropdown sets isRemoteOperationActive, but the
  // primary button is plain "Commit" — painting a spinner on it told the
  // user their commit was running. The spinner must track the primary
  // action itself, not every background remote op.
  it('does not show a spinner on a plain Commit primary when a dropdown remote op is running', () => {
    const props = baseProps({
      // stagedCount + no message resolves to plain 'commit' kind (disabled
      // because the message is empty). This is the scenario the user hit:
      // a Commit button that falsely claimed their commit was in flight
      // while a dropdown-triggered Fetch was the actual work.
      stagedCount: 1,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
      isCommitting: false,
      isRemoteOperationActive: true
    })
    const element = CommitArea(props)
    expect(primaryHasSpinner(element)).toBe(false)
  })

  it('shows a spinner on a Commit primary while the commit itself is in flight', () => {
    const props = baseProps({
      stagedCount: 1,
      hasMessage: true,
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
      isCommitting: true
    })
    const element = CommitArea({ ...props, isCommitting: true })
    expect(primaryHasSpinner(element)).toBe(true)
  })

  it('shows a spinner on a remote primary (Push) while the matching remote op is active', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 },
      isRemoteOperationActive: true,
      inFlightRemoteOpKind: 'push'
    })
    const element = CommitArea(props)
    expect(primaryHasSpinner(element)).toBe(true)
  })

  // Why: regression — when the user picks Sync from the dropdown, the
  // primary button must mirror the action they triggered (label "Sync",
  // spinner on Sync) instead of leaving a stale "Push" with a spinner that
  // claims a different operation is running.
  it('mirrors a dropdown-triggered Sync on the primary button while it runs', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      // Pre-click state: ahead=3, behind=0 → primary's natural label is Push.
      upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 },
      isRemoteOperationActive: true,
      inFlightRemoteOpKind: 'sync'
    })
    const element = CommitArea(props)
    const primary = findPrimaryButton(element)
    expect(hasText(primary, 'Sync')).toBe(true)
    expect(hasText(primary, 'Push')).toBe(false)
    expect(primaryHasSpinner(element)).toBe(true)
  })

  // Why: Fetch is dropdown-only (never the primary's label). Spinning the
  // primary on a fetch would mis-narrate "Push is running" while the actual
  // work is fetching. Primary keeps its natural label, disabled, no spinner.
  it('does not spin or relabel the primary when a dropdown Fetch is in flight', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 },
      isRemoteOperationActive: true,
      inFlightRemoteOpKind: 'fetch'
    })
    const element = CommitArea(props)
    const primary = findPrimaryButton(element)
    expect(hasText(primary, 'Push')).toBe(true)
    expect(primary.props.disabled).toBe(true)
    expect(primaryHasSpinner(element)).toBe(false)
  })

  // Why: the leading checkmark anchors the affirmative Commit verb so the
  // button doesn't read like just another remote-state label sharing the
  // slot (Push / Pull / Sync / Publish). Decorative — verified by
  // presence/absence rather than label text.
  it('renders a leading checkmark on a Commit primary', () => {
    const element = CommitArea(baseProps())
    expect(primaryHasCheck(element)).toBe(true)
  })

  it('omits the checkmark when the primary is a remote action', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 }
    })
    const element = CommitArea(props)
    expect(primaryHasCheck(element)).toBe(false)
  })

  // Why: while the commit is in flight the spinner replaces any leading
  // icon so the user gets a single, unambiguous progress signal.
  it('replaces the checkmark with a spinner while the commit is in flight', () => {
    const props = baseProps({ isCommitting: true })
    const element = CommitArea({ ...props, isCommitting: true })
    expect(primaryHasSpinner(element)).toBe(true)
    expect(primaryHasCheck(element)).toBe(false)
  })
})
