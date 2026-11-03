// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { NativeChatCrewFrame } from './NativeChatCrewPanel'
import { TerminalCrewPortals } from './TerminalCrewPortals'
import { useOrchestrationPanelEnabled } from './use-orchestration-panel-enabled'
import { ExperimentalPane, getExperimentalPaneSearchEntries } from '../settings/ExperimentalPane'
import { getExperimentalSearchEntry } from '../settings/experimental-search'
import { getOrchestrationPanelExperimentalSearchEntry } from '../settings/orchestration-panel-experimental-search'
import { TooltipProvider } from '../ui/tooltip'
import { i18n, loadRendererUiLanguage, translate } from '@/i18n/i18n'

const initialState = useAppStore.getState()
let originalGerman: object | undefined
afterEach(async () => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalGerman) {
    i18n.removeResourceBundle('de', 'translation')
    i18n.addResourceBundle('de', 'translation', originalGerman)
    originalGerman = undefined
  }
  await i18n.changeLanguage('en')
})

it.each(['unhydrated', 'unset', 'false'] as const)(
  'does no panel or pane discovery work while %s',
  (state) => {
    const settings = getDefaultSettings('/home/test')
    if (state === 'unset') {
      delete settings.experimentalOrchestrationPanel
    }
    useAppStore.setState({ settings: state === 'unhydrated' ? null : settings })

    const readPanes = vi.fn(() => [])
    const controller: ComponentProps<typeof TerminalCrewPortals>['controller'] = {
      tabId: 'terminal',
      worktreeId: 'workspace',
      managerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isRendererVisible: true,
      expandedPaneId: null,
      isolatedPaneKey: null,
      get managedPanes() {
        return readPanes()
      },
      effectiveChatViewMode: false,
      chatPane: null
    }
    const mountPanel = vi.fn(() => <aside>Orchestration subscription</aside>)
    const Panel = mountPanel
    render(
      <>
        {Array.from({ length: 172 }, (_, index) => (
          <NativeChatCrewFrame key={index} panel={<Panel />}>
            <TerminalCrewPortals controller={controller} />
            <span>Conversation {index}</span>
          </NativeChatCrewFrame>
        ))}
      </>
    )
    expect(screen.getByText('Conversation 171')).toBeInTheDocument()
    expect(mountPanel).not.toHaveBeenCalled()
    expect(readPanes).not.toHaveBeenCalled()
  }
)

it('hydrates the preserved opt-in and responds to a live settings change', async () => {
  const saved = { ...getDefaultSettings('/home/test'), experimentalOrchestrationPanel: true }
  vi.stubGlobal('api', { settings: { get: vi.fn().mockResolvedValue(saved) } })
  const view = render(
    <NativeChatCrewFrame panel={<aside>Enabled crew</aside>}>
      <span>Transcript</span>
    </NativeChatCrewFrame>
  )
  expect(screen.queryByText('Enabled crew')).not.toBeInTheDocument()
  const transcript = screen.getByText('Transcript')
  await act(async () => useAppStore.getState().fetchSettings())
  expect(screen.getByText('Enabled crew')).toBeInTheDocument()
  act(() => useAppStore.setState({ settings: { ...saved, experimentalOrchestrationPanel: false } }))
  expect(screen.queryByText('Enabled crew')).not.toBeInTheDocument()
  expect(screen.getByText('Transcript')).toBe(transcript)
  view.unmount()
})

it.each([2, 20])('isolates %i gate consumers from unrelated store updates', async (count) => {
  useAppStore.setState({ settings: getDefaultSettings('/home/test') })
  const renders = Array<number>(count).fill(0)
  const consumers = Array.from({ length: count }, (_, index) => ({ id: `gate-${index}`, index }))
  function Gate({ index }: { index: number }) {
    const enabled = useOrchestrationPanelEnabled()
    renders[index] += 1
    return <output data-testid={`gate-${index}`}>{String(enabled)}</output>
  }
  render(
    <>
      {consumers.map(({ id, index }) => (
        <Gate key={id} index={index} />
      ))}
    </>
  )
  await act(async () => {})
  for (const enabled of [true, false]) {
    renders.fill(0)
    await act(async () => {
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, experimentalOrchestrationPanel: enabled }
      }))
    })
    expect(renders).toEqual(Array<number>(count).fill(1))
    expect(screen.getByTestId(`gate-${count - 1}`)).toHaveTextContent(String(enabled))
    renders.fill(0)
    await act(async () => {
      useAppStore.setState({ settingsSearchQuery: `unused-${enabled}` })
    })
    expect(renders).toEqual(Array<number>(count).fill(0))
    await act(async () => {
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, language: enabled ? 'de' : 'en' }
      }))
    })
    expect(renders).toEqual(Array<number>(count).fill(0))
    await act(async () => {
      useAppStore.setState((state) => ({
        runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set(
          'other-host',
          {
            status: null,
            checkedAt: enabled ? 1 : 2
          }
        )
      }))
    })
    expect(renders).toEqual(Array<number>(count).fill(0))
  }
})

