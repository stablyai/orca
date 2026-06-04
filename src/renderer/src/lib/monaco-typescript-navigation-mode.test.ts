import { describe, expect, it, vi } from 'vitest'

const { javascriptModeConfigurationMock, typescriptModeConfigurationMock } = vi.hoisted(() => ({
  javascriptModeConfigurationMock: vi.fn(),
  typescriptModeConfigurationMock: vi.fn()
}))

vi.mock('monaco-editor', () => ({
  typescript: {
    javascriptDefaults: {
      setModeConfiguration: javascriptModeConfigurationMock
    },
    typescriptDefaults: {
      setModeConfiguration: typescriptModeConfigurationMock
    }
  }
}))

import {
  buildTypeScriptNavigationModeConfig,
  setTypeScriptNavigationMode
} from './monaco-typescript-navigation-mode'

describe('monaco TypeScript navigation mode', () => {
  it('keeps built-in definitions and references when code intelligence is off', () => {
    expect(buildTypeScriptNavigationModeConfig(false)).toMatchObject({
      definitions: true,
      references: true
    })
  })

  it('disables built-in definitions and references when code intelligence is on', () => {
    expect(buildTypeScriptNavigationModeConfig(true)).toMatchObject({
      definitions: false,
      references: false
    })
  })

  it('applies the same mode configuration to TypeScript and JavaScript', () => {
    setTypeScriptNavigationMode(true)

    expect(typescriptModeConfigurationMock).toHaveBeenCalledWith(
      expect.objectContaining({ definitions: false, references: false })
    )
    expect(javascriptModeConfigurationMock).toHaveBeenCalledWith(
      expect.objectContaining({ definitions: false, references: false })
    )
  })
})
