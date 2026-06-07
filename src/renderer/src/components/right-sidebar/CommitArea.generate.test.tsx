import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CommitArea } from './SourceControl'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resolvePrimaryAction, type PrimaryActionInputs } from './source-control-primary-action'
import { resolveDropdownItems, type DropdownActionKind } from './source-control-dropdown-items'

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
    showComposer: true,
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

function renderCommitArea(props: ReturnType<typeof baseProps>): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <CommitArea {...props} />
    </TooltipProvider>
  )
}

function buttonByLabel(markup: string, label: string): string {
  const button = [...markup.matchAll(/<button\b[\s\S]*?<\/button>/g)]
    .map((match) => match[0])
    .find((entry) => entry.includes(`aria-label="${label}"`))
  if (!button) {
    throw new Error(`button not found: ${label}`)
  }
  return button
}

function hasDisabledAttribute(markup: string): boolean {
  return markup.includes(' disabled=""')
}

describe('CommitArea AI generation', () => {
  it('does not render the AI generate affordance when the feature is disabled', () => {
    expect(renderCommitArea(baseProps())).not.toContain(
      'aria-label="Generate commit message with AI"'
    )
  })

  it('enables AI generation only when an agent is configured, changes are staged, and the message is empty', () => {
    const props = baseProps({ hasMessage: false })
    const markup = renderCommitArea({
      ...props,
      commitMessage: '',
      aiEnabled: true,
      aiAgentConfigured: true
    })

    expect(hasDisabledAttribute(buttonByLabel(markup, 'Generate commit message with AI'))).toBe(
      false
    )
  })

  it('disables AI generation when the textarea already has user text', () => {
    const markup = renderCommitArea({
      ...baseProps(),
      aiEnabled: true,
      aiAgentConfigured: true
    })

    const button = buttonByLabel(markup, 'Generate commit message with AI')
    expect(hasDisabledAttribute(button)).toBe(true)
    expect(button).toContain('title="Clear the message to regenerate."')
  })

  it('disables AI generation until the configured agent can actually run', () => {
    const props = baseProps({ hasMessage: false })
    const markup = renderCommitArea({
      ...props,
      commitMessage: '',
      aiEnabled: true,
      aiAgentConfigured: false
    })

    const button = buttonByLabel(markup, 'Generate commit message with AI')
    expect(hasDisabledAttribute(button)).toBe(true)
    expect(button).toContain('Pick an agent in Settings')
  })

  it('turns the generating icon into a stop affordance', () => {
    const props = baseProps({ hasMessage: false })
    const markup = renderCommitArea({
      ...props,
      commitMessage: '',
      aiEnabled: true,
      aiAgentConfigured: true,
      isGenerating: true
    })

    const button = buttonByLabel(markup, 'Stop generating commit message')
    expect(button).toContain('title="Stop generating"')
    expect(button).toContain('lucide-refresh-cw')
    expect(button).toContain('lucide-square')
  })

  it('shows generation errors separately from commit errors and links them to the textarea', () => {
    const markup = renderCommitArea({
      ...baseProps(),
      commitError: null,
      generateError: 'No staged changes to summarize.'
    })

    expect(markup).toContain('No staged changes to summarize.')
    expect(markup).toContain('aria-describedby="commit-area-generate-error"')
  })

  it('continues to render the split commit button alongside generation controls', () => {
    const markup = renderCommitArea({
      ...baseProps(),
      aiEnabled: true,
      aiAgentConfigured: true
    })
    expect(markup).toContain('Commit')
    expect(markup).toContain('aria-label="Generate commit message with AI"')
  })

  it('can hide only the composer while keeping the split action surface visible', () => {
    const markup = renderCommitArea({
      ...baseProps({ hasMessage: false, stagedCount: 0 }),
      commitMessage: '',
      aiEnabled: true,
      aiAgentConfigured: true,
      showComposer: false
    })

    expect(markup).not.toContain('aria-label="Commit message"')
    expect(markup).not.toContain('aria-label="Generate commit message with AI"')
    expect(markup).toContain('Nothing to commit')
    expect(markup).toContain('aria-label="More commit and remote actions"')
  })
})
