import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { TooltipProvider } from '../../../ui/tooltip'
import { pickerLocaleFixture } from '../../__fixtures__/settings-persistence-test-fixture'
import { RepositorySourceControlAiSection } from './RepositorySourceControlAiSection'
import type { SourceControlAiRepoUpdate } from '../../../../../../shared/source-control/ai/settings/source-control-ai-recipe-save'

export function registerRepositoryStagedSetupTest() {
  it('keeps staged repository setup through template edits and saves/reopens only current own fields', async () => {
    const locale = await pickerLocaleFixture()
    const menu = await import('../../../tab-bar/use-new-tab-agent-menu-rows')
    const { sameAgentLaunchPickerModel } = await import('../../../tab-bar/new-tab-agent-menu-model')
    const observation = vi.spyOn(menu, 'useAgentMenuObservation')
    try {
      useAppStore.setState(({ settings }) => ({
        settings: settings && { ...settings, nativeChatProviders: {} },
        detectedAgentIds: ['claude'],
        localDetectedAgentIdsByContext: { host: ['claude'] }
      }))
      const repo = {
        ...TEST_REPO,
        sourceControlAi: {
          actionOverrides: {
            fixChecks: {
              agentId: 'claude' as const,
              agentArgs: '--saved',
              commandInputTemplate: 'Old repo'
            }
          }
        }
      }
      useAppStore.setState({ repos: [repo] })
      const update = vi.fn<(id: string, updates: SourceControlAiRepoUpdate) => Promise<boolean>>(
        async () => true
      )
      const view = render(
        React.createElement(RepositorySourceControlAiSection, { repo, updateRepo: update }),
        { wrapper: TooltipProvider }
      )
      const card = screen.getByText('Broken checks fixes').closest('[data-settings-section]')!
      if (!(card instanceof HTMLElement)) {
        throw new Error('Missing repository card')
      }
      const own = within(card)
      const open = async () => {
        const trigger = own.getByRole('button', { name: 'Select agent' })
        await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
        fireEvent.click(await screen.findByRole('button', { name: 'Configure Claude' }))
      }
      await open()
      fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
        target: { value: '--model claude-sonnet-5-5 --accepted' }
      })
      fireEvent.blur(screen.getByRole('textbox', { name: 'Arguments' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
        target: { value: '--pending' }
      })
      const input = screen.getByRole('textbox', { name: 'Arguments' })
      const model = observation.mock.results.at(-1)?.value.model
      expect(model).toBeDefined()
      for (const host of [null, ['codex'], ['claude']] as const) {
        act(() =>
          useAppStore.setState({ localDetectedAgentIdsByContext: { host: host && [...host] } })
        )
        expect(
          sameAgentLaunchPickerModel(model!, observation.mock.results.at(-1)!.value.model)
        ).toBe(true)
        expect(screen.getByRole('textbox', { name: 'Arguments' })).toBe(input)
        expect(input).toHaveProperty('value', '--pending')
        expect(
          screen.getByRole('button', { name: 'Remove --model claude-sonnet-5-5' })
        ).toBeDefined()
        expect(update).not.toHaveBeenCalled()
      }
      await act(() => locale.i18n.changeLanguage('es'))
      expect(screen.getByRole('textbox', { name: 'Argumentos' })).toBe(input)
      expect(input).toHaveProperty('value', '--pending')
      expect(screen.getByRole('button', { name: 'Iniciar terminal' })).toBeDefined()
      expect(update).not.toHaveBeenCalled()
      await act(() => locale.i18n.changeLanguage('en'))
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Arguments' }), { key: 'Escape' })
      fireEvent.keyDown(document, { key: 'Escape' })
      fireEvent.change(own.getByDisplayValue('Old repo'), {
        target: { value: 'CURRENT {basePrompt}' }
      })
      await open()
      expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty(
        'value',
        '--pending'
      )
      expect(screen.getByRole('button', { name: 'Remove --model claude-sonnet-5-5' })).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }))
      expect(own.getByDisplayValue('CURRENT {basePrompt}')).toBeDefined()
      fireEvent.click(own.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(update).toHaveBeenCalledOnce())
      const saved = update.mock.calls[0]![1].sourceControlAi!
      expect(saved.actionOverrides!.fixChecks!.commandInputTemplate).toBe('CURRENT {basePrompt}')
      expect(saved.actionOverrides!.fixChecks!.agentArgs).toBe('--pending')
      view.unmount()
      render(
        React.createElement(RepositorySourceControlAiSection, {
          repo: { ...repo, sourceControlAi: saved },
          updateRepo: update
        }),
        { wrapper: TooltipProvider }
      )
      expect(screen.getByDisplayValue('CURRENT {basePrompt}')).toBeDefined()
    } finally {
      await locale.restore()
    }
  })
}
