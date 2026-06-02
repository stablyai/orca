import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CommitArea, ConflictSummaryCard, OperationBanner } from './SourceControl'
import { resolvePrimaryAction, type PrimaryActionInputs } from './source-control-primary-action'
import { resolveDropdownItems, type DropdownActionKind } from './source-control-dropdown-items'
import { TooltipProvider } from '@/components/ui/tooltip'

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

function renderCommitArea(props: ReturnType<typeof baseProps>): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <CommitArea {...props} />
    </TooltipProvider>
  )
}

function firstButton(markup: string): string {
  const match = markup.match(/<button\b[\s\S]*?<\/button>/)
  if (!match) {
    throw new Error('button not found')
  }
  return match[0]
}

function buttonContaining(markup: string, label: string): string {
  const buttons = markup.match(/<button\b[\s\S]*?<\/button>/g) ?? []
  const button = buttons.find((candidate) => candidate.includes(label))
  if (!button) {
    throw new Error(`button not found: ${label}`)
  }
  return button
}

function textarea(markup: string): string {
  const match = markup.match(/<textarea\b[\s\S]*?<\/textarea>/)
  if (!match) {
    throw new Error('textarea not found')
  }
  return match[0]
}

function hasDisabledAttribute(markup: string): boolean {
  return markup.includes(' disabled=""')
}

