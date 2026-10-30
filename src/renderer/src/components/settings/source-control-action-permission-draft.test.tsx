import {
  sourceControlActionSelectedPreferences,
  sourceControlActionAgentArgs
} from '../../../../shared/source-control-action-launch-preferences'
// @vitest-environment happy-dom
import { useState } from 'react'
import { getDefaultSettings } from '../../../../shared/constants'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai-operation-policy'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as lifts from '../../../../shared/source-control-action-permission-lift'
import * as shell from '../../../../shared/tui-agent-startup-shell'
import { expect, it, vi } from 'vitest'
import './__fixtures__/settings-persistence-test-fixture'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../shared/source-control-ai'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import { liftActionPermissionArgs } from '../../../../shared/source-control-action-permission-lift'
import {
  normalizeSourceControlActionRecipe,
  type SourceControlActionRecipe
} from '../../../../shared/source-control-ai-actions'
import { agentPermissionArgsForLaunch } from '../../../../shared/tui-agent-launch-defaults'
import { SourceControlActionArguments } from './SourceControlActionArguments'
import { useRepositorySourceControlAiGlobalUx } from './repository/source-control/repository-source-control-ai-global-ux'
import { useSourceControlActionRecipeDraftState } from './source-control-action-recipe-draft-state'
import { TooltipProvider } from '../ui/tooltip'

const model = { agentId: 'claude', model: 'sonnet', options: { effort: 'high' } } as const
const completeModel = {
  agentId: 'claude',
  modelSelection: {
    base: 'default',
    model: { agentId: 'claude', value: 'sonnet' },
    options: { effort: { agentId: 'claude', value: 'high' } }
  }
} as const
const initial = normalizeSourceControlAiSettings({
  ...getDefaultSourceControlAiSettings(),
  enabled: true,
  actions: { fixChecks: { agentId: 'claude', agentArgs: '', launchPreferences: model } }
})
const write = vi.fn()
const edit = vi.fn()

