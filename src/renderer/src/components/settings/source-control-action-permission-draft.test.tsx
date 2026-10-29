// @vitest-environment happy-dom
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as lifts from '../../../../shared/source-control-action-permission-lift'
import * as shell from '../../../../shared/tui-agent-startup-shell'
import { expect, it, vi } from 'vitest'
import './__fixtures__/settings-persistence-test-fixture'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../shared/source-control-ai'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import { liftActionPermissionArgs } from '../../../../shared/source-control-action-permission-lift'
import { sourceControlActionAgentArgs } from '../../../../shared/source-control-action-launch-preferences'
import { agentPermissionArgsForLaunch } from '../../../../shared/tui-agent-launch-defaults'
import { SourceControlActionArguments } from './SourceControlActionArguments'
import { useRepositorySourceControlAiGlobalUx } from './repository/source-control/repository-source-control-ai-global-ux'
import { TooltipProvider } from '../ui/tooltip'

const model = { agentId: 'claude', model: 'sonnet', options: { effort: 'high' } } as const
const initial = normalizeSourceControlAiSettings({
  ...getDefaultSourceControlAiSettings(),
  enabled: true,
  actions: { fixChecks: { agentId: 'claude', agentArgs: '', launchPreferences: model } }
})
const write = vi.fn()

function RepoHarness({ saved }: { saved: { value: RepoSourceControlAiOverrides } }) {
  const [persisted, setPersisted] = useState(saved.value)
  const draft = useRepositorySourceControlAiGlobalUx({
    repoId: 'repo',
    persistedRepoAi: persisted,
    settings: null,
    source: initial,
    updateRepo: async (_id, update) => {
      saved.value = update.sourceControlAi ?? {}
      write(update)
      setPersisted(saved.value)
      return true
    }
  })
  const value = draft.displayRepoAi.actionOverrides?.fixChecks
  return (
    <TooltipProvider>
      <SourceControlActionArguments
        agent="claude"
        value={value?.agentArgs ?? ''}
        preferences={value?.launchPreferences}
        onArgsChange={(text, commit) => draft.updateActionAgentArgs('fixChecks', text, commit)}
        onPreferencesChange={(preferences) =>
          draft.updateActionLaunchPreferences('fixChecks', preferences)
        }
      />
      <button onClick={() => void draft.saveActionRecipeText('fixChecks')}>Save</button>
      <button onClick={() => draft.discardActionRecipeText('fixChecks')}>Discard</button>
    </TooltipProvider>
  )
}

it('repo: commits typed permission, drafts own removal and saves/discards args and model together', async () => {
  write.mockClear()
  const repo: { value: RepoSourceControlAiOverrides } = {
    value: { actionOverrides: { fixChecks: initial.actions?.fixChecks } }
  }
  const view = () => <RepoHarness saved={repo} />
  const savedRecipe = () => repo.value.actionOverrides?.fixChecks
  const rendered = render(view())
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  const lift = vi.spyOn(lifts, 'liftActionPermissionArgs')
  const tokenize = vi.spyOn(shell, 'tokenizeStartupCommand')
  const work: number[][] = []
  for (const n of [32, 320]) {
    tokenize.mockClear()
    for (let i = 0; i < n; i++) {
      fireEvent.change(input, { target: { value: `--verbose ${String(i).padStart(3, '0')}` } })
    }
    work.push([
      tokenize.mock.calls.length,
      tokenize.mock.calls.reduce((sum, [text]) => sum + text.length, 0)
    ])
    expect(lift).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  }
  process.stdout.write(
    `${JSON.stringify({ metric: 'permission-input-work', scope: 'repo', work })}\n`
  )
  expect(work[0][0]).toBeGreaterThan(32)
  work[1].forEach((value, i) => expect(value).toBeLessThanOrEqual(10 * work[0][i]))
  fireEvent.click(screen.getByText('Discard'))
  fireEvent.click(screen.getByText('Save'))
  expect(write).not.toHaveBeenCalled()
  lift.mockClear()
  fireEvent.change(input, { target: { value: '--dangerously-skip-permissions --verbose' } })
  expect(screen.queryByRole('button', { name: /Remove --dangerously/ })).toBeNull()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(lift).toHaveBeenCalledTimes(1)
  expect(input).toHaveProperty('value', '--verbose')
  expect(screen.getByRole('button', { name: /Remove --dangerously/ })).toBeDefined()
  expect(write).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Discard'))
  expect(input).toHaveProperty('value', '')
  expect(screen.queryByRole('button', { name: /Remove --dangerously/ })).toBeNull()
  // Direct Save without blur must commit the dirty text exactly once.
  fireEvent.change(input, { target: { value: '--dangerously-skip-permissions --verbose' } })
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(savedRecipe()?.launchPreferences?.permissionMode).toBe('full-access'))
  expect(savedRecipe()?.launchPreferences).toEqual({ ...model, permissionMode: 'full-access' })
  expect(savedRecipe()?.agentArgs).toBe('--verbose')
  expect(write).toHaveBeenCalledTimes(1)
  rendered.unmount()
  const reopened = render(view())
  const args = screen.getByRole('textbox', { name: 'Arguments' })
  fireEvent.click(screen.getByRole('button', { name: /Remove --dangerously/ }))
  expect(screen.queryByRole('button', { name: /Remove --dangerously/ })).toBeNull()
  expect(write).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByText('Discard'))
  fireEvent.focus(args)
  if (!(args instanceof HTMLTextAreaElement)) {
    throw new Error('Missing arguments textarea')
  }
  args.setSelectionRange(0, 0)
  fireEvent.keyDown(args, { key: 'Backspace' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /Remove --dangerously/ }))
  fireEvent.keyDown(document.activeElement ?? args, { key: 'Backspace' })
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(savedRecipe()?.launchPreferences?.permissionMode).toBe('own'))
  expect(savedRecipe()?.launchPreferences).toEqual({ ...model, permissionMode: 'own' })
  expect(savedRecipe()?.agentArgs).toBe('--verbose')
  reopened.unmount()
  render(view())
  expect(screen.queryByRole('button', { name: /Remove --dangerously/ })).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', '--verbose')
})

