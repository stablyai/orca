import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  getNextSourceControlViewMode,
  shouldShowSourceControlCompareUnavailableCard,
  SourceControlHeaderToolbar
} from './source-control-header-toolbar'
import type { PrimaryAction } from './source-control-primary-action'
import type { GitBranchCompareSummary } from '../../../../shared/types'

const readySummary: GitBranchCompareSummary = {
  baseRef: 'origin/main',
  baseOid: 'base',
  compareRef: 'feature',
  headOid: 'head',
  mergeBase: 'base',
  changedFiles: 2,
  commitsAhead: 1,
  status: 'ready'
}

function renderCreatePrHeaderButton(disabled: boolean): string {
  const action: PrimaryAction = {
    kind: 'create_pr',
    label: 'Create PR',
    title: disabled ? 'Push the branch first' : 'Create pull request',
    disabled
  }
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(SourceControlHeaderToolbar, {
        filterQuery: '',
        filterExpanded: false,
        onFilterQueryChange: () => undefined,
        onFilterExpandedChange: () => undefined,
        visibleCreatePrHeaderAction: action,
        hostedReview: null,
        isCreatePrIntentInFlight: false,
        isCreatingPr: false,
        onCreatePrHeaderClick: () => undefined,
        onOpenHostedReviewInChecks: () => undefined,
        sourceControlViewMode: 'list',
        viewModeToggleDisabled: false,
        onToggleViewMode: () => undefined,
        onChangeBaseRef: () => undefined,
        onRefreshBranchCompare: () => undefined,
        branchCompareRefreshDisabled: false,
        diffCommentCount: 0,
        onExpandNotes: () => undefined,
        branchSummary: null,
        compareBaseRef: null
      })
    )
  )
}

function buttonByText(markup: string, text: string): string {
  const button = [...markup.matchAll(/<button\b[\s\S]*?<\/button>/g)]
    .map((match) => match[0])
    .find((entry) => entry.includes(text))
  if (!button) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

describe('source-control header toolbar helpers', () => {
  it('toggles list and tree view modes', () => {
    expect(getNextSourceControlViewMode('list')).toBe('tree')
    expect(getNextSourceControlViewMode('tree')).toBe('list')
  })

  it('shows the compare-unavailable card only when compare failed and the body is empty', () => {
    expect(
      shouldShowSourceControlCompareUnavailableCard(
        { ...readySummary, status: 'error', errorMessage: 'nope' },
        false,
        false,
        false
      )
    ).toBe(true)

    expect(
      shouldShowSourceControlCompareUnavailableCard(
        { ...readySummary, status: 'error', errorMessage: 'nope' },
        true,
        false,
        false
      )
    ).toBe(false)

    expect(
      shouldShowSourceControlCompareUnavailableCard(
        { ...readySummary, status: 'error', errorMessage: 'nope' },
        false,
        true,
        false
      )
    ).toBe(false)

    expect(shouldShowSourceControlCompareUnavailableCard(readySummary, false, false, false)).toBe(
      false
    )

    expect(
      shouldShowSourceControlCompareUnavailableCard(
        { ...readySummary, status: 'loading' },
        false,
        false,
        false
      )
    ).toBe(false)
  })

  it('keeps the enabled Create PR header action as the direct tooltip trigger', () => {
    const button = buttonByText(renderCreatePrHeaderButton(false), 'Create PR')

    expect(button).toContain('data-slot="tooltip-trigger"')
    expect(button).not.toContain('disabled=""')
  })

  it('wraps only the disabled Create PR header action so its reason remains hoverable', () => {
    const markup = renderCreatePrHeaderButton(true)
    const button = buttonByText(markup, 'Create PR')

    expect(button).not.toContain('data-slot="tooltip-trigger"')
    expect(button).toContain('disabled=""')
    expect(markup).toMatch(
      /<span[^>]*data-slot="tooltip-trigger"[^>]*><button[^>]*disabled=""[\s\S]*?Create PR/
    )
  })
})