function RepoHarness({
  saved,
  source = initial
}: {
  saved: { value: RepoSourceControlAiOverrides }
  source?: SourceControlAiSettings
}) {
  const [persisted, setPersisted] = useState(saved.value)
  const draft = useRepositorySourceControlAiGlobalUx({
    repoId: 'repo',
    persistedRepoAi: persisted,
    settings: { ...getDefaultSettings('/tmp'), sourceControlAi: source },
    source,
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
        value={value?.agentArgs}
        preferences={sourceControlActionSelectedPreferences(
          resolveSourceControlActionRecipe({
            settings: { sourceControlAi: source },
            repo: { sourceControlAi: draft.displayRepoAi },
            actionId: 'fixChecks'
          }),
          'claude'
        )}
        modelSelectionBase="inherit"
        authoredAgent={value?.agentId}
        authoredPreferences={value?.launchPreferences ?? null}
        argumentChoices={value?.argumentChoices}
        onArgsChange={(text, commit) => draft.updateActionAgentArgs('fixChecks', text, commit)}
        onPreferencesChange={(preferences, userArgs, nodes) => {
          edit(preferences, userArgs)
          draft.updateActionLaunchPreferences('fixChecks', preferences, userArgs, nodes)
        }}
      />
      <button onClick={() => void draft.saveActionRecipeText('fixChecks')}>Save</button>
      <button onClick={() => draft.discardActionRecipeText('fixChecks')}>Discard</button>
    </TooltipProvider>
  )
}

function GlobalHarness({ saved }: { saved: { value: SourceControlAiSettings } }) {
  const [config, setConfig] = useState(saved.value)
  const draft = useSourceControlActionRecipeDraftState({
    config,
    writeConfig: async (patch) => {
      saved.value = {
        ...saved.value,
        ...(typeof patch === 'function' ? patch(saved.value) : patch)
      }
      write(saved.value)
      setConfig(saved.value)
    }
  })
  const value = draft.actionRecipeDraftState.values.fixChecks
  return (
    <TooltipProvider>
      <SourceControlActionArguments
        agent="claude"
        value={value.agentArgs}
        preferences={sourceControlActionSelectedPreferences(value, 'claude')}
        authoredAgent={config.actions?.fixChecks?.agentId}
        authoredPreferences={value.launchPreferences ?? null}
        argumentChoices={value.argumentChoices}
        onArgsChange={(text, commit) => draft.onActionAgentArgsChange('fixChecks', text, commit)}
        onPreferencesChange={(preferences, userArgs, nodes) => {
          edit(preferences, userArgs)
          draft.onActionLaunchPreferencesChange('fixChecks', preferences, userArgs, nodes)
        }}
      />
      <button onClick={() => void draft.saveActionTemplateDraft('fixChecks')}>Save</button>
      <button onClick={() => draft.discardActionTemplateDraft('fixChecks')}>Discard</button>
    </TooltipProvider>
  )
}

it.each(['global', 'repo'] as const)(
  '%s: edits dirty choices atomically and saves/discards the badge collection',
  async (scope) => {
    write.mockClear()
    edit.mockClear()
    const global = { value: initial }
    const repo: { value: RepoSourceControlAiOverrides } = {
      value: { actionOverrides: { fixChecks: initial.actions?.fixChecks } }
    }
    const view = () =>
      scope === 'global' ? <GlobalHarness saved={global} /> : <RepoHarness saved={repo} />
    const saved = () =>
      scope === 'global' ? global.value.actions?.fixChecks : repo.value.actionOverrides?.fixChecks
    const rendered = render(view())
    const input = screen.getByRole('textbox', { name: 'Arguments' })
    fireEvent.change(input, { target: { value: '--model fable --verbose' } })
    await userEvent.click(screen.getByRole('combobox', { name: 'Sonnet' }))
    await userEvent.click(screen.getByRole('option', { name: 'Haiku' }))
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      {
        agentId: 'claude',
        modelSelection: {
          base: 'default',
          model: { agentId: 'claude', value: 'haiku' },
          options: { effort: { agentId: 'claude', value: null } }
        }
      },
      '--verbose'
    )
    fireEvent.click(screen.getByText('Discard'))
    edit.mockClear()
    fireEvent.change(input, { target: { value: '--model fable --effort low --verbose' } })
    await userEvent.click(screen.getByRole('combobox', { name: 'High' }))
    await userEvent.click(screen.getByRole('option', { name: 'Medium' }))
    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit).toHaveBeenLastCalledWith(
      {
        agentId: 'claude',
        modelSelection: {
          base: 'default',
          options: { effort: { agentId: 'claude', value: 'medium' } }
        }
      },
      '--verbose'
    )
    expect(input).toHaveProperty('value', '--verbose')
    expect(write).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(saved()?.agentArgs).toBe('--verbose')
    expect(saved()?.launchPreferences).toEqual({
      agentId: 'claude',
      modelSelection: {
        base: 'default',
        options: { effort: { agentId: 'claude', value: 'medium' } }
      }
    })
    rendered.unmount()
    render(view())
    expect(saved()?.argumentChoices).toEqual({
      syntaxAgent: 'claude',
      nodes: [{ at: 0, text: '--model fable' }]
    })
    expect(
      sourceControlActionSelectedPreferences(
        normalizeSourceControlActionRecipe(saved()) ?? {},
        'claude'
      )?.model
    ).toBe('fable')
    const reopened = screen.getByRole('textbox', { name: 'Arguments' })
    fireEvent.change(reopened, { target: { value: '--model fable --effort medium --verbose' } })
    edit.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Remove --model fable' }))
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      {
        agentId: 'claude',
        modelSelection: {
          base: 'default',
          model: { agentId: 'claude', value: null }
        }
      },
      '--verbose'
    )
    expect(screen.getByRole('combobox', { name: 'Agent default' })).toBeDefined()
    fireEvent.click(screen.getByText('Discard'))
    expect(screen.getByRole('combobox', { name: 'Fable' })).toBeDefined()
    expect(reopened).toHaveProperty('value', '--verbose')
    fireEvent.focus(reopened)
    if (!(reopened instanceof HTMLTextAreaElement)) {
      throw new Error('Missing Arguments')
    }
    reopened.setSelectionRange(0, 0)
    edit.mockClear()
    fireEvent.keyDown(reopened, { key: 'Backspace' })
    const effort = screen.getByRole('button', { name: 'Remove --effort medium' })
    expect(document.activeElement).toBe(effort)
    expect(edit).not.toHaveBeenCalled()
    fireEvent.keyDown(effort, { key: 'Backspace' })
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      {
        agentId: 'claude',
        modelSelection: {
          base: 'default',
          options: { effort: { agentId: 'claude', value: null } }
        }
      },
      undefined
    )
    expect(screen.getByRole('combobox', { name: 'Default' })).toBeDefined()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(saved()?.launchPreferences).toEqual({
      agentId: 'claude',
      modelSelection: {
        base: 'default',
        options: { effort: { agentId: 'claude', value: null } }
      }
    })
    expect(saved()?.argumentChoices).toEqual({
      syntaxAgent: 'claude',
      nodes: [{ at: 0, text: '--model fable' }]
    })
    expect(saved()?.agentArgs).toBe('--verbose')
  }
)

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
  expect(savedRecipe()?.launchPreferences).toEqual({
    ...completeModel,
    permissionMode: 'full-access'
  })
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
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove --effort high' }))
  screen.getByRole('button', { name: /Remove --dangerously/ }).focus()
  fireEvent.keyDown(document.activeElement ?? args, { key: 'Backspace' })
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(savedRecipe()?.launchPreferences?.permissionMode).toBe('own'))
  expect(savedRecipe()?.launchPreferences).toEqual({ ...completeModel, permissionMode: 'own' })
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
  expect(preferences).toHaveBeenLastCalledWith(
    { ...completeModel, permissionMode: 'own' },
    undefined,
    null
  )
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