it('disables the menu, input, reset and chip keyboard path while preserving geometry', async () => {
  const args = vi.fn()
  const preferences = vi.fn()
  const props = {
    agent: 'claude' as const,
    value: '--verbose',
    preferences: { ...model, permissionMode: 'full-access' as const },
    onArgsChange: args,
    onPreferencesChange: preferences
  }
  const rendered = render(
    <TooltipProvider>
      <SourceControlActionArguments {...props} disabled />
    </TooltipProvider>
  )
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Claude permissions' })).toHaveProperty(
    'disabled',
    true
  )
  expect(screen.getByRole('button', { name: 'Reset' })).toHaveProperty('disabled', true)
  const chip = screen.getByRole('button', { name: /Remove --dangerously/ })
  fireEvent.keyDown(chip, { key: 'Backspace' })
  expect(preferences).not.toHaveBeenCalled()
  rendered.rerender(
    <TooltipProvider>
      <SourceControlActionArguments {...props} />
    </TooltipProvider>
  )
  await userEvent.click(screen.getByRole('button', { name: 'Claude permissions' }))
  expect(screen.getByRole('menuitemradio', { name: /Same as Claude ·/ })).toBeDefined()
  await userEvent.click(screen.getByRole('menuitemradio', { name: /Use Claude's own settings/ }))
  expect(preferences).toHaveBeenLastCalledWith({ ...model, permissionMode: 'own' })
})

it.each([undefined, null])('keeps untouched %s arguments unowned until the user edits', (value) => {
  const onArgsChange = vi.fn()
  const view = (args: string | null | undefined) => (
    <TooltipProvider>
      <SourceControlActionArguments
        agent="claude"
        value={args}
        onArgsChange={onArgsChange}
        onPreferencesChange={vi.fn()}
      />
    </TooltipProvider>
  )
  const rendered = render(view(value))
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  fireEvent.focus(input)
  fireEvent.blur(input)
  expect(onArgsChange).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '--verbose' } })
  expect(onArgsChange).toHaveBeenLastCalledWith('--verbose')
  rendered.rerender(view('--verbose'))
  fireEvent.change(input, { target: { value: '' } })
  rendered.rerender(view(''))
  fireEvent.blur(input)
  expect(onArgsChange).toHaveBeenLastCalledWith('', true)
})

it('keeps the old Codex workspace-write Ask literal and explains that terminal text wins', () => {
  const text = '  -a on-request -s workspace-write -c approvals_reviewer=user  --search '
  const recipe = {
    agentId: 'codex',
    agentArgs: text,
    launchPreferences: { agentId: 'codex', permissionMode: 'ask' }
  } as const
  expect(liftActionPermissionArgs(recipe)).toBe(recipe)
  expect(liftActionPermissionArgs(recipe, true)).toBe(recipe)
  expect(sourceControlActionAgentArgs(recipe, 'codex', null)).toBe(text)
  expect(agentPermissionArgsForLaunch('codex', 'ask', text)).toBeNull()
  render(
    <TooltipProvider>
      <SourceControlActionArguments
        agent="codex"
        value={text}
        preferences={recipe.launchPreferences}
        onArgsChange={vi.fn()}
        onPreferencesChange={vi.fn()}
      />
    </TooltipProvider>
  )
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', text)
  expect(screen.queryByRole('button', { name: /Remove -a/ })).toBeNull()
  expect(
    screen.getByText(
      'These arguments may control Codex’s terminal permissions, so Orca adds no flag. Chats use the Permissions choice above.'
    )
  ).toBeDefined()
})
