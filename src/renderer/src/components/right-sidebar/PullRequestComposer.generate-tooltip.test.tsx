// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { useState } from 'react'
import { cleanup, fireEvent, render as renderDom, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CreateHostedReviewComposer } from './CreateHostedReviewComposer'
import type { HostedReviewStackParent } from './useHostedReviewStackParent'
import { resolveDropdownItems } from './source-control-dropdown-items'
import { resolvePrimaryAction } from './source-control-primary-action'

type RenderPullRequestComposerOptions = {
  aiGenerationEnabled?: boolean
  generating?: boolean
  generateDisabled?: boolean
  generateDisabledReason?: string
  stackedCreationSupported?: boolean
  stackParentReview?: HostedReviewStackParent | null
  base?: string
  setBase?: (value: string) => void
  baseQuery?: string
  setBaseQuery?: (value: string) => void
  baseResults?: string[]
  setBaseResults?: (value: string[]) => void
  baseSearchPending?: boolean
  repoDefaultBase?: string | null
  onPrimaryAction?: (stacked: boolean) => void
}

const EMPTY_BASE_RESULTS: string[] = []

function pullRequestComposerElement({
  aiGenerationEnabled = true,
  generating = false,
  generateDisabled = false,
  generateDisabledReason,
  stackedCreationSupported = true,
  stackParentReview = null,
  base = 'master',
  setBase = vi.fn(),
  baseQuery = '',
  setBaseQuery = vi.fn(),
  baseResults = [],
  setBaseResults = vi.fn(),
  baseSearchPending = false,
  repoDefaultBase = 'main',
  onPrimaryAction = vi.fn()
}: RenderPullRequestComposerOptions = {}): React.JSX.Element {
  const sourceControlInputs = {
    stagedCount: 1,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: true,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 }
  }
  const primaryAction = resolvePrimaryAction(sourceControlInputs)

  return (
    <TooltipProvider>
      <CreateHostedReviewComposer
        provider="github"
        branch="branch-login-issue"
        base={base}
        setBase={setBase}
        repoDefaultBase={repoDefaultBase}
        title="Ready to create"
        setTitle={vi.fn()}
        body=""
        setBody={vi.fn()}
        draft={false}
        setDraft={vi.fn()}
        stackedCreationSupported={stackedCreationSupported}
        stackParentReview={stackParentReview}
        baseQuery={baseQuery}
        setBaseQuery={setBaseQuery}
        baseResults={baseResults}
        setBaseResults={setBaseResults}
        baseSearchPending={baseSearchPending}
        baseSearchError={null}
        aiGenerationEnabled={aiGenerationEnabled}
        generating={generating}
        generateDisabled={generateDisabled}
        generateDisabledReason={generateDisabledReason}
        generateError={null}
        createError={null}
        isCreating={false}
        primaryAction={primaryAction}
        dropdownItems={resolveDropdownItems(sourceControlInputs)}
        onGenerate={vi.fn()}
        onCancelGenerate={vi.fn()}
        onPrimaryAction={onPrimaryAction}
        onDropdownAction={vi.fn()}
      />
    </TooltipProvider>
  )
}

function renderPullRequestComposer(options: RenderPullRequestComposerOptions = {}): string {
  return renderToStaticMarkup(pullRequestComposerElement(options))
}

function InteractiveBaseComposer({
  baseResults = EMPTY_BASE_RESULTS,
  baseSearchPending = false,
  stackParentReview = null,
  repoDefaultBase = 'main',
  initialBase = 'main',
  onPrimaryAction
}: {
  baseResults?: string[]
  baseSearchPending?: boolean
  stackParentReview?: HostedReviewStackParent | null
  repoDefaultBase?: string | null
  initialBase?: string
  onPrimaryAction?: (stacked: boolean) => void
}) {
  const [base, setBase] = useState(initialBase)
  const [baseQuery, setBaseQuery] = useState('')
  const [results, setBaseResults] = useState(baseResults)

  return pullRequestComposerElement({
    base,
    setBase,
    baseQuery,
    setBaseQuery,
    baseResults: results,
    setBaseResults,
    baseSearchPending,
    stackParentReview,
    repoDefaultBase,
    ...(onPrimaryAction ? { onPrimaryAction } : {})
  })
}

function elementByLabel(markup: string, tagName: string, label: string): string {
  const element = [...markup.matchAll(new RegExp(`<${tagName}\\b[\\s\\S]*?</${tagName}>`, 'g'))]
    .map((match) => match[0])
    .find((entry) => entry.includes(`aria-label="${label}"`))

  if (!element) {
    throw new Error(`${tagName} not found: ${label}`)
  }

  return element
}