it.each([
  { model: undefined, controls: 2, fast: false },
  { model: 'unlisted-host-model', controls: 2, fast: false },
  { model: 'opus', controls: 3, fast: true }
])('offers only model-advertised action mode controls for $model', ({ model, controls, fast }) => {
  render(
    <TooltipProvider>
      <SourceControlActionArguments
        agent="claude"
        value="--verbose"
        preferences={{ agentId: 'claude', model }}
        onArgsChange={vi.fn()}
        onPreferencesChange={vi.fn()}
      />
    </TooltipProvider>
  )
  expect(screen.getAllByRole('combobox')).toHaveLength(controls)
  expect(screen.queryByText('Fast mode') !== null).toBe(fast)
  expect(screen.getByRole('button', { name: 'Claude permissions' })).toBeDefined()
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', '--verbose')
})

it.each(['host-private', 'sonnet'])(
  'keeps a saved %s Fast badge removable without offering a Fast select',
  async (model) => {
    write.mockClear()
    const saved = {
      value: normalizeSourceControlAiSettings({
        ...initial,
        actions: {
          fixChecks: {
            agentId: 'claude',
            agentArgs: `--settings '{"theme":"light"}' --add-dir docs`,
            launchPreferences: {
              agentId: 'claude',
              model,
              options: { fastMode: 'true' }
            }
          }
        }
      })
    }
    render(<GlobalHarness saved={saved} />)
    expect(
      screen.getByRole('combobox', { name: model === 'sonnet' ? 'Sonnet' : model })
    ).toBeDefined()
    expect(screen.queryByText('Fast mode')).toBeNull()
    expect(screen.getAllByRole('combobox')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /Remove --settings/ }))
    expect(screen.queryByRole('button', { name: /Remove --settings/ })).toBeNull()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    const recipe = saved.value.actions?.fixChecks
    expect(sourceControlActionSelectedPreferences(recipe ?? {}, 'claude')).toMatchObject({
      model
    })
    expect(
      sourceControlActionSelectedPreferences(recipe ?? {}, 'claude')?.options?.fastMode
    ).toBeUndefined()
    const args = sourceControlActionAgentArgs(recipe ?? {}, 'claude', null)
    expect(shell.tokenizeStartupCommand(args ?? '', 'posix')).toMatchObject({
      ok: true,
      tokens: ['--settings', '{"theme":"light"}', '--add-dir', 'docs']
    })
    expect(args).toContain('"theme":"light"')
    expect(args).toContain('--add-dir docs')
    expect(args).not.toContain('"fastMode":true')
  }
)

