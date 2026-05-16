import { describe, expect, it, vi } from 'vitest'
import { RefreshCw } from 'lucide-react'
import { CommitArea } from './SourceControl'
import { Button } from '@/components/ui/button'
import { resolvePrimaryAction, type PrimaryActionInputs } from './source-control-primary-action'
import { resolveDropdownItems, type DropdownActionKind } from './source-control-dropdown-items'

// Why: split out from CommitArea.test.tsx so each file stays under the
// project's max-lines budget. These tests cover the chevron spinner
// behaviour for dropdown-only ops (Fetch) and the no-double-spin guard
// when the primary button already hosts the in-flight indicator.

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

function findButtons(node: unknown): ReactElementLike[] {
  const buttons: ReactElementLike[] = []
  visit(node, (entry) => {
    if (entry.type === Button) {
      buttons.push(entry)
    }
  })
  return buttons
}

function buttonHasSpinner(button: ReactElementLike): boolean {
  let found = false
  visit(button, (entry) => {
    if (entry.type === RefreshCw) {
      found = true
    }
  })
  return found
}

function primaryHasSpinner(node: unknown): boolean {
  const buttons = findButtons(node)
  if (buttons.length === 0) {
    throw new Error('primary button not found')
  }
  return buttonHasSpinner(buttons[0]!)
}

function chevronHasSpinner(node: unknown): boolean {
  const buttons = findButtons(node)
  if (buttons.length < 2) {
    throw new Error('chevron button not found')
  }
  return buttonHasSpinner(buttons[1]!)
}

function buildInputs(overrides: Partial<PrimaryActionInputs> = {}): PrimaryActionInputs {
  return {
    stagedCount: 1,
    hasUnstagedChanges: false,
    hasPartiallyStagedChanges: false,
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
    remoteActionError: null as string | null,
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

describe('CommitArea chevron spinner', () => {
  // Why: when the primary can't host the in-flight op (Fetch is the
  // canonical case — it's dropdown-only) the click would otherwise be
  // silent: the toast only fires on failure and a no-op fetch leaves
  // upstream counts unchanged. Spinning the chevron gives the user
  // immediate "yes, your click did something" feedback.
  it('spins the chevron while a dropdown Fetch is in flight', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 },
      isRemoteOperationActive: true,
      inFlightRemoteOpKind: 'fetch'
    })
    const element = CommitArea(props)
    expect(chevronHasSpinner(element)).toBe(true)
    expect(primaryHasSpinner(element)).toBe(false)
  })

  // Why: avoid double-spinning. When the primary is already spinning for
  // an op it hosts (e.g. user clicked Push from the dropdown and the
  // primary mirrors "Push"), the chevron stays as a chevron — one
  // spinner per button surface, anchored to the action the label names.
  it('does not spin the chevron when the primary already hosts the in-flight op', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 },
      isRemoteOperationActive: true,
      inFlightRemoteOpKind: 'push'
    })
    const element = CommitArea(props)
    expect(primaryHasSpinner(element)).toBe(true)
    expect(chevronHasSpinner(element)).toBe(false)
  })

  // Why: a dropdown Sync from a Push-natural state mirrors onto the
  // primary (label flips to "Sync"), so the primary already carries the
  // spinner. The chevron should not double-spin in that case.
  it('does not spin the chevron when a dropdown op is mirrored onto the primary', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 },
      isRemoteOperationActive: true,
      inFlightRemoteOpKind: 'sync'
    })
    const element = CommitArea(props)
    expect(primaryHasSpinner(element)).toBe(true)
    expect(chevronHasSpinner(element)).toBe(false)
  })

  // Why: the plain-Commit primary is the scenario from the original Fetch
  // bug — empty message + dropdown Fetch left both buttons static. The
  // chevron must spin so the user sees feedback even though the primary
  // can't (showing a spinner on a disabled "Commit" would mis-narrate).
  it('spins the chevron when a dropdown remote op runs while the primary is plain Commit', () => {
    const props = baseProps({
      stagedCount: 1,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
      isRemoteOperationActive: true,
      inFlightRemoteOpKind: 'fetch'
    })
    const element = CommitArea(props)
    expect(primaryHasSpinner(element)).toBe(false)
    expect(chevronHasSpinner(element)).toBe(true)
  })
})
