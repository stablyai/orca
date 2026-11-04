// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { NativeChatCrewFrame } from './NativeChatCrewPanel'
import { TerminalCrewPortals } from './TerminalCrewPortals'
import { ExperimentalPane } from '../settings/advanced/ExperimentalPane'
import { getExperimentalPaneSearchEntries } from '../settings/advanced/experimental-search'
import { TooltipProvider } from '../ui/tooltip'

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
})

it('keeps the panel suspended when an existing user hydrates a saved opt-in', async () => {
  const saved = { ...getDefaultSettings('/home/test'), experimentalOrchestrationPanel: true }
  vi.stubGlobal('api', { settings: { get: vi.fn().mockResolvedValue(saved) } })
  useAppStore.setState({ settings: null })
  const controller: ComponentProps<typeof TerminalCrewPortals>['controller'] = {
    tabId: 'terminal',
    worktreeId: 'workspace',
    managerRef: { current: null },
    paneTransportsRef: { current: new Map() },
    isRendererVisible: true,
    expandedPaneId: null,
    isolatedPaneKey: null,
    get managedPanes(): never {
      throw new Error('Suspended panel must not discover terminal panes')
    },
    effectiveChatViewMode: false,
    chatPane: null
  }
  const content = () => (
    <NativeChatCrewFrame panel={<aside aria-label="Orchestration" />}>
      <TerminalCrewPortals controller={controller} />
      <span>Transcript</span>
    </NativeChatCrewFrame>
  )
  const view = render(content())
  const transcript = screen.getByText('Transcript')
  await act(async () => useAppStore.getState().fetchSettings())
  view.rerender(content())
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  expect(screen.getByText('Transcript')).toBe(transcript)
})

it('offers no orchestration opt-in in Settings or its search catalog', () => {
  const settings = { ...getDefaultSettings('/home/test'), experimentalOrchestrationPanel: true }
  useAppStore.setState({ settings })
  const view = render(
    <TooltipProvider>
      <ExperimentalPane settings={settings} updateSettings={vi.fn()} hiddenExperimentalUnlocked />
    </TooltipProvider>
  )
  expect(view.container.querySelector('#experimental-orchestration-panel')).toBeNull()
  expect(getExperimentalPaneSearchEntries().map((entry) => entry.targetSectionId)).not.toContain(
    'experimental-orchestration-panel'
  )
})
