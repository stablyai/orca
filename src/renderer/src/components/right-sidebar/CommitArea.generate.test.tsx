import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CommitArea } from './SourceControl'
import {
  hasConfiguredCommitMessageGenerationDefaults,
  hasConfiguredSourceControlTextGenerationDefaults
} from './source-control-text-generation-defaults'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resolvePrimaryAction, type PrimaryActionInputs } from './source-control-primary-action'
import { resolveDropdownItems, type DropdownActionKind } from './source-control-dropdown-items'
import { getDefaultSettings } from '../../../../shared/constants'
import { CUSTOM_AGENT_ID } from '../../../../shared/commit-message-agent-spec'
import { resolveSourceControlAiForOperation } from '../../../../shared/source-control-ai'

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
    pushRecovery: null,
    remoteActionError: null as string | null,
    isCommitting: inputs.isCommitting,
    isFixingCommitFailureWithAI: false,
    isFixingPushFailureWithAI: false,
    showComposer: true,
    sourceControlAiActionsVisible: true,
    aiAgentConfigured: false,
    isGenerating: false,
    generateError: null as string | null,
    stagedCount: inputs.stagedCount,
    hasPartiallyStagedChanges: inputs.hasPartiallyStagedChanges,
    hasUnresolvedConflicts: inputs.hasUnresolvedConflicts,
    isRemoteOperationActive: inputs.isRemoteOperationActive,
    inFlightRemoteOpKind: inputs.inFlightRemoteOpKind ?? null,
    primaryAction: resolvePrimaryAction(inputs),
    dropdownItems: resolveDropdownItems(inputs),
    onCommitMessageChange: vi.fn(),
    onGenerate: vi.fn(),
    onCancelGenerate: vi.fn(),
    onFixCommitFailureWithAI: vi.fn(),
    onFixPushFailureWithAI: vi.fn(),
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
  return markup.includes(' disabled=""') || markup.includes('aria-disabled="true"')
}

describe('CommitArea AI generation', () => {
  it('does not render the AI generate affordance when the feature is disabled', () => {
    expect(
      renderCommitArea({
        ...baseProps(),
        sourceControlAiActionsVisible: false
      })
    ).not.toContain('aria-label="Generate commit message with AI"')
  })

  it('enables AI generation only when an agent is configured, changes are staged, and the message is empty', () => {
    const props = baseProps({ hasMessage: false })
    const markup = renderCommitArea({
      ...props,
      commitMessage: '',
      aiAgentConfigured: true
    })

    const button = buttonByLabel(markup, 'Generate commit message with AI')
    expect(hasDisabledAttribute(button)).toBe(false)
    expect(button).toContain('title="ai commit msg"')
  })

  it('disables AI generation when the textarea already has user text', () => {
    const markup = renderCommitArea({
      ...baseProps(),
      aiAgentConfigured: true
    })

    const button = buttonByLabel(markup, 'Generate commit message with AI')
    expect(button).toContain('aria-disabled="true"')
    expect(button).toContain('title="Clear the message to regenerate."')
  })

  it('keeps AI generation discoverable when the configured agent needs attention', () => {
    const settings = getDefaultSettings('/tmp')
    const resolved = resolveSourceControlAiForOperation({
      settings: {
        ...settings,
        sourceControlAi: {
          ...settings.sourceControlAi!,
          customAgentCommand: '',
          actions: {
            ...settings.sourceControlAi!.actions,
            commitMessage: {
              agentId: CUSTOM_AGENT_ID
            }
          }
        }
      },
      repo: null,
      operation: 'commitMessage'
    })
    expect(resolved).toMatchObject({
      ok: false,
      error: 'Custom command is empty. Add one in Settings -> Git -> Source Control AI.'
    })

    const props = baseProps({ hasMessage: false })
    const markup = renderCommitArea({
      ...props,
      commitMessage: '',
      aiAgentConfigured: resolved.ok
    })

    const button = buttonByLabel(markup, 'Generate commit message with AI')
    expect(hasDisabledAttribute(button)).toBe(false)
    expect(button).toContain('title="Pick an agent in Settings -&gt; Git -&gt; Source Control AI."')
  })

  it('turns the generating icon into a stop affordance', () => {
    const props = baseProps({ hasMessage: false })
    const markup = renderCommitArea({
      ...props,
      commitMessage: '',
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
      aiAgentConfigured: true
    })
    expect(markup).toContain('Commit')
    expect(markup).toContain('aria-label="Generate commit message with AI"')
  })

  it('renders a single commit-message AI entry point in the composer', () => {
    const props = baseProps({ hasMessage: false })
    const markup = renderCommitArea({
      ...props,
      commitMessage: '',
      aiAgentConfigured: true
    })

    const matches = markup.match(/aria-label="Generate commit message with AI"/g) ?? []
    expect(matches).toHaveLength(1)
    expect(markup).not.toContain('aria-label="Customize commit-message generation"')
    expect(markup).not.toContain('aria-label="Add commit message instructions"')
  })

  it('can hide only the composer while keeping the split action surface visible', () => {
    const markup = renderCommitArea({
      ...baseProps({ hasMessage: false, stagedCount: 0 }),
      commitMessage: '',
      aiAgentConfigured: true,
      showComposer: false
    })

    expect(markup).not.toContain('aria-label="Commit message"')
    expect(markup).not.toContain('aria-label="Generate commit message with AI"')
    expect(markup).toContain('Nothing to commit')
    expect(markup).toContain('aria-label="More commit and remote actions"')
  })
})

