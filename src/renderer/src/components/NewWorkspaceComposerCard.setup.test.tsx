// @vitest-environment happy-dom
import React, { act } from 'react'
import { expect, it, vi } from 'vitest'
import { renderCard, unmountCard } from './NewWorkspaceComposerCard.test-fixture'
import { i18n, loadRendererUiLanguage, setRendererPluginLanguagePacks } from '@/i18n/i18n'
import { pluginLanguageResourceId } from '../../../shared/plugins/artifacts/plugin-language-pack-artifact'

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
        projects: [],
        repos: [],
        activeModal: 'none',
        updateSettings: vi.fn(),
        openModal: vi.fn(),
        closeModal: vi.fn()
      }),
    { getState: () => ({}) }
  )
}))
vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({ useContextualTour: vi.fn() }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: () => <button>Agent picker</button>
}))
vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({ AddRemoteHostDialog: () => null }))
vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({ default: () => null }))
vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))
vi.mock('@/components/new-workspace/ProjectCombobox', () => ({ default: () => null }))
vi.mock('@/components/new-workspace/SetProjectLocationDialog', () => ({
  SetProjectLocationDialog: () => null
}))

it('renders kind-aware ordinary setup copy from an installed language pack and only selects a form choice', async () => {
  const packId = 'plugin:setup-test.language/es' as const
  setRendererPluginLanguagePacks([
    {
      id: packId,
      resourceLanguage: pluginLanguageResourceId(packId),
      pluginKey: 'setup-test.language',
      locale: 'es',
      coverage: 100,
      catalog: {
        auto: {
          components: {
            NewWorkspaceComposerCard: {
              setupConfigSetupAndDefaultTabs: 'Preparación y comandos',
              askRunSetupAndDefaultTabCommands: '¿Ejecutar ahora?',
              runCommandsNow: 'Ejecutar comandos',
              skipCommands: 'Omitir comandos'
            }
          }
        }
      }
    }
  ])
  const choices = vi.fn()
  const create = vi.fn()
  let container: HTMLDivElement | undefined
  try {
    await i18n.changeLanguage(await loadRendererUiLanguage(packId))
    container = await renderCard({
      advancedOpen: true,
      setupControlsEnabled: true,
      setupConfig: {
        source: 'both',
        command: 'echo shared\n\necho local',
        kind: 'setup-and-default-tabs'
      },
      requiresExplicitSetupChoice: true,
      setupDecision: null,
      resolvedSetupDecision: null,
      onSetupDecisionChange: choices,
      onCreate: create
    })
    expect(container.textContent).toContain('Preparación y comandos')
    expect(container.textContent).toContain('¿Ejecutar ahora?')
    expect(container.textContent).toContain('echo shared\n\necho local')
    const run = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Ejecutar comandos'
    )
    expect(run).toBeTruthy()
    act(() => run?.click())
    expect(choices).toHaveBeenCalledExactlyOnceWith('run')
    expect(create).not.toHaveBeenCalled()
  } finally {
    if (container) {
      unmountCard(container)
    }
    await i18n.changeLanguage('en')
    setRendererPluginLanguagePacks([])
  }
})
