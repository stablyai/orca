import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlTextGenerationDialogForm } from './source-control/ai/text-generation-dialog-form'

vi.mock('../source-control/SourceControlActionVariableChips', () => ({
  SourceControlActionVariableChips: () => React.createElement('div')
}))

vi.mock('@/components/ui/dialog', () => ({
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children)
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectItem: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span')
}))

function renderCommitMessageForm(commandInputTemplate: string): string {
  return renderToStaticMarkup(
    React.createElement(SourceControlTextGenerationDialogForm, {
      actionId: 'commitMessage',
      generateLabel: 'Generate commit message',
      settings: null,
      repo: null,
      baseParams: { agentId: 'codex', model: 'gpt-5.4-mini', commandInputTemplate },
      saveTargets: [
        { target: { type: 'global' }, label: 'Save as global default', successMessage: '' }
      ],
      onGenerate: () => {},
      onOpenChange: () => {},
      onSaveDefaults: () => {}
    })
  )
}

describe('command template work-context warning', () => {
  it('warns while editing a template that would drop the staged changes', () => {
    const markup = renderCommitMessageForm(
      'You are generating a single git commit message.\nStaged files:\nM src/example.ts'
    )

    expect(markup).toContain('never sees the staged changes')
  })

  it('stays quiet for a template that forwards the base prompt', () => {
    const markup = renderCommitMessageForm('{basePrompt}\n\nUse Conventional Commits.')

    expect(markup).not.toContain('never sees the staged changes')
  })
})
