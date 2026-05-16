import { describe, expect, it, vi } from 'vitest'
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

function findNativeButtonByAriaLabel(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === 'button' && entry.props['aria-label'] === ariaLabel) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`button not found: ${ariaLabel}`)
  }
  return found
}

function hasNativeButtonByAriaLabel(node: unknown, ariaLabel: string): boolean {
  let found = false
  visit(node, (entry) => {
    if (entry.type === 'button' && entry.props['aria-label'] === ariaLabel) {
      found = true
    }
  })
  return found
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
    aiEnabled: false,
    aiAgentConfigured: false,
    isGenerating: false,
    generateError: null as string | null,
    stagedCount: inputs.stagedCount,
    hasUnresolvedConflicts: inputs.hasUnresolvedConflicts,
    isRemoteOperationActive: inputs.isRemoteOperationActive,
    inFlightRemoteOpKind: inputs.inFlightRemoteOpKind ?? null,
    primaryAction: resolvePrimaryAction(inputs),
    dropdownItems: resolveDropdownItems(inputs),
    onCommitMessageChange: vi.fn(),
    onGenerate: vi.fn(),
    onCancelGenerate: vi.fn(),
    onPrimaryAction: vi.fn(),
    onDropdownAction: vi.fn() as (kind: DropdownActionKind) => void
  }
}

describe('CommitArea AI generation', () => {
  it('does not render the AI generate affordance when the feature is disabled', () => {
    const element = CommitArea(baseProps())
    expect(hasNativeButtonByAriaLabel(element, 'Generate commit message with AI')).toBe(false)
  })

  it('enables AI generation only when an agent is configured, changes are staged, and the message is empty', () => {
    const onGenerate = vi.fn()
    const props = baseProps({ hasMessage: false })
    const element = CommitArea({
      ...props,
      commitMessage: '',
      aiEnabled: true,
      aiAgentConfigured: true,
      onGenerate
    })

    const button = findNativeButtonByAriaLabel(element, 'Generate commit message with AI')
    expect(button.props.disabled).toBe(false)
    ;(button.props.onClick as () => void)()
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('disables AI generation when the textarea already has user text', () => {
    const element = CommitArea({
      ...baseProps(),
      aiEnabled: true,
      aiAgentConfigured: true
    })

    const button = findNativeButtonByAriaLabel(element, 'Generate commit message with AI')
    expect(button.props.disabled).toBe(true)
    expect(button.props.title).toBe('Clear the message to regenerate.')
  })

  it('disables AI generation until the configured agent can actually run', () => {
    const props = baseProps({ hasMessage: false })
    const element = CommitArea({
      ...props,
      commitMessage: '',
      aiEnabled: true,
      aiAgentConfigured: false
    })

    const button = findNativeButtonByAriaLabel(element, 'Generate commit message with AI')
    expect(button.props.disabled).toBe(true)
    expect(button.props.title).toBe('Pick an agent in Settings → AI Commit Messages.')
  })

  it('turns the generating icon into a stop affordance', () => {
    const onCancelGenerate = vi.fn()
    const props = baseProps({ hasMessage: false })
    const element = CommitArea({
      ...props,
      commitMessage: '',
      aiEnabled: true,
      aiAgentConfigured: true,
      isGenerating: true,
      onCancelGenerate
    })

    const button = findNativeButtonByAriaLabel(element, 'Stop generating commit message')
    expect(button.props.title).toBe('Stop generating')
    expect(hasText(element, 'Generating commit message. Click to stop.')).toBe(true)
    ;(button.props.onClick as () => void)()
    expect(onCancelGenerate).toHaveBeenCalledTimes(1)
  })

  it('shows generation errors separately from commit errors and links them to the textarea', () => {
    const element = CommitArea({
      ...baseProps(),
      commitError: null,
      generateError: 'No staged changes to summarize.'
    })

    expect(hasText(element, 'No staged changes to summarize.')).toBe(true)
    expect(findTextarea(element).props['aria-describedby']).toBe('commit-area-generate-error')
  })

  it('continues to render the split commit button alongside generation controls', () => {
    const element = CommitArea({ ...baseProps(), aiEnabled: true, aiAgentConfigured: true })
    let primaryFound = false
    visit(element, (entry) => {
      if (entry.type === Button) {
        primaryFound = true
      }
    })

    expect(primaryFound).toBe(true)
  })
})
