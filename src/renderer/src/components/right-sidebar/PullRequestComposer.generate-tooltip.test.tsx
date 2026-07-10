import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CreateHostedReviewComposer } from './CreateHostedReviewComposer'
import { resolveDropdownItems } from './source-control-dropdown-items'
import { resolvePrimaryAction } from './source-control-primary-action'

type RenderPullRequestComposerOptions = {
  aiGenerationEnabled?: boolean
  generating?: boolean
  generateDisabled?: boolean
  generateDisabledReason?: string
}

function renderPullRequestComposer({
  aiGenerationEnabled = true,
  generating = false,
  generateDisabled = false,
  generateDisabledReason
}: RenderPullRequestComposerOptions = {}): string {
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

  return renderToStaticMarkup(
    <TooltipProvider>
      <CreateHostedReviewComposer
        provider="github"
        branch="branch-login-issue"
        base="master"
        setBase={vi.fn()}
        title=""
        setTitle={vi.fn()}
        body=""
        setBody={vi.fn()}
        draft={false}
        setDraft={vi.fn()}
        baseQuery=""
        setBaseQuery={vi.fn()}
        baseResults={[]}
        setBaseResults={vi.fn()}
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
        onPrimaryAction={vi.fn()}
        onDropdownAction={vi.fn()}
      />
    </TooltipProvider>
  )
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
})
