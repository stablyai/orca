import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CommitArea } from './SourceControl'
import { resolvePrimaryAction, type PrimaryActionInputs } from './source-control-primary-action'
import { resolveDropdownItems, type DropdownActionKind } from './source-control-dropdown-items'

// Why: split out from CommitArea.test.tsx so each file stays under the
// project's max-lines budget. These tests cover the chevron spinner
// behaviour for dropdown-only ops (Fetch) and the no-double-spin guard
// when the primary button already hosts the in-flight indicator.

function buildInputs(overrides: Partial<PrimaryActionInputs> = {}): PrimaryActionInputs {
  return {
    stagedCount: 1,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
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
    worktreeId: 'wt-1',
    groupId: 'group-1',
    commitMessage: 'feat: add commit area',
    commitError: null as string | null,
    commitFailureRecoveryPrompt: null as string | null,
    remoteActionError: null as string | null,
    isCommitting: inputs.isCommitting,
    isFixingCommitFailureWithAI: false,
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
    onFixCommitFailureWithAI: vi.fn(),
    onPrimaryAction: vi.fn(),
    onDropdownAction: vi.fn() as (kind: DropdownActionKind) => void
  }
}

function buttons(markup: string): string[] {
  return [...markup.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((match) => match[0])
}

function renderButtons(props: ReturnType<typeof baseProps>): string[] {
  return buttons(
    renderToStaticMarkup(
      <TooltipProvider>
        <CommitArea {...props} />
      </TooltipProvider>
    )
  )
}

describe('CommitArea chevron spinner', () => {
  it('spins the chevron while a dropdown Fetch is in flight', () => {
    const [primary, chevron] = renderButtons(
      baseProps({
        stagedCount: 0,
        hasMessage: false,
        upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 },
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'fetch'
      })
    )
    expect(chevron).toContain('animate-spin')
    expect(primary).not.toContain('animate-spin')
  })

  it('does not spin the chevron when the primary already hosts the in-flight op', () => {
    const [primary, chevron] = renderButtons(
      baseProps({
        stagedCount: 0,
        hasMessage: false,
        upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 },
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'push'
      })
    )
    expect(primary).toContain('animate-spin')
    expect(chevron).not.toContain('animate-spin')
  })

  it('does not spin the chevron when a dropdown op is mirrored onto the primary', () => {
    const [primary, chevron] = renderButtons(
      baseProps({
        stagedCount: 0,
        hasMessage: false,
        upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 },
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'sync'
      })
    )
    expect(primary).toContain('animate-spin')
    expect(chevron).not.toContain('animate-spin')
  })

  it('spins the chevron when a dropdown remote op runs while the primary is plain Commit', () => {
    const [primary, chevron] = renderButtons(
      baseProps({
        stagedCount: 1,
        hasMessage: false,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'fetch'
      })
    )
    expect(primary).not.toContain('animate-spin')
    expect(chevron).toContain('animate-spin')
  })
})
