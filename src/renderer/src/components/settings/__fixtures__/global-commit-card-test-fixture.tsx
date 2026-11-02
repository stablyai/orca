import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect } from 'vitest'
import { CommitMessageAiPane } from '../CommitMessageAiPane'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../../shared/source-control-ai'
import type { SourceControlAiSettings } from '../../../../../shared/source-control-ai-types'
import { useAppStore } from '../../../store'
import { useSettingsInteractionController } from '../use-settings-interaction-controller'
import { TooltipProvider } from '../../ui/tooltip'
import { persist, settingsModel } from './settings-persistence-test-fixture'

/** The global Commit message card as the settings page renders it, saving through the queue. */
export function renderGlobalCommitCard(sourceControlAi: Partial<SourceControlAiSettings>) {
  const settings = useAppStore.getState().settings
  if (!settings) {
    throw new Error('Missing settings')
  }
  useAppStore.setState({
    settingsSearchQuery: '',
    settings: {
      ...settings,
      defaultTuiAgent: 'codex',
      sourceControlAi: normalizeSourceControlAiSettings({
        ...getDefaultSourceControlAiSettings(),
        enabled: true,
        ...sourceControlAi
      })
    }
  })
  const model = settingsModel()
  function Owner() {
    const settings = useAppStore((state) => state.settings)!
    const controller = useSettingsInteractionController(model)
    return (
      <CommitMessageAiPane
        settings={settings}
        updateSettings={model.updateSettings}
        writeSourceControlAiSettings={controller.writeSourceControlAiSettingsOrThrow}
      />
    )
  }
  render(
    <TooltipProvider>
      <Owner />
    </TooltipProvider>
  )
  const card = screen.getByText('Commit message').closest('.rounded-md')
  if (!(card instanceof HTMLElement)) {
    throw new Error('Missing commit card')
  }
  const row = within(card)
  return {
    row,
    open: (agent: string) => {
      fireEvent.pointerDown(row.getByRole('button', { name: 'Select agent' }), {
        button: 0,
        ctrlKey: false
      })
      fireEvent.click(screen.getByRole('button', { name: `Configure ${agent}` }))
    },
    save: async () => {
      const calls = persist.mock.calls.length
      fireEvent.click(row.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(persist.mock.calls.length).toBe(calls + 1))
      return useAppStore.getState().settings!
    }
  }
}
