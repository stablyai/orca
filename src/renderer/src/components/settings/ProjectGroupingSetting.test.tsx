// @vitest-environment happy-dom
import type { SettingsUpdate } from '@/store/slices/settings'

import { act, useState } from 'react'
import { ProjectGroupingSetting } from './ProjectGroupingSetting'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { GeneralWorkspaceSettingsSection } from './general/GeneralWorkspaceSettingsSection'
import type { ReactNode } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

vi.mock('./general/WorkspaceDirectorySetting', () => ({ WorkspaceDirectorySetting: () => null }))
vi.mock('./general/OpenInMenuSetting', () => ({ OpenInMenuSetting: () => null }))
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

function renderSection(
  updateSettings: (updates: SettingsUpdate) => void | Promise<void>,
  options: {
    defaultsSupported?: boolean
    sourceDefaultsSupported?: boolean
    worktreeVisibilityDefaults?: ReturnType<typeof getDefaultSettings>['worktreeVisibilityDefaults']
  } = {}
): void {
  const settings = getDefaultSettings('/home/user')
  settings.worktreeVisibilityDefaults = options.worktreeVisibilityDefaults
  act(() => {
    root.render(
      <GeneralWorkspaceSettingsSection
        settings={settings}
        updateSettings={updateSettings}
        defaultsSupported={options.defaultsSupported}
        sourceDefaultsSupported={options.sourceDefaultsSupported}
      />
    )
  })
}

describe('project grouping settings', () => {
  it('exposes all three grouping choices and writes the selected default', () => {
    const update = vi.fn()
    renderSection(update)
    const controls = [
      ...container.querySelectorAll<HTMLButtonElement>('#general-projects [role="radio"]')
    ]
    expect(controls.map((button) => button.getAttribute('value'))).toEqual([
      'repository',
      'host',
      'folder'
    ])
    expect(controls[0].getAttribute('aria-checked')).toBe('true')
    act(() => controls[2].click())
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
