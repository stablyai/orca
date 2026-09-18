import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlTextGenerationDialog } from './source-control/ai/text-generation-dialog'
import {
  renderSourceControlActionCommandTemplate,
  type SourceControlTextActionId
} from '../../../../shared/source-control-ai-actions'
import { findMissingWorkContextError } from '../../../../shared/source-control-ai-template-work-context'

const preview = vi.hoisted(() => ({ value: '' }))

vi.mock('./source-control/ai/text-generation-dialog-form', () => ({
  SourceControlTextGenerationDialogForm: ({ basePromptPreview }: { basePromptPreview: string }) => {
    preview.value = basePromptPreview
    return null
  }
}))

vi.mock('@/components/ui/dialog', () => {
  const Container = ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children)
  return Object.fromEntries(
    ['Dialog', 'DialogContent', 'DialogDescription', 'DialogHeader', 'DialogTitle'].map((name) => [
      name,
      Container
    ])
  )
})

function copyPreview(actionId: SourceControlTextActionId): string {
  renderToStaticMarkup(
    React.createElement(SourceControlTextGenerationDialog, {
      actionId,
      title: 'Generate',
      description: '',
      generateLabel: 'Generate',
      open: true,
      settings: null,
      discoveryHostKey: 'local',
      onOpenChange: () => {},
      onGenerate: () => {},
      onSaveDefaults: () => {}
    })
  )
  return preview.value
}

describe('copyable base prompt previews', () => {
  it.each([
    { actionId: 'commitMessage' as const, variables: ['branch', 'stagedFiles', 'stagedPatch'] },
    {
      actionId: 'pullRequest' as const,
      variables: [
        'branch',
        'baseBranch',
        'currentTitle',
        'currentBody',
        'commitSummary',
        'changedFiles',
        'patch'
      ]
    },
    { actionId: 'branchName' as const, variables: ['firstPrompt', 'assistantMessage'] }
  ])('keeps $actionId context as placeholders', ({ actionId, variables }) => {
    const template = copyPreview(actionId)
    for (const variable of variables) {
      expect(template).toContain(`{${variable}}`)
    }
    expect(template).not.toMatch(
      /feature\/example|src\/example\.ts|addSourceControlAiPreview|Draft title|Draft description|I will update/
    )
  })

  it('renders real staged changes after copying the preview and editing a rule', () => {
    const commandInputTemplate = copyPreview('commitMessage').replace(
      '- First line: imperative mood, <= 72 chars, no trailing period.',
      '- Use Conventional Commits.'
    )
    const context = {
      branch: 'fix/login-timeout',
      stagedSummary: 'M src/login.ts',
      stagedPatch: 'diff --git a/src/login.ts b/src/login.ts\n+extendTimeout()'
    }
    expect(findMissingWorkContextError('commitMessage', commandInputTemplate)).toBeNull()
    const prompt = renderSourceControlActionCommandTemplate(commandInputTemplate, {
      branch: context.branch,
      stagedFiles: context.stagedSummary,
      stagedPatch: context.stagedPatch
    })
    expect(prompt).toContain('Use Conventional Commits.')
    expect(prompt).toContain(context.branch)
    expect(prompt).toContain(context.stagedSummary)
    expect(prompt).toContain(context.stagedPatch)
    expect(prompt).not.toMatch(/\{stagedFiles\}|\{stagedPatch\}|src\/example\.ts/)
  })
})
