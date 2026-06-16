import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { SettingsSegmentedControl } from './SettingsFormControls'
import { DefaultWindowsProjectRuntimeSetting } from './DefaultWindowsProjectRuntimeSetting'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
  if (element.props?.control) {
    visit(element.props.control, cb)
  }
}

function findRuntimeControl(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (
      entry.type === SettingsSegmentedControl &&
      entry.props.ariaLabel === 'Default project runtime'
    ) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('default project runtime control not found')
  }
  return found
}

function findDistroSelect(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props.value === 'Ubuntu-24.04' && typeof entry.props.onValueChange === 'function') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('default distro select not found')
  }
  return found
}

function renderSetting(
  props: React.ComponentProps<typeof DefaultWindowsProjectRuntimeSetting>
): React.JSX.Element | null {
  return DefaultWindowsProjectRuntimeSetting(props)
}

describe('DefaultWindowsProjectRuntimeSetting', () => {
  it('describes the Windows host global default', () => {
    const markup = renderToStaticMarkup(
      <DefaultWindowsProjectRuntimeSetting
        settings={getDefaultSettings('/tmp')}
        updateSettings={vi.fn()}
        wslSupportedPlatform
        wslAvailable
        wslDistros={['Ubuntu-24.04']}
        wslCapabilitiesLoading={false}
      />
    )

    expect(markup).toContain('Default project runtime')
    expect(markup).toContain('Projects inherit Windows unless a project overrides it.')
  })

  it('updates the global default to WSL using the first available distro', () => {
    const updateSettings = vi.fn()
    const element = renderSetting({
      settings: getDefaultSettings('/tmp'),
      updateSettings,
      wslSupportedPlatform: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu-24.04'],
      wslCapabilitiesLoading: false
    })
    const control = findRuntimeControl(element)
    const onChange = control.props.onChange as (value: 'windows-host' | 'wsl') => void

    onChange('wsl')

    expect(updateSettings).toHaveBeenCalledWith({
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu-24.04' }
    })
  })

  it('updates the selected WSL distro for the global default', () => {
    const updateSettings = vi.fn()
    const element = renderSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu-24.04' }
      },
      updateSettings,
      wslSupportedPlatform: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu-24.04', 'Debian'],
      wslCapabilitiesLoading: false
    })
    const select = findDistroSelect(element)
    const onValueChange = select.props.onValueChange as (value: string) => void

    onValueChange('Debian')

    expect(updateSettings).toHaveBeenCalledWith({
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' }
    })
  })

  it('does not render where local Windows WSL selection is unsupported', () => {
    const markup = renderToStaticMarkup(
      <DefaultWindowsProjectRuntimeSetting
        settings={getDefaultSettings('/tmp')}
        updateSettings={vi.fn()}
        wslSupportedPlatform={false}
        wslAvailable={false}
        wslDistros={[]}
        wslCapabilitiesLoading={false}
      />
    )

    expect(markup).toBe('')
  })
})
