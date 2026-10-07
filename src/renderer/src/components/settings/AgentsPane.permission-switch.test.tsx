// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AgentsPane } from './AgentsPane'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'codex'],
    isLoading: false,
    detectionFailed: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

type UpdateSettings = (updates: Partial<GlobalSettings>) => void

async function renderPane(settings: GlobalSettings, updateSettings: UpdateSettings) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AgentsPane settings={settings} updateSettings={updateSettings} />
      </TooltipProvider>
    )
  )
}

async function clickSwitch(label: 'Yolo' | 'Manual'): Promise<void> {
  const group = container.querySelector('[role="radiogroup"][aria-label="Agent Permissions"]')
  const option = [...(group?.querySelectorAll('[role="radio"]') ?? [])].find(
    (radio) => radio.textContent === label
  )
  expect(option).toBeDefined()
  await act(async () => option?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

// The switch sets only the shared default; an agent's own choice stays until its card says Default.
describe('AgentsPane permission switch', () => {
  const codexManual = {
    ...getDefaultSettings('/tmp'),
    agentPermissionMode: 'bypass',
    agentPermissionModeOverrides: { codex: 'ask' }
  }

  it('keeps Codex Manual when the already selected Yolo is clicked', async () => {
    const updateSettings = vi.fn<UpdateSettings>()
    await renderPane(codexManual, updateSettings)

    await clickSwitch('Yolo')

    expect(updateSettings).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Codex runs Manual: it has its own setting.')
  })

  it('changes only the shared default when Manual is clicked', async () => {
    const updateSettings = vi.fn<UpdateSettings>()
    await renderPane(codexManual, updateSettings)

    await clickSwitch('Manual')

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ agentPermissionMode: 'ask' })
  })
})