describe('CreateHostedReviewComposer generate tooltip', () => {
  afterEach(cleanup)

  it('renders hosted review labels without leaking interpolation placeholders', () => {
    const markup = renderPullRequestComposer()

    expect(markup).toContain('aria-label="Generate pull request details with AI"')
    expect(markup).not.toContain('{{value0}}')
    expect(markup).not.toContain('title="Generate {{value0}} details with AI"')
  })

  it('hides hosted review generation controls when Source Control AI actions are hidden', () => {
    const markup = renderPullRequestComposer({ aiGenerationEnabled: false })

    expect(markup).not.toContain('Generate pull request details with AI')
    expect(markup).toContain('Create')
  })

  it('keeps enabled generation controls as direct tooltip triggers', () => {
    const markup = renderPullRequestComposer()
    const button = elementByLabel(markup, 'button', 'Generate pull request details with AI')

    expect(button).toContain('data-slot="tooltip-trigger"')
  })

  it('wraps only disabled generation controls so the disabled reason can show on hover', () => {
    const markup = renderPullRequestComposer({
      generateDisabled: true,
      generateDisabledReason: 'Stage changes before generating.'
    })
    const wrapper = elementByLabel(markup, 'span', 'Generate pull request details with AI')
    const button = elementByLabel(markup, 'button', 'Generate pull request details with AI')

    expect(wrapper).toContain('data-slot="tooltip-trigger"')
    expect(button).toContain('disabled=""')
    expect(button).toContain('data-slot="button"')
  })

  it('keeps the active stop control focusable as the tooltip trigger', () => {
    const markup = renderPullRequestComposer({ generating: true, generateDisabled: true })
    const button = elementByLabel(markup, 'button', 'Stop generating pull request details')

    expect(button).toContain('data-slot="tooltip-trigger"')
    expect(button).not.toContain('disabled=""')
  })

  it('does not ask for a PR type without an open parent review', () => {
    const markup = renderPullRequestComposer()

    expect(markup).not.toContain('Regular PR')
    expect(markup).not.toContain('Stacked PR')
    expect(markup).not.toContain('Stack this PR above')
  })

  it('shows the parent-child preview and stack create action for an open parent review', () => {
    const onPrimaryAction = vi.fn()
    const { container } = renderDom(
      pullRequestComposerElement({
        stackParentReview: { number: 13741, url: 'https://github.com/stablyai/orca/pull/13741' },
        onPrimaryAction
      })
    )

    // Unchecked, the helper explains the effect rather than repeating the base ref.
    expect(container.innerHTML).toContain(
      "Creates a GitHub Stack or extends the parent's existing stack."
    )

    fireEvent.click(screen.getByRole('checkbox', { name: /Stack this PR above #13741/ }))

    const markup = container.innerHTML

    expect(markup).toContain('#13741')
    expect(markup).toContain('master')
    expect(markup).toContain('branch-login-issue')
    expect(markup).toContain('Create PR in stack')

    fireEvent.click(screen.getByRole('button', { name: /Create PR in stack/ }))
    expect(onPrimaryAction).toHaveBeenCalledWith(true)
  })

  it('drives both options through the shadcn Checkbox primitive', () => {
    const { container } = renderDom(
      pullRequestComposerElement({
        stackParentReview: { number: 13741, url: 'https://github.com/stablyai/orca/pull/13741' }
      })
    )

    expect(container.querySelectorAll('[data-slot="checkbox"]')).toHaveLength(2)
    // Radix keeps a hidden native input for form participation; nothing browser-native renders.
    for (const native of container.querySelectorAll('input[type="checkbox"]')) {
      expect(native.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('labels the base field above a full-width combobox and names the head branch', () => {
    renderDom(<InteractiveBaseComposer />)
    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })

    expect(screen.getByText('Base branch').getAttribute('for')).toBe(input.id)
    expect(input.className).toContain('w-full')
    expect(screen.getByText('from branch-login-issue')).toBeTruthy()
  })

  it('marks the base field invalid when it matches the head branch', () => {
    const { container } = renderDom(pullRequestComposerElement({ base: 'branch-login-issue' }))
    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })

    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(container.innerHTML).toContain(
      'Choose a different base branch before creating a pull request.'
    )
  })

  it('moves through base results with the arrow keys and commits the highlighted ref', () => {
    renderDom(
      <InteractiveBaseComposer
        baseResults={['release/candidate', 'release/next', 'release/prev']}
      />
    )
    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })

    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'release/next' }).id
    )

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLInputElement).value).toBe('release/candidate')
  })

  it('withholds the empty-result message until the base search settles', () => {
    const { rerender } = renderDom(<InteractiveBaseComposer baseSearchPending />)
    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'nope' } })
    expect(screen.queryByText(/No branches match/)).toBeNull()

    rerender(<InteractiveBaseComposer baseSearchPending={false} />)
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'nope' } })
    expect(screen.getByText(/No branches match “nope”/)).toBeTruthy()
  })

  it('commits the repo default when the base field is cleared', () => {
    renderDom(<InteractiveBaseComposer initialBase="feature/parent" repoDefaultBase="main" />)
    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText('Leave empty to use main.')).toBeTruthy()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLInputElement).value).toBe('main')
  })

  it('commits the repo default when an emptied field loses focus', () => {
    renderDom(<InteractiveBaseComposer initialBase="feature/parent" repoDefaultBase="main" />)
    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect((input as HTMLInputElement).value).toBe('main')
  })

  it('cancels a partial query on blur instead of committing it', () => {
    renderDom(<InteractiveBaseComposer initialBase="feature/parent" repoDefaultBase="main" />)
    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'rele' } })
    fireEvent.blur(input)

    expect((input as HTMLInputElement).value).toBe('feature/parent')
  })

  it('restores the committed base when an emptied field is cancelled', () => {
    renderDom(<InteractiveBaseComposer initialBase="feature/parent" repoDefaultBase="main" />)
    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect((input as HTMLInputElement).value).toBe('feature/parent')
  })

  it('keeps the committed base when no repo default has resolved yet', () => {
    renderDom(<InteractiveBaseComposer initialBase="feature/parent" repoDefaultBase={null} />)
    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByText(/Leave empty to use/)).toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLInputElement).value).toBe('feature/parent')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect((input as HTMLInputElement).value).toBe('feature/parent')
  })

  it('drops a stack choice when the base moves off the parent it was made for', () => {
    // The choice is keyed to base+parent, so a base change can never submit a stacked
    // create for a parent the composer is no longer showing.
    const onPrimaryAction = vi.fn()
    renderDom(
      <InteractiveBaseComposer
        initialBase="feature/parent"
        baseResults={['release/candidate']}
        stackParentReview={{ number: 13741, url: 'https://github.com/stablyai/orca/pull/13741' }}
        onPrimaryAction={onPrimaryAction}
      />
    )

    fireEvent.click(screen.getByRole('checkbox', { name: /Stack this PR above #13741/ }))
    expect(screen.getByRole('button', { name: /Create PR in stack/ })).toBeTruthy()

    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'release/candidate' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.queryByRole('button', { name: /in stack/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Create PR$/ }))
    expect(onPrimaryAction).toHaveBeenCalledWith(false)
  })

  it('hides the stack option while the base search is open', () => {
    renderDom(
      <InteractiveBaseComposer
        baseResults={['release/candidate']}
        stackParentReview={{ number: 13741, url: 'https://github.com/stablyai/orca/pull/13741' }}
      />
    )

    expect(screen.getByRole('checkbox', { name: /Stack this PR above #13741/ })).toBeTruthy()

    fireEvent.focus(screen.getByRole('combobox', { name: 'Pull Request base branch' }))
    expect(screen.queryByRole('checkbox', { name: /Stack this PR above/ })).toBeNull()
  })

  it('hides stacked creation when the executing host lacks the capability', () => {
    const markup = renderPullRequestComposer({
      stackedCreationSupported: false,
      stackParentReview: { number: 13741, url: 'https://github.com/stablyai/orca/pull/13741' }
    })

    expect(markup).not.toContain('Stack this PR above #13741')
  })

  it('keeps temporary base search text separate from the committed branch', () => {
    renderDom(<InteractiveBaseComposer />)
    const input = screen.getByRole('combobox', { name: 'Pull Request base branch' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    expect((input as HTMLInputElement).value).toBe('')

    fireEvent.change(input, { target: { value: 'release/candidate' } })
    expect((input as HTMLInputElement).value).toBe('release/candidate')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect((input as HTMLInputElement).value).toBe('main')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'release/candidate' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLInputElement).value).toBe('release/candidate')
  })

  it('places base search results directly under the combobox', () => {
    const { container } = renderDom(<InteractiveBaseComposer baseResults={['release/candidate']} />)
    fireEvent.focus(screen.getByRole('combobox', { name: 'Pull Request base branch' }))

    const markup = container.innerHTML
    expect(markup.indexOf('release/candidate')).toBeLessThan(markup.indexOf('Create as draft'))
  })
})
