import {
  act,
  fireEvent,
  render,
  within,
  type RenderResult,
  type queries
} from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { expect, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown,
  readLocalRuntimeCapabilityObservation,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useRepositorySourceControlAiGlobalUx } from './repository-source-control-ai-global-ux'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { getDefaultSourceControlAiSettings } from '../../../../../../shared/source-control-ai'
import type { RepoSourceControlAiOverrides } from '../../../../../../shared/source-control-ai-types'

export async function exerciseRepositoryRecipeAfterColdRejection(
  newChoice: boolean
): Promise<void> {
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  const originalEnsure = useAppStore.getState().ensureDetectedAgents
  const previousCapabilities = readLocalRuntimeCapabilitiesOrUnknown()
  const reply = Promise.withResolvers<Awaited<ReturnType<Window['api']['runtime']['getStatus']>>>()
  const getStatus = vi.fn<Window['api']['runtime']['getStatus']>(() => reply.promise)
  const owned: Promise<unknown>[] = []
  const ensure: AppState['ensureDetectedAgents'] = (...args) => {
    const pending = originalEnsure(...args)
    owned.push(pending)
    return pending
  }
  let view: RenderResult<typeof queries> | undefined
  let drained = 0
  try {
    setLocalRuntimeCapabilitiesForTests(null)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, runtime: { ...window.api.runtime, getStatus } }
    })
    useAppStore.setState({ ensureDetectedAgents: ensure })
    useAppStore.setState({
      repos: [TEST_REPO],
      settings: {
        ...getDefaultSettings('/tmp'),
        agentDefaultSurface: 'terminal',
        defaultTuiAgent: 'blank'
      }
    })
    let saved: RepoSourceControlAiOverrides = {
      actionOverrides: {
        fixChecks: {
          agentId: newChoice ? null : 'claude',
          ...(newChoice ? {} : { surface: 'terminal' as const }),
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--verbose'
        }
      }
    }
    function RepositoryRecipes() {
      const [persisted, setPersisted] = useState(saved)
      const draft = useRepositorySourceControlAiGlobalUx({
        repoId: TEST_REPO.id,
        persistedRepoAi: persisted,
        settings: getDefaultSettings('/tmp'),
        source: getDefaultSourceControlAiSettings(),
        updateRepo: (_id, patch) => {
          const pending = (async () => {
            saved = patch.sourceControlAi ?? {}
            setPersisted(saved)
            return true
          })()
          owned.push(pending)
          return pending
        }
      })
      return (
        <RepositorySourceControlAiActionRows
          repoId={TEST_REPO.id}
          repoAi={draft.displayRepoAi}
          source={getDefaultSourceControlAiSettings()}
          defaultTuiAgent="claude"
          onActionModeChange={draft.updateActionMode}
          onActionAgentChange={draft.updateActionAgent}
          onActionLaunchPreferencesChange={draft.updateActionLaunchPreferences}
          onActionTemplateChange={draft.updateActionTemplate}
          onActionAgentArgsChange={draft.updateActionAgentArgs}
          onAppendVariable={draft.appendVariable}
          savingActionIds={draft.savingActionIds}
          actionDirtyById={draft.actionDirtyById}
          onActionDiscard={draft.discardActionRecipeText}
          onActionSave={(...args) => {
            const pending = draft.saveActionRecipeText(...args)
            owned.push(pending)
            return pending
          }}
        />
      )
    }
    const capability = ensureLocalRuntimeCapabilities()
    owned.push(capability)
    view = render(
      <TooltipProvider>
        <RepositoryRecipes />
      </TooltipProvider>
    )
    await act(async () => {})
    const row = view.container.querySelector(
      '[data-settings-section$="source-control-ai-fixChecks"]'
    )
    if (!(row instanceof HTMLElement)) {
      throw new Error('Missing saved Checks row')
    }
    if (newChoice) {
      expect(
        within(row)
          .getAllByRole('combobox')
          .find((element) => element.hasAttribute('data-agent-combobox-root'))!.textContent
      ).toContain('Use default agent')
      expect(
        within(row)
          .getAllByRole('combobox')
          .find((element) => element.hasAttribute('data-agent-combobox-root'))
      ).toHaveProperty('disabled', true)
    }
    expect(readLocalRuntimeCapabilityObservation()).toEqual({ state: 'pending' })
    await act(async () => {
      reply.reject(new Error('Runtime status transport unavailable'))
      while (drained < owned.length) {
        const pending = owned.slice(drained)
        await Promise.all(pending)
        drained += pending.length
      }
    })
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(readLocalRuntimeCapabilitiesOrUnknown()).toBeNull()
    expect(readLocalRuntimeCapabilityObservation()).toEqual({ state: 'unavailable' })
    expect(
      within(row)
        .getAllByRole('combobox')
        .find((element) => element.hasAttribute('data-agent-combobox-root'))
    ).toHaveProperty('disabled', false)
    if (newChoice) {
      await userEvent.click(
        within(row)
          .getAllByRole('combobox')
          .find((element) => element.hasAttribute('data-agent-combobox-root'))!
      )
      const command = view
        .getAllByRole('option')
        .find((option) => option.textContent?.startsWith('Claude'))
      if (!command) {
        throw new Error('Missing cold configuration command')
      }
      await userEvent.click(command)
    }
    expect(useAppStore.getState().readLocalAgentInventory()).toEqual({
      ids: null,
      state: 'failed'
    })
    const editable = within(row).getByRole('button', { name: 'Claude permissions' })
    expect(editable.hasAttribute('disabled')).toBe(false)
    await userEvent.click(editable)
    const options = await view.findAllByRole('menuitemradio', { name: /Full access/ })
    const option = options.find((entry) => entry.getAttribute('aria-checked') === 'false')
    if (!option) {
      throw new Error('Missing explicit Full access choice')
    }
    await userEvent.click(option)
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
      while (drained < owned.length) {
        const pending = owned.slice(drained)
        await Promise.all(pending)
        drained += pending.length
      }
    })
    expect(saved.actionOverrides?.fixChecks).toMatchObject({
      agentId: 'claude',
      ...(newChoice ? {} : { surface: 'terminal' }),
      agentArgs: '--verbose',
      commandInputTemplate: '{basePrompt}',
      launchPreferences: { agentId: 'claude', permissionMode: 'full-access' }
    })
  } finally {
    try {
      view?.unmount()
    } finally {
      try {
        await act(async () => {
          reply.reject(new Error('Runtime status transport unavailable during cleanup'))
          while (drained < owned.length) {
            const pending = owned.slice(drained)
            drained = owned.length
            await Promise.allSettled(pending)
          }
        })
      } finally {
        try {
          useAppStore.setState({ ensureDetectedAgents: originalEnsure })
        } finally {
          try {
            if (originalApi) {
              Object.defineProperty(window, 'api', originalApi)
            } else {
              Reflect.deleteProperty(window, 'api')
            }
          } finally {
            setLocalRuntimeCapabilitiesForTests(previousCapabilities)
          }
        }
      }
    }
  }
}
