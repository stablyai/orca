import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY,
  AGENT_SESSION_THEME_PARAMS_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { publishTerminalViewAttributes } from '../../../../components/terminal-pane/appearance/terminal-view-attributes-publisher'
import { createAgentSessionTerminalOptions } from './agent-session-terminal-options'

type FakeHost = {
  capabilities: string[]
  failure: Error | null
  failing: string | null
  probe: Promise<void>
}

const host = vi.hoisted((): FakeHost => ({
  capabilities: [],
  failure: null,
  failing: null,
  probe: Promise.resolve()
}))

vi.mock('../../../rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async (_environmentId: string, capability: string) => {
    await host.probe
    if (host.failure && host.failing === capability) {
      throw host.failure
    }
    return host.capabilities.includes(capability)
  }
}))

const colors = { foreground: '#000000', background: '#ffffff' }

describe('createAgentSessionTerminalOptions', () => {
  beforeEach(() => {
    host.capabilities = [AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY]
    host.failure = null
    host.failing = null
    host.probe = Promise.resolve()
  })

  it('keeps theme fields off hosts whose strict launch schema predates them', async () => {
    await expect(createAgentSessionTerminalOptions(true, colors)('env')).resolves.toEqual({
      terminalKittyKeyboardProtocol: true
    })
  })

  it('sends the launching theme to hosts that advertise theme params', async () => {
    host.capabilities = [AGENT_SESSION_THEME_PARAMS_RUNTIME_CAPABILITY]
    await expect(createAgentSessionTerminalOptions(true, colors)('env')).resolves.toMatchObject({
      terminalColorQueryReplies: colors
    })
  })

  it('sends the palette published with the colors, not one published during the probe', async () => {
    const settings = { terminalCursorStyle: 'block' as const, terminalCursorBlink: false }
    publishTerminalViewAttributes({ blue: '#0000ff' }, 'light', settings, () => true)
    host.capabilities = [AGENT_SESSION_THEME_PARAMS_RUNTIME_CAPABILITY]
    let finishProbe = () => {}
    host.probe = new Promise((resolve) => (finishProbe = resolve))
    const pending = createAgentSessionTerminalOptions(undefined, colors)('env')
    publishTerminalViewAttributes({ blue: '#00ff00' }, 'dark', settings, () => true)
    finishProbe()
    const options = await pending
    expect(options.terminalViewAttributes?.colorSchemeMode).toBe('light')
    expect(options.terminalViewAttributes?.ansi[4]).toEqual([0, 0, 255])
  })

  it('keeps the keyboard option when only the theme probe fails transiently', async () => {
    host.failure = new Error('timeout')
    host.failing = AGENT_SESSION_THEME_PARAMS_RUNTIME_CAPABILITY
    await expect(createAgentSessionTerminalOptions(true, colors)('env')).resolves.toEqual({
      terminalKittyKeyboardProtocol: true
    })
  })
})
