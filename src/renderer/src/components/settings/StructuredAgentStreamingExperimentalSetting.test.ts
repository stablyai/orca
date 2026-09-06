import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { StructuredAgentStreamingExperimentalSetting } from './StructuredAgentStreamingExperimentalSetting'

describe('StructuredAgentStreamingExperimentalSetting', () => {
  it('restores every provider switch and the room delivery mode under one master', () => {
    const updateSettings = vi.fn()
    const defaults = getDefaultSettings('/tmp')
    const disabled = StructuredAgentStreamingExperimentalSetting({
      settings: { ...defaults, experimentalStructuredNativeChat: false },
      updateSettings
    })
    expect(findElements(disabled, 'SettingsSwitchRow')).toHaveLength(0)

    const enabled = StructuredAgentStreamingExperimentalSetting({
      settings: { ...defaults, experimentalStructuredNativeChat: true },
      updateSettings
    })
    const switches = findElements(enabled, 'SettingsSwitchRow')
    expect(switches.map((element) => element.props.label)).toEqual([
      'Claude',
      'OpenClaude',
      'Codex',
      'Grok',
      'OMP',
      'Live steering in rooms'
    ])
    expect(switches.map((element) => element.props.checked)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false
    ])
  })
})

type FoundElement = ReactElement<{ label?: ReactNode; checked?: boolean }>

function findElements(node: ReactNode, typeName: string): FoundElement[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => findElements(child, typeName))
  }
  if (!isValidElement(node)) {
    return []
  }
  const name = typeof node.type === 'function' ? node.type.name : node.type
  return [
    ...(name === typeName ? [node as FoundElement] : []),
    ...findElements((node.props as { children?: ReactNode }).children, typeName)
  ]
}
