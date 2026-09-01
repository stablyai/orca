import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GitOperationProgress } from '../../../../../../shared/git-status-types'
import { ConflictSummaryCard, OperationBanner } from './conflict-status-cards'

function buttonContaining(markup: string, label: string): string {
  const match = markup.match(
    new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}[\\s\\S]*?</button>`)
  )
  return match?.[0] ?? ''
}

const handlers = {
  onAbortOperation: vi.fn(),
  onContinueOperation: vi.fn(),
  onResolveWithAI: vi.fn()
}

const progress: GitOperationProgress = {
  headName: 'triage-e2e',
  onto: 'origin/main',
  currentStep: 3,
  totalSteps: 7,
  commitSubject: 'ci: split the e2e shards',
  stoppedBy: 'pick'
}

const render = (props: Partial<React.ComponentProps<typeof OperationBanner>> = {}) =>
  renderToStaticMarkup(
    <OperationBanner
      conflictOperation="rebase"
      sourceControlAiActionsVisible
      operationProgress={progress}
      {...handlers}
      {...props}
    />
  )

describe('OperationBanner heading', () => {
  it('names the ref a rebase is replaying onto', () => {
    expect(render()).toContain('Rebasing onto origin/main')
  })

  // The banner is narrow; a full oid only gets CSS-truncated, which reads as broken.
  it('shortens a bare oid it is replaying onto', () => {
    const markup = render({
      operationProgress: { ...progress, onto: 'bc98655a3965fe350f77acb14bf4a53f1e2d3c4b' }
    })

    // 7 chars — the same abbreviation the head identity chip uses.
    expect(markup).toContain('Rebasing onto bc98655')
    expect(markup).not.toContain('bc98655a')
  })

  // Wire compatibility: a host that predates operationProgress omits it entirely.
  it('degrades to the plain in-progress banner when the host reported no progress', () => {
    const markup = render({ operationProgress: null })

    expect(markup).toContain('Rebase in progress')
    expect(markup).not.toContain('Rebasing onto')
  })

  it('keeps the banner to the heading — no step meter or replayed-commit subject', () => {
    const markup = render()

    expect(markup).not.toContain('3 / 7')
    expect(markup).not.toContain('ci: split the e2e shards')
  })
})

describe('OperationBanner actions', () => {
  it('leads with Continue and keeps AI and Abort quiet when no conflicts remain', () => {
    const markup = render()

    expect(buttonContaining(markup, 'Continue rebase')).toContain('data-variant="default"')
    expect(buttonContaining(markup, 'Resolve with AI')).toContain('data-variant="outline"')
    expect(buttonContaining(markup, 'Abort rebase')).toContain('data-variant="outline"')
  })

  it('offers no way to skip the commit being replayed', () => {
    expect(render()).not.toContain('Skip')
  })

  it('labels Continue for the operation actually running', () => {
    expect(render({ conflictOperation: 'merge' })).toContain('Continue merge')
    expect(render({ conflictOperation: 'cherry-pick' })).toContain('Continue cherry-pick')
    expect(render({ conflictOperation: 'rebase' })).toContain('Continue rebase')
  })

  it('hides Continue when the caller offers no handler for it', () => {
    const markup = renderToStaticMarkup(
      <OperationBanner
        conflictOperation="rebase"
        sourceControlAiActionsVisible
        onAbortOperation={vi.fn()}
        onResolveWithAI={vi.fn()}
      />
    )

    expect(markup).not.toContain('Continue rebase')
    expect(buttonContaining(markup, 'Resolve with AI')).toContain('data-variant="default"')
  })

  it('disables every action while an abort is in flight', () => {
    const markup = render({ isAbortingOperation: true })

    expect(buttonContaining(markup, 'Continue rebase')).toContain('disabled')
    expect(buttonContaining(markup, 'Abort rebase')).toContain('disabled')
    expect(buttonContaining(markup, 'Resolve with AI')).toContain('disabled')
  })

  it('disables every action while a continue is in flight', () => {
    const markup = render({ isAdvancingOperation: true })

    expect(buttonContaining(markup, 'Continue rebase')).toContain('disabled')
    expect(buttonContaining(markup, 'Abort rebase')).toContain('disabled')
    expect(buttonContaining(markup, 'Resolve with AI')).toContain('disabled')
  })
})

describe('ConflictSummaryCard', () => {
  const renderSummary = (
    props: Partial<React.ComponentProps<typeof ConflictSummaryCard>> = {}
  ): string =>
    renderToStaticMarkup(
      <ConflictSummaryCard
        conflictOperation="rebase"
        unresolvedCount={1}
        sourceControlAiActionsVisible
        isResolvingWithAI={false}
        onReview={vi.fn()}
        {...handlers}
        {...props}
      />
    )

  // Review opens a read-only view, so it must stay reachable while an agent resolves.
  it('keeps Review conflicts clickable while Resolve with AI is in flight', () => {
    const markup = renderSummary({ isResolvingWithAI: true })

    // `disabled=""` is the rendered attribute; a bare "disabled" also matches Tailwind's disabled: variants.
    expect(buttonContaining(markup, 'Review conflicts')).not.toContain('disabled=""')
    expect(buttonContaining(markup, 'Resolve with AI')).toContain('disabled=""')
    expect(buttonContaining(markup, 'Abort rebase')).toContain('disabled=""')
  })

  it('offers only Resolve with AI, Review and Abort while conflicts are unresolved', () => {
    const markup = renderSummary()

    expect(buttonContaining(markup, 'Resolve with AI')).toContain('data-variant="default"')
    expect(buttonContaining(markup, 'Review conflicts')).toContain('data-variant="outline"')
    expect(buttonContaining(markup, 'Abort rebase')).toContain('data-variant="outline"')
    // git refuses `--continue` while files are still unmerged.
    expect(markup).not.toContain('Continue rebase')
    expect(markup).not.toContain('Skip')
  })

  it('leads with exactly one primary — the rest are outlined alternatives', () => {
    expect(renderSummary().match(/data-variant="default"/g)).toHaveLength(1)
  })

  it('promotes Review conflicts when AI resolution is unavailable', () => {
    const markup = renderSummary({ sourceControlAiActionsVisible: false })

    expect(buttonContaining(markup, 'Review conflicts')).toContain('data-variant="default"')
    expect(buttonContaining(markup, 'Abort rebase')).toContain('data-variant="outline"')
  })

  it('stacks one full-width button per row: AI, then Review, then Abort', () => {
    const markup = renderSummary()

    for (const label of ['Resolve with AI', 'Review conflicts', 'Abort rebase']) {
      expect(buttonContaining(markup, label)).toContain('w-full')
      expect(buttonContaining(markup, label)).not.toContain('flex-1')
    }
    expect(markup.indexOf('Resolve with AI')).toBeLessThan(markup.indexOf('Review conflicts'))
    expect(markup.indexOf('Review conflicts')).toBeLessThan(markup.indexOf('Abort rebase'))
  })

  it('states the unresolved count without a meter, subject or recovery note', () => {
    const markup = renderSummary()

    expect(markup).toContain('Rebase conflicts: 1 unresolved')
    expect(markup).not.toContain('3 / 7')
    expect(markup).not.toContain('ci: split the e2e shards')
    expect(markup).not.toContain('Resolved files move back')
  })
})
