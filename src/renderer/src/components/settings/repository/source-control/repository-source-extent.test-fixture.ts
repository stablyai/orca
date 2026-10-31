import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { TooltipProvider } from '../../../ui/tooltip'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { createRepoActionTextDraftEditors } from '../../repository-source-control-ai-text-draft'
import { saveSourceControlActionRecipe } from '../../../../../../shared/source-control-ai-recipe-save'
import { projectSourceControlActionLaunch } from '../../../../../../shared/source-control-action-launch-preferences'
import { resolveSourceControlActionRecipe } from '../../../../../../shared/source-control-ai-operation-policy'
import {
  computeActionDirtyById,
  withRepoAiActionMode,
  withRepoAiActionRecipeText
} from './repository-source-control-ai-draft'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'

export function registerRepoSourceExtentTests(rpc: ReturnType<typeof vi.fn>) {
  it.each([
    {
      name: 'equal parent',
      inputs: ['--debug', '--verbose'],
      args: '--verbose',
      permission: undefined
    },
    {
      name: 'bare parent Customize before later parent source',
      inputs: ['--debug'],
      args: '--debug',
      permission: undefined,
      bareParent: true
    },
    { name: 'explicit empty', inputs: ['--debug', ''], args: '', permission: undefined },
    {
      name: 'own raw permission',
      inputs: ['--permission-mode acceptEdits --debug'],
      args: '--debug',
      permission: 'accept-edits'
    },
    {
      name: 'full pending replacement',
      inputs: ['--model sonnet --effort high --verbose', '--debug'],
      args: '--debug',
      permission: undefined
    },
    {
      name: 'initial inherited permission and Settings',
      inputs: ['--debug'],
      args: '--debug',
      permission: undefined,
      parentArgs: `--permission-mode default --settings '{"fastMode":true,"theme":"light"}' --verbose`
    }
  ] as const)(
    'passes $name through the real repository row, sparse writer and saved recipe',
    async (fixture) => {
      const { inputs, args: expectedArgs, permission } = fixture
      rpc.mockReset().mockResolvedValue(undefined)
      setLocalRuntimeCapabilitiesForTests([])
      const base = useAppStore.getState().settings!
      const source = {
        ...base.sourceControlAi!,
        actions: {
          resolveConflicts: {
            agentId: 'claude' as const,
            agentArgs: 'parentArgs' in fixture ? fixture.parentArgs : '--verbose',
            launchPreferences: {
              agentId: 'claude' as const,
              permissionMode: 'ask' as const,
              ...('parentArgs' in fixture ? { model: 'opus', options: { effort: 'high' } } : {})
            }
          }
        }
      }
      const own =
        'bareParent' in fixture
          ? withRepoAiActionMode(
              {},
              {
                ...base,
                sourceControlAi: { ...base.sourceControlAi!, actions: { resolveConflicts: {} } }
              },
              'resolveConflicts',
              'override'
            )
          : { actionOverrides: { resolveConflicts: { commandInputTemplate: '{basePrompt}' } } }
      if ('bareParent' in fixture) {
        expect(own.actionOverrides?.resolveConflicts).toMatchObject({ agentId: null })
        for (const key of ['agentArgs', 'argumentChoices', 'launchPreferences']) {
          expect(Object.hasOwn(own.actionOverrides!.resolveConflicts!, key)).toBe(false)
        }
        const parentWrite = saveSourceControlActionRecipe({
          target: { type: 'global' },
          settings: base,
          repo: null,
          actionId: 'resolveConflicts',
          recipe: {
            ...source.actions.resolveConflicts,
            agentArgs: `--permission-mode default --settings '{"fastMode":true,"theme":"light"}' --verbose`,
            launchPreferences: {
              agentId: 'claude',
              model: 'opus',
              options: { effort: 'high' },
              permissionMode: 'ask'
            }
          }
        })
        if (!('sourceControlAi' in parentWrite)) {
          throw new Error('Expected global parent writer')
        }
        Object.assign(source, parentWrite.sourceControlAi)
      }
      const parentBefore = structuredClone(source.actions.resolveConflicts)
      useAppStore.setState({
        settings: { ...base, nativeChatProviders: {}, sourceControlAi: source },
        repos: [TEST_REPO],
        localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
      })
      const change = vi.fn()
      render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(RepositorySourceControlAiActionRows, {
            repoId: TEST_REPO.id,
            repoAi: own,
            source,
            defaultTuiAgent: 'claude',
            savingActionIds: {},
            actionDirtyById: computeActionDirtyById({}, {}, {}),
            onActionModeChange: vi.fn(),
            onActionAgentChange: vi.fn(),
            onActionLaunchPreferencesChange: change,
            onActionTemplateChange: vi.fn(),
            onActionAgentArgsChange: vi.fn(),
            onAppendVariable: vi.fn(),
            onActionDiscard: vi.fn(),
            onActionSave: vi.fn()
          })
        )
      )
      const row = within(screen.getByText('Conflict resolution').closest<HTMLElement>('[id]')!)
      const trigger = row.getByRole('button', { name: 'Select agent' })
      await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
      fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
      const input = screen.getByRole('textbox', { name: 'Arguments' })
      await waitFor(() => expect(input).toHaveProperty('disabled', false))
      for (const text of inputs) {
        fireEvent.change(input, { target: { value: text } })
      }
      if ('parentArgs' in fixture) {
        fireEvent.blur(input)
      }
      fireEvent.click(screen.getByRole('button', { name: 'Use' }))
      expect(change).toHaveBeenCalledExactlyOnceWith(
        'resolveConflicts',
        permission ? { agentId: 'claude', permissionMode: permission } : undefined,
        expectedArgs,
        undefined
      )
      let drafts: Parameters<typeof createRepoActionTextDraftEditors>[0] extends React.Dispatch<
        React.SetStateAction<infer State>
      >
        ? State
        : never = {}
      const writers = createRepoActionTextDraftEditors(
        (update) => {
          drafts = typeof update === 'function' ? update(drafts) : update
        },
        { current: own },
        source
      )
      const [actionId, preferences, args, nodes] = change.mock.calls[0]
      writers.updateActionLaunchPreferences(actionId, preferences, args, nodes)
      const saved = withRepoAiActionRecipeText(
        own,
        { ...base, sourceControlAi: source },
        'resolveConflicts',
        drafts.resolveConflicts!
      )
      expect(saved.actionOverrides?.resolveConflicts?.agentArgs).toBe(expectedArgs)
      expect(saved.actionOverrides?.resolveConflicts?.launchPreferences?.permissionMode).toBe(
        permission
      )
      expect(source.actions.resolveConflicts).toEqual(parentBefore)
      const reopened = resolveSourceControlActionRecipe({
        settings: { sourceControlAi: source },
        repo: { sourceControlAi: saved },
        actionId: 'resolveConflicts'
      })
      const launch = projectSourceControlActionLaunch(reopened, 'claude', { basePrompt: 'fix' })
      expect(launch.agentArgs).toBe(expectedArgs)
      expect(launch.sessionOptions?.permissionMode).toBe(
        'bareParent' in fixture ? undefined : (permission ?? 'ask')
      )
      expect(launch.sessionOptions?.model).toBeUndefined()
      expect(launch.sessionOptions?.effort).toBeUndefined()
      expect(
        resolveSourceControlActionRecipe({
          settings: {
            sourceControlAi: {
              ...source,
              actions: { resolveConflicts: { agentId: 'claude', agentArgs: '--new-parent' } }
            }
          },
          repo: { sourceControlAi: saved },
          actionId: 'resolveConflicts'
        }).agentArgs
      ).toBe(expectedArgs)
    }
  )
}