it('edits and saves a sparse repository model without authoring the inherited permission', async () => {
  write.mockClear()
  const source = {
    ...initial,
    actions: {
      fixChecks: {
        agentId: 'claude' as const,
        launchPreferences: { ...model, permissionMode: 'ask' as const }
      }
    }
  }
  const saved = { value: { actionOverrides: { fixChecks: { agentArgs: '--verbose' } } } }
  const view = () => <RepoHarness saved={saved} source={source} />
  const rendered = render(view())
  expect(screen.getByRole('combobox', { name: 'Agent default' })).toBeDefined()
  expect(screen.getByRole('combobox', { name: 'Default' })).toBeDefined()
  await userEvent.click(screen.getByRole('combobox', { name: 'Agent default' }))
  await userEvent.click(screen.getByRole('option', { name: 'Haiku' }))
  fireEvent.click(screen.getByText('Discard'))
  expect(screen.getByRole('combobox', { name: 'Agent default' })).toBeDefined()
  await userEvent.click(screen.getByRole('combobox', { name: 'Agent default' }))
  await userEvent.click(screen.getByRole('option', { name: 'Haiku' }))
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  expect(saved.value.actionOverrides.fixChecks).toEqual({
    agentArgs: '--verbose',
    launchPreferences: {
      agentId: 'claude',
      modelSelection: { base: 'default', model: { agentId: 'claude', value: 'haiku' } }
    }
  })
  rendered.unmount()
  render(view())
  expect(screen.getByRole('combobox', { name: 'Haiku' })).toBeDefined()
  expect(screen.queryByRole('button', { name: /Remove --permission-mode/ })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
    target: { value: '--model fable --verbose' }
  })
  await userEvent.click(screen.getByRole('button', { name: 'Claude permissions' }))
  await userEvent.click(screen.getByRole('menuitemradio', { name: /^Full access/ }))
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
  expect(saved.value.actionOverrides.fixChecks).toEqual({
    agentArgs: '--model fable --verbose',
    launchPreferences: {
      agentId: 'claude',
      permissionMode: 'full-access',
      modelSelection: { base: 'default' }
    }
  })
})

