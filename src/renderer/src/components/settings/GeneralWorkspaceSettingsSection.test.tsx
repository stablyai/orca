// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { GeneralWorkspaceSettingsSection } from './GeneralWorkspaceSettingsSection'
import type { ReactNode } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

vi.mock('./WorkspaceDirectorySetting', () => ({ WorkspaceDirectorySetting: () => null }))
vi.mock('./OpenInMenuSetting', () => ({ OpenInMenuSetting: () => null }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

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
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>,
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

function getSegment(label: string, visibility: 'show' | 'hide' = 'show'): HTMLButtonElement {
  const control = container.querySelector<HTMLButtonElement>(
    `[aria-label="Visibility for ${label}"] [data-visibility="${visibility}"]`
  )
  if (!control) {
    throw new Error(`${visibility} segment not found: ${label}`)
  }
  return control
}

describe('GeneralWorkspaceSettingsSection external visibility', () => {
  it('writes only Other locations when a downgraded host retains source fields', async () => {
    const updateSettings = vi.fn()
    renderSection(updateSettings, {
      sourceDefaultsSupported: false,
      worktreeVisibilityDefaults: {
        external: 'hide',
        customSources: [{ id: 'team', rootPath: '/srv/team' }],
        sourcePreferences: { builtIn: { claude: 'show' } }
      }
    })

    await act(async () => {
      getSegment('Other locations').click()
    })

    expect(updateSettings).toHaveBeenCalledWith({
      worktreeVisibilityDefaults: { external: 'show' }
    })
  })

  it('adds a global location disabled by default', async () => {
    const updateSettings = vi.fn()
    renderSection(updateSettings)
    const input = container.querySelector<HTMLInputElement>('#custom-worktree-root')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(input, '/srv/team-worktrees')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    })

    const defaults = updateSettings.mock.calls[0]?.[0].worktreeVisibilityDefaults
    expect(defaults).toMatchObject({
      external: 'hide',
      customSources: [{ rootPath: '/srv/team-worktrees' }],
      sourcePreferences: { custom: expect.any(Object) }
    })
    const sourceId = defaults.customSources[0].id
    expect(defaults.sourcePreferences.custom).toEqual({ [sourceId]: 'hide' })
  })
})
