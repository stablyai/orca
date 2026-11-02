// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { NativeChatCrewFrame } from './NativeChatCrewPanel'
import { TerminalCrewPortals } from './TerminalCrewPortals'
import { ExperimentalPane, getExperimentalPaneSearchEntries } from '../settings/ExperimentalPane'
import { TooltipProvider } from '../ui/tooltip'
import { i18n, loadRendererUiLanguage, translate } from '@/i18n/i18n'

const initialState = useAppStore.getState()
afterEach(async () => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await i18n.changeLanguage('en')
})

it('keeps restored opt-in settings dormant across terminal and native-chat panes', async () => {
  const saved = { ...getDefaultSettings('/home/test'), experimentalOrchestrationPanel: true }
  vi.stubGlobal('api', { settings: { get: vi.fn().mockResolvedValue(saved) } })
  await useAppStore.getState().fetchSettings()
  expect(useAppStore.getState().settings?.experimentalOrchestrationPanel).toBe(true)

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
})

it.each(['en', 'de'] as const)('removes the switch and search result in %s', async (language) => {
  await i18n.changeLanguage(await loadRendererUiLanguage(language))
  const settings = { ...getDefaultSettings('/home/test'), experimentalOrchestrationPanel: true }
  useAppStore.setState({ settings, settingsSearchQuery: '' })
  const view = render(
    <TooltipProvider>
      <ExperimentalPane settings={settings} updateSettings={vi.fn()} hiddenExperimentalUnlocked />
    </TooltipProvider>
  )
  const title = translate(
    'auto.components.settings.experimental.search.orchestrationPanel.title',
    'Orchestration panel'
  )
  expect(view.container.querySelector('#experimental-orchestration-panel')).toBeNull()
  expect(screen.queryByText(title)).not.toBeInTheDocument()
  expect(getExperimentalPaneSearchEntries().some((entry) => entry.title === title)).toBe(false)
  expect(view.container.querySelector('#experimental-browser-extensions')).not.toBeNull()
})