describe('CommitArea', () => {
  it('disables the primary button when no staged files', () => {
    expect(hasDisabledAttribute(firstButton(renderCommitArea(baseProps({ stagedCount: 0 }))))).toBe(
      true
    )
  })

  it('disables the primary button when the commit message is empty', () => {
    const props = baseProps({ hasMessage: false })
    expect(
      hasDisabledAttribute(firstButton(renderCommitArea({ ...props, commitMessage: '   ' })))
    ).toBe(true)
  })

  it('disables the primary button when unresolved conflicts exist', () => {
    expect(
      hasDisabledAttribute(
        firstButton(renderCommitArea(baseProps({ hasUnresolvedConflicts: true })))
      )
    ).toBe(true)
  })

  it('enables the primary button when staged + message + no conflicts', () => {
    expect(hasDisabledAttribute(firstButton(renderCommitArea(baseProps())))).toBe(false)
  })

  it('keeps the textarea enabled while the commit is in flight', () => {
    const markup = renderCommitArea({
      ...baseProps({ isCommitting: true }),
      isCommitting: true
    })
    expect(textarea(markup)).not.toContain('disabled')
  })

  it('clears the message and keeps error hidden after a successful commit lifecycle', () => {
    const markup = renderCommitArea({ ...baseProps(), commitMessage: '' })
    expect(textarea(markup)).toContain('></textarea>')
    expect(markup).not.toContain('commit-area-error')
  })

  it('preserves the message and shows the summary after a failed commit lifecycle', () => {
    const markup = renderCommitArea({
      ...baseProps(),
      commitError: 'pre-commit hook failed'
    })
    expect(textarea(markup)).toContain('feat: add commit area')
    expect(markup).toContain('Pre-commit hook failed.')
  })

  it('locks the primary button while the commit is in flight', () => {
    const props = baseProps({ isCommitting: true })
    expect(
      hasDisabledAttribute(firstButton(renderCommitArea({ ...props, isCommitting: true })))
    ).toBe(true)
  })

  it('shows a compact summary and not raw multiline text when the commit fails', () => {
    const raw = 'husky - pre-commit hook\neslint found 2 errors\nfull lint output line'
    const markup = renderCommitArea({ ...baseProps(), commitError: raw })

    expect(markup).toContain('id="commit-area-error"')
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('Lint failed during commit.')
    expect(markup).not.toContain('full lint output line')
    expect(markup).toContain('Fix')
    expect(markup).toContain('aria-label="Choose agent to fix commit failure"')
    expect(markup).toContain('Details')
  })

  it('disables the commit failure fix action while an AI launch is in progress', () => {
    const markup = renderCommitArea({
      ...baseProps(),
      commitError: 'husky - pre-commit hook failed',
      commitFailureRecoveryPrompt: 'Fix this commit failure.',
      isFixingCommitFailureWithAI: true
    })

    const button = [...markup.matchAll(/<button\b[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .find((entry) => entry.includes('aria-label="Fix commit failure with AI"'))

    expect(button).toBeDefined()
    expect(button).toContain('disabled=""')
    expect(button).toContain('animate-spin')
  })

  it('enables the agent picker when commit failure context is available', () => {
    const markup = renderCommitArea({
      ...baseProps(),
      commitError: 'husky - pre-commit hook failed',
      commitFailureRecoveryPrompt: 'Fix this commit failure.'
    })

    const picker = [...markup.matchAll(/<button\b[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .find((entry) => entry.includes('aria-label="Choose agent to fix commit failure"'))

    expect(picker).toBeDefined()
    expect(picker).not.toContain('disabled=""')
    expect(picker).toContain('lucide-chevron-down')
  })

  it('omits the details trigger when the raw error matches the summary', () => {
    const markup = renderCommitArea({ ...baseProps(), commitError: 'nothing to commit' })
    expect(markup).toContain('nothing to commit')
    expect(markup).not.toContain('Details')
  })

  it('shows an inline error message when a remote action fails', () => {
    const markup = renderCommitArea({
      ...baseProps(),
      remoteActionError: 'Fetch failed. network timeout'
    })
    expect(markup).toContain('Fetch failed. network timeout')
    expect(markup).toContain('commit-area-remote-error')
  })

  it('keeps generation errors separate from commit and remote errors', () => {
    const markup = renderCommitArea({
      ...baseProps(),
      generateError: 'No staged changes to summarize.'
    })
    expect(markup).toContain('No staged changes to summarize.')
    expect(markup).toContain('aria-describedby="commit-area-generate-error"')
  })

  it('keeps all visible errors linked to the textarea', () => {
    const markup = renderCommitArea({
      ...baseProps(),
      commitError: 'pre-commit hook failed',
      remoteActionError: 'Fetch failed.',
      generateError: 'No staged changes.'
    })
    expect(markup).toContain(
      'aria-describedby="commit-area-error commit-area-remote-error commit-area-generate-error"'
    )
  })

  it('keeps the primary button labelled Commit when the tree is staged, even with commits to push', () => {
    const markup = renderCommitArea(
      baseProps({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 }
      })
    )
    expect(firstButton(markup)).toContain('Commit')
    expect(firstButton(markup)).not.toContain('Commit &amp; Push')
  })

  it('does not show a spinner on a plain Commit primary when a dropdown remote op is running', () => {
    const markup = renderCommitArea(
      baseProps({
        stagedCount: 1,
        hasMessage: false,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        isCommitting: false,
        isRemoteOperationActive: true
      })
    )
    expect(firstButton(markup)).not.toContain('animate-spin')
  })

  it('shows a spinner on a Commit primary while the commit itself is in flight', () => {
    const props = baseProps({
      stagedCount: 1,
      hasMessage: true,
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
      isCommitting: true
    })
    expect(firstButton(renderCommitArea({ ...props, isCommitting: true }))).toContain(
      'animate-spin'
    )
  })

  it('shows a spinner on a remote primary while the matching remote op is active', () => {
    const markup = renderCommitArea(
      baseProps({
        stagedCount: 0,
        hasMessage: false,
        upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 },
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'push'
      })
    )
    expect(firstButton(markup)).toContain('animate-spin')
  })

  it('mirrors a dropdown-triggered Sync on the primary button while it runs', () => {
    const markup = renderCommitArea(
      baseProps({
        stagedCount: 0,
        hasMessage: false,
        upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 },
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'sync'
      })
    )
    expect(firstButton(markup)).toContain('Sync')
    expect(firstButton(markup)).not.toContain('Push')
    expect(firstButton(markup)).toContain('animate-spin')
  })

  it('does not spin or relabel the primary when a dropdown Fetch is in flight', () => {
    const markup = renderCommitArea(
      baseProps({
        stagedCount: 0,
        hasMessage: false,
        upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 },
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'fetch'
      })
    )
    expect(firstButton(markup)).toContain('Push')
    expect(hasDisabledAttribute(firstButton(markup))).toBe(true)
    expect(firstButton(markup)).not.toContain('animate-spin')
  })

  it('renders a leading checkmark on a Commit primary', () => {
    expect(firstButton(renderCommitArea(baseProps()))).toContain('lucide-check')
  })

  it('omits the checkmark when the primary is a remote action', () => {
    const markup = renderCommitArea(
      baseProps({
        stagedCount: 0,
        hasMessage: false,
        upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 }
      })
    )
    expect(firstButton(markup)).not.toContain('lucide-check')
  })

  it('replaces the checkmark with a spinner while the commit is in flight', () => {
    const props = baseProps({ isCommitting: true })
    const button = firstButton(renderCommitArea({ ...props, isCommitting: true }))
    expect(button).toContain('animate-spin')
    expect(button).not.toContain('lucide-check')
  })
})

describe('ConflictSummaryCard', () => {
  it('shows Resolve with AI above Review conflicts', () => {
    const markup = renderToStaticMarkup(
      <ConflictSummaryCard
        conflictOperation="rebase"
        unresolvedCount={1}
        isResolvingWithAI={false}
        onResolveWithAI={vi.fn()}
        onReview={vi.fn()}
      />
    )

    expect(markup.indexOf('Resolve with AI')).toBeLessThan(markup.indexOf('Review conflicts'))
  })

  it('shows the matching abort action for merge and rebase conflicts only', () => {
    const mergeMarkup = renderToStaticMarkup(
      <ConflictSummaryCard
        conflictOperation="merge"
        unresolvedCount={1}
        isResolvingWithAI={false}
        onAbortOperation={vi.fn()}
        onResolveWithAI={vi.fn()}
        onReview={vi.fn()}
      />
    )
    const rebaseMarkup = renderToStaticMarkup(
      <ConflictSummaryCard
        conflictOperation="rebase"
        unresolvedCount={1}
        isResolvingWithAI={false}
        onAbortOperation={vi.fn()}
        onResolveWithAI={vi.fn()}
        onReview={vi.fn()}
      />
    )
    const cherryPickMarkup = renderToStaticMarkup(
      <ConflictSummaryCard
        conflictOperation="cherry-pick"
        unresolvedCount={1}
        isResolvingWithAI={false}
        onAbortOperation={vi.fn()}
        onResolveWithAI={vi.fn()}
        onReview={vi.fn()}
      />
    )

    expect(mergeMarkup).toContain('Abort merge')
    expect(mergeMarkup).not.toContain('Abort rebase')
    expect(rebaseMarkup).toContain('Abort rebase')
    expect(rebaseMarkup).not.toContain('Abort merge')
    expect(cherryPickMarkup).not.toContain('Abort merge')
    expect(cherryPickMarkup).not.toContain('Abort rebase')
  })

  it('renders rebase abort with the quiet review-conflicts button treatment', () => {
    const markup = renderToStaticMarkup(
      <ConflictSummaryCard
        conflictOperation="rebase"
        unresolvedCount={1}
        isResolvingWithAI={false}
        onAbortOperation={vi.fn()}
        onResolveWithAI={vi.fn()}
        onReview={vi.fn()}
      />
    )

    expect(buttonContaining(markup, 'Review conflicts')).toContain('data-variant="ghost"')
    expect(buttonContaining(markup, 'Abort rebase')).toContain('data-variant="ghost"')
  })

  it('renders the Sparkles icon on the idle Resolve with AI button', () => {
    const markup = renderToStaticMarkup(
      <ConflictSummaryCard
        conflictOperation="merge"
        unresolvedCount={2}
        isResolvingWithAI={false}
        onResolveWithAI={vi.fn()}
        onReview={vi.fn()}
      />
    )

    expect(markup).toContain('Resolve with AI')
    expect(markup).toContain('lucide-sparkles')
    expect(markup).not.toMatch(/\blucide-sparkle(?!s)\b/)
  })
})

describe('OperationBanner', () => {
  it('shows abort actions for merge and rebase but not cherry-pick', () => {
    const mergeMarkup = renderToStaticMarkup(
      <OperationBanner conflictOperation="merge" onAbortOperation={vi.fn()} />
    )
    const rebaseMarkup = renderToStaticMarkup(
      <OperationBanner conflictOperation="rebase" onAbortOperation={vi.fn()} />
    )
    const cherryPickMarkup = renderToStaticMarkup(
      <OperationBanner conflictOperation="cherry-pick" onAbortOperation={vi.fn()} />
    )

    expect(mergeMarkup).toContain('Abort merge')
    expect(rebaseMarkup).toContain('Abort rebase')
    expect(cherryPickMarkup).not.toContain('Abort merge')
    expect(cherryPickMarkup).not.toContain('Abort rebase')
  })

  it('keeps rebase abort non-destructive while preserving merge abort styling', () => {
    const mergeMarkup = renderToStaticMarkup(
      <OperationBanner conflictOperation="merge" onAbortOperation={vi.fn()} />
    )
    const rebaseMarkup = renderToStaticMarkup(
      <OperationBanner conflictOperation="rebase" onAbortOperation={vi.fn()} />
    )

    expect(buttonContaining(mergeMarkup, 'Abort merge')).toContain('data-variant="destructive"')
    expect(buttonContaining(rebaseMarkup, 'Abort rebase')).toContain('data-variant="ghost"')
  })
})