it.each(['global', 'repo'] as const)(
  '%s live residual edits preserve nodes, permission changes and permanent reset',
  async (scope) => {
    write.mockClear()
    const recipe = liftActionPermissionArgs<SourceControlActionRecipe>({
      agentId: 'claude' as const,
      agentArgs: '--model opus --effort high --append-system-prompt keep'
    })
    const global = { value: { ...initial, actions: { fixChecks: recipe } } }
    const repo = { value: { actionOverrides: { fixChecks: recipe } } }
    const saved = () =>
      scope === 'global' ? global.value.actions.fixChecks : repo.value.actionOverrides.fixChecks
    render(scope === 'global' ? <GlobalHarness saved={global} /> : <RepoHarness saved={repo} />)
    const input = screen.getByRole('textbox', { name: 'Arguments' })
    fireEvent.change(input, { target: { value: '--append-system-prompt changed' } })
    fireEvent.blur(input)
    expect(screen.getByRole('combobox', { name: 'Opus' })).toBeDefined()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(saved().argumentChoices?.nodes.map((node) => node.text)).toEqual([
      '--model opus',
      '--effort high'
    ])
    fireEvent.change(input, { target: { value: '--effort low --append-system-prompt changed' } })
    fireEvent.blur(input)
    expect(screen.getByRole('combobox', { name: 'Low' })).toBeDefined()
    fireEvent.click(screen.getByText('Discard'))
    expect(screen.getByRole('combobox', { name: 'High' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.getByRole('combobox', { name: 'Agent default' })).toBeDefined()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(saved().agentArgs).toBe('')
    expect(saved().argumentChoices).toBeUndefined()
  }
)

it('keeps the global document retryable and preserves a newer document across a pending Save', async () => {
  const recipe = liftActionPermissionArgs<SourceControlActionRecipe>({
    agentId: 'claude' as const,
    agentArgs: '--model opus --effort high'
  })
  const config = { ...initial, actions: { fixChecks: recipe } }
  const writeConfig = vi.fn().mockRejectedValueOnce(new Error('disk refused'))
  const { result } = renderHook(() =>
    useSourceControlActionRecipeDraftState({ config, writeConfig })
  )
  act(() => result.current.onActionTemplateChange('fixChecks', 'mine'))
  await act(async () => {
    await expect(result.current.saveActionTemplateDraft('fixChecks')).rejects.toThrow(
      'disk refused'
    )
  })
  expect(result.current.actionRecipeDraftState.values.fixChecks.argumentChoices).toEqual(
    recipe.argumentChoices
  )
  let finish = () => {}
  writeConfig.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  let save: Promise<void> = Promise.resolve()
  act(() => {
    save = result.current.saveActionTemplateDraft('fixChecks')
  })
  act(() => result.current.onActionAgentArgsChange('fixChecks', '--effort low', true))
  await act(async () => {
    finish()
    await save
  })
  expect(
    result.current.actionRecipeDraftState.values.fixChecks.argumentChoices?.nodes.map(
      (node) => node.text
    )
  ).toEqual(['--model opus', '--effort low'])
  expect(result.current.actionRecipeDraftState.baseValues.fixChecks.argumentChoices).toEqual(
    recipe.argumentChoices
  )
  writeConfig.mockResolvedValue(undefined)
  await act(async () => result.current.saveActionTemplateDraft('fixChecks'))
  expect(result.current.actionRecipeDraftState.values.fixChecks).toEqual(
    result.current.actionRecipeDraftState.baseValues.fixChecks
  )
})

it('removes inherited keys without pinning untouched choices across Save, reopen and later global edits', async () => {
  write.mockClear()
  const saved: { value: RepoSourceControlAiOverrides } = {
    value: { actionOverrides: { fixChecks: { commandInputTemplate: 'mine' } } }
  }
  const view = render(<RepoHarness saved={saved} />)
  fireEvent.click(screen.getByRole('button', { name: 'Remove --model sonnet' }))
  expect(screen.getByRole('combobox', { name: 'Agent default' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Remove --effort high' })).toBeDefined()
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  expect(saved.value.actionOverrides?.fixChecks).toEqual({
    commandInputTemplate: 'mine',
    launchPreferences: {
      agentId: 'claude',
      modelSelection: {
        base: 'inherit',
        model: { agentId: 'claude', value: null }
      }
    }
  })
  view.unmount()
  const reopened = render(<RepoHarness saved={saved} />)
  expect(screen.getByRole('combobox', { name: 'Agent default' })).toBeDefined()
  const source = normalizeSourceControlAiSettings({
    ...initial,
    actions: {
      fixChecks: {
        agentId: 'claude',
        agentArgs: '',
        launchPreferences: {
          agentId: 'claude',
          model: 'opus',
          options: { effort: 'medium' }
        }
      }
    }
  })
  reopened.rerender(<RepoHarness saved={saved} source={source} />)
  expect(screen.getByRole('button', { name: 'Remove --effort medium' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Remove --effort medium' }))
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
  expect(saved.value.actionOverrides?.fixChecks?.launchPreferences?.modelSelection).toEqual({
    base: 'inherit',
    model: { agentId: 'claude', value: null },
    options: { effort: { agentId: 'claude', value: null } }
  })
  reopened.rerender(<RepoHarness saved={saved} />)
  expect(screen.queryByRole('button', { name: /Remove --(model|effort)/ })).toBeNull()
  fireEvent.click(screen.getByText('Save'))
  expect(write).toHaveBeenCalledTimes(2)
})
