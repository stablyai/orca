// @vitest-environment happy-dom
import type { SettingsUpdate } from '@/store/slices/settings/create-settings-slice'

import { act, useState } from 'react'
import { ProjectGroupingSetting } from './ProjectGroupingSetting'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ReactNode } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderSection(updateSettings: (updates: SettingsUpdate) => void): void {
  const settings = getDefaultSettings('/home/user')
  act(() => {
    root.render(<ProjectGroupingSetting settings={settings} updateSettings={updateSettings} />)
  })
}

describe('project grouping settings', () => {
  it('exposes all three grouping choices and writes the selected default', async () => {
    const update = vi.fn()
    renderSection(update)
    const select = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
    expect(select.textContent).toContain('By repository')
    await act(async () => {
      select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual([
      'By repository',
      'Separate by host',
      'Separate by folder'
    ])
    await act(async () => {
      options[2].click()
    })
    expect(update).toHaveBeenCalledWith({ projectGroupingMode: 'folder' })
  })

  it('switches a repository override back to the current default without changing offline preferences', async () => {
    const persisted = vi.fn()
    function Control() {
      const [settings, setSettings] = useState<GlobalSettings>(() => ({
        ...getDefaultSettings('/tmp'),
        projectGroupingMode: 'host' as const,
        projectGroupingOverrides: { app: 'folder' as const, offline: 'repository' as const }
      }))
      return (
        <ProjectGroupingSetting
          projectId="app"
          settings={settings}
          updateSettings={(update) => {
            const patch = typeof update === 'function' ? update(settings) : update
            const next = { ...settings, ...patch }
            persisted(next)
            setSettings(next)
          }}
        />
      )
    }
    act(() => root.render(<Control />))
    const select = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
    expect(select.textContent).toContain('Separate by folder')
    await act(async () => {
      select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const useDefault = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('Use default')
    )
    expect(useDefault?.textContent).toContain('Separate by host')
    await act(async () => {
      useDefault?.click()
    })
    expect(persisted.mock.calls.at(-1)?.[0].projectGroupingOverrides).toEqual({
      offline: 'repository'
    })
    expect(select.textContent).toContain('Use default (Separate by host)')
  })
})
