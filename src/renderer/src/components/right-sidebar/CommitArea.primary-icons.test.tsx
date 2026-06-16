import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CommitArea } from './SourceControl'
import { resolvePrimaryAction, type PrimaryActionInputs } from './source-control-primary-action'
import { resolveDropdownItems, type DropdownActionKind } from './source-control-dropdown-items'

// Why: split out from CommitArea.test.tsx so each file stays under the
// project's max-lines budget. These tests cover the directional-icon
// mapping for primary action kinds (push / pull / sync / publish); the
// commit-checkmark and core CommitArea behaviour live in the sibling file.

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

function primaryButton(props: ReturnType<typeof baseProps>): string {
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <CommitArea {...props} />
    </TooltipProvider>
  )
  const match = markup.match(/<button\b[\s\S]*?<\/button>/)
  if (!match) {
    throw new Error('primary button not found')
  }
  return match[0]
}

describe('CommitArea primary action icons', () => {
  it('renders an up-arrow on a Push primary', () => {
    expect(
      primaryButton(
        baseProps({
          stagedCount: 0,
          hasMessage: false,
          upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 }
        })
      )
    ).toContain('lucide-arrow-up')
  })

  it('renders no directional icon on a Pull primary', () => {
    const button = primaryButton(
      baseProps({
        stagedCount: 0,
        hasMessage: false,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 1 }
      })
    )
    expect(button).not.toContain('lucide-arrow-up')
    expect(button).not.toContain('lucide-arrow-down-up')
    expect(button).not.toContain('lucide-cloud-upload')
  })

  it('renders a bidirectional arrow on a Sync primary', () => {
    expect(
      primaryButton(
        baseProps({
          stagedCount: 0,
          hasMessage: false,
          upstreamStatus: { hasUpstream: true, ahead: 1, behind: 1 }
        })
      )
    ).toContain('lucide-arrow-down-up')
  })

  it('renders a cloud-up icon on a Publish primary', () => {
    expect(
      primaryButton(
        baseProps({
          stagedCount: 0,
          hasMessage: false,
          upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
        })
      )
    ).toContain('lucide-cloud-upload')
  })

  it('renders a plus icon on a Stage All primary', () => {
    expect(
      primaryButton(
        baseProps({
          stagedCount: 0,
          hasUnstagedChanges: true,
          hasStageableChanges: true,
          hasMessage: false,
          upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
        })
      )
    ).toContain('lucide-plus')
  })
})