it.each(['en', 'de'] as const)(
  'restores the switch and searchable English fallback in %s',
  async (language) => {
    await i18n.changeLanguage(await loadRendererUiLanguage(language))
    const settings = getDefaultSettings('/home/test')
    useAppStore.setState({ settings, settingsSearchQuery: 'orchestration' })
    const updateSettings = vi.fn()
    const view = render(
      <TooltipProvider>
        <ExperimentalPane
          settings={settings}
          updateSettings={updateSettings}
          hiddenExperimentalUnlocked
        />
      </TooltipProvider>
    )
    const title = translate(
      'auto.components.settings.experimental.search.orchestrationPanel.title',
      'Orchestration panel'
    )
    expect(view.container.querySelector('#experimental-orchestration-panel')).not.toBeNull()
    expect(screen.getByText(title)).toBeInTheDocument()
    expect(getExperimentalPaneSearchEntries()).toContainEqual(
      getExperimentalSearchEntry().orchestrationPanel
    )
    const toggle = screen.getByRole('switch', { name: 'Toggle orchestration panel' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ experimentalOrchestrationPanel: true })
    view.rerender(
      <TooltipProvider>
        <ExperimentalPane
          settings={{ ...settings, experimentalOrchestrationPanel: true }}
          updateSettings={updateSettings}
        />
      </TooltipProvider>
    )
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenLastCalledWith({ experimentalOrchestrationPanel: false })
    act(() => useAppStore.setState({ settingsSearchQuery: 'unrelated query' }))
    expect(view.container.querySelector('#experimental-orchestration-panel')).toBeNull()
  }
)

it('refreshes translated output and search aliases when language or resources change', async () => {
  await i18n.changeLanguage(await loadRendererUiLanguage('de'))
  originalGerman = structuredClone(i18n.getResourceBundle('de', 'translation'))
  const prefix = 'auto.components.settings.experimental.search.orchestrationPanel'
  i18n.addResource('de', 'translation', `${prefix}.title`, 'Agentengruppe')
  i18n.addResource('de', 'translation', `${prefix}.description`, 'Zeigt verbundene Agenten.')
  i18n.addResource('de', 'translation', `${prefix}.workers`, 'Mitarbeiter')
  i18n.addResource(
    'de',
    'translation',
    'auto.components.settings.ExperimentalPane.orchestrationPanel.toggleLabel',
    'Agentengruppe umschalten'
  )
  const settings = getDefaultSettings('/home/test')
  useAppStore.setState({ settings, settingsSearchQuery: 'Mitarbeiter' })
  const renderPane = () => (
    <TooltipProvider>
      <ExperimentalPane settings={settings} updateSettings={vi.fn()} />
    </TooltipProvider>
  )
  const view = render(renderPane())
  expect(screen.getByText('Agentengruppe')).toBeInTheDocument()
  expect(screen.getByText('Zeigt verbundene Agenten.')).toBeInTheDocument()
  expect(screen.getByRole('switch', { name: 'Agentengruppe umschalten' })).toBeInTheDocument()
  const entry = getExperimentalSearchEntry().orchestrationPanel
  expect(entry.targetSectionId).toBe('experimental-orchestration-panel')
  expect(entry.keywords).toEqual(expect.arrayContaining(['Mitarbeiter', 'workers']))
  i18n.addResource('de', 'translation', `${prefix}.title`, 'Neue Agentengruppe')
  view.rerender(renderPane())
  expect(screen.getByText('Neue Agentengruppe')).toBeInTheDocument()
  expect(getExperimentalPaneSearchEntries()).toContainEqual(
    getOrchestrationPanelExperimentalSearchEntry()
  )
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  act(() => useAppStore.setState({ settingsSearchQuery: 'workers' }))
  view.rerender(renderPane())
  expect(screen.getByText('Orchestration panel')).toBeInTheDocument()
})
