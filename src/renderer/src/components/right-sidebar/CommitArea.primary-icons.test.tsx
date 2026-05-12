import { describe, expect, it, vi } from 'vitest'
import { ArrowDownUp, ArrowUp, CloudUpload, Plus } from 'lucide-react'
import { CommitArea } from './SourceControl'
import { Button } from '@/components/ui/button'
import { resolvePrimaryAction, type PrimaryActionInputs } from './source-control-primary-action'
import { resolveDropdownItems, type DropdownActionKind } from './source-control-dropdown-items'

// Why: split out from CommitArea.test.tsx so each file stays under the
// project's max-lines budget. These tests cover the directional-icon
// mapping for primary action kinds (push / pull / sync / publish); the
// commit-checkmark and core CommitArea behaviour live in the sibling file.

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

function primaryHasIcon(node: unknown, icon: unknown): boolean {
  const primary = findPrimaryButton(node)
  let found = false
  visit(primary, (entry) => {
    if (entry.type === icon) {
      found = true
    }
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
    isRemoteOperationActive: inputs.isRemoteOperationActive,
    inFlightRemoteOpKind: inputs.inFlightRemoteOpKind ?? null,
    primaryAction: resolvePrimaryAction(inputs),
    dropdownItems: resolveDropdownItems(inputs),
    onCommitMessageChange: vi.fn(),
    onPrimaryAction: vi.fn(),
    onDropdownAction: vi.fn() as (kind: DropdownActionKind) => void
  }
}

// Why: remote primaries other than Pull are anchored by a directional
// icon — Push ↑, Sync ↕, Publish ☁︎↑. Pull is intentionally icon-less
// because the down-arrow read as a download/save affordance.
describe('CommitArea primary action icons', () => {
  it('renders an up-arrow on a Push primary', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 }
    })
    const element = CommitArea(props)
    expect(primaryHasIcon(element, ArrowUp)).toBe(true)
  })

  it('renders no directional icon on a Pull primary', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 1 }
    })
    const element = CommitArea(props)
    expect(primaryHasIcon(element, ArrowUp)).toBe(false)
    expect(primaryHasIcon(element, ArrowDownUp)).toBe(false)
    expect(primaryHasIcon(element, CloudUpload)).toBe(false)
  })

  it('renders a bidirectional arrow on a Sync primary', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 1, behind: 1 }
    })
    const element = CommitArea(props)
    expect(primaryHasIcon(element, ArrowDownUp)).toBe(true)
  })

  it('renders a cloud-up icon on a Publish primary', () => {
    const props = baseProps({
      stagedCount: 0,
      hasMessage: false,
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    })
    const element = CommitArea(props)
    expect(primaryHasIcon(element, CloudUpload)).toBe(true)
  })

  // Why: a dirty tree with nothing staged surfaces 'Stage Files' as the
  // primary, anchored by a Plus icon to read as an additive bulk action.
  it('renders a plus icon on a Stage Files primary', () => {
    const props = baseProps({
      stagedCount: 0,
      hasUnstagedChanges: true,
      hasMessage: false,
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
    })
    const element = CommitArea(props)
    expect(primaryHasIcon(element, Plus)).toBe(true)
  })
})