describe('commit-message generation defaults', () => {
  it('treats factory Source Control AI settings as needing the first-run dialog', () => {
    expect(
      hasConfiguredCommitMessageGenerationDefaults({
        settings: getDefaultSettings('/tmp'),
        repo: null
      })
    ).toBe(false)
  })

  it('treats a saved action agent or custom template as configured defaults', () => {
    const settings = getDefaultSettings('/tmp')
    expect(
      hasConfiguredCommitMessageGenerationDefaults({
        settings: {
          ...settings,
          sourceControlAi: {
            ...settings.sourceControlAi!,
            actions: {
              ...settings.sourceControlAi!.actions,
              commitMessage: {
                commandInputTemplate: '{basePrompt}',
                agentId: 'codex'
              }
            }
          }
        },
        repo: null
      })
    ).toBe(true)

    expect(
      hasConfiguredCommitMessageGenerationDefaults({
        settings: {
          ...settings,
          sourceControlAi: {
            ...settings.sourceControlAi!,
            actions: {
              ...settings.sourceControlAi!.actions,
              commitMessage: {
                commandInputTemplate: 'just use "{branch}"'
              }
            }
          }
        },
        repo: null
      })
    ).toBe(true)
  })

  it('uses the same configured-defaults check for pull-request generation', () => {
    const settings = getDefaultSettings('/tmp')
    expect(
      hasConfiguredSourceControlTextGenerationDefaults({
        actionId: 'pullRequest',
        settings,
        repo: null
      })
    ).toBe(false)

    expect(
      hasConfiguredSourceControlTextGenerationDefaults({
        actionId: 'pullRequest',
        settings: {
          ...settings,
          commitMessageAi: {
            ...settings.commitMessageAi!,
            agentId: 'codex'
          }
        },
        repo: null
      })
    ).toBe(false)

    expect(
      hasConfiguredSourceControlTextGenerationDefaults({
        actionId: 'pullRequest',
        settings: {
          ...settings,
          sourceControlAi: {
            ...settings.sourceControlAi!,
            actions: {
              ...settings.sourceControlAi!.actions,
              pullRequest: {
                commandInputTemplate: '{basePrompt}\n\nKeep it short.'
              }
            }
          }
        },
        repo: null
      })
    ).toBe(true)

    expect(
      hasConfiguredSourceControlTextGenerationDefaults({
        actionId: 'pullRequest',
        settings: {
          ...settings,
          sourceControlAi: {
            ...settings.sourceControlAi!,
            actions: {
              ...settings.sourceControlAi!.actions,
              pullRequest: {
                commandInputTemplate: '{basePrompt}',
                agentArgs: '--model gpt-5.5'
              }
            }
          }
        },
        repo: null
      })
    ).toBe(true)
  })
})
