import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import { structuredChatUnavailableText } from './structured-agent-session-launch-failure'

const initialSettings = useAppStore.getState().settings
const OLD = 'Chat is not available in WSL. Open the agent in a terminal instead.'

function desktop(gateOpen: boolean, experimentalWslHosts: boolean, acceptsNewWork = true): void {
  vi.stubGlobal('window', { api: { runtimeEnvironments: gateOpen ? { wslHosts: {} } : {} } })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/me'), experimentalWslHosts },
    wslHostsAcceptNewWork: acceptsNewWork
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({ settings: initialSettings, wslHostsAcceptNewWork: false })
})

it('points a WSL-bridge chat refusal at adding the distro as a WSL host once hosts are on', () => {
  desktop(true, true)
  expect(structuredChatUnavailableText('wsl')).toContain('Add the distro as a WSL host')
})

it('keeps the terminal-only words with the internal gate closed or the setting off', () => {
  desktop(false, true)
  expect(structuredChatUnavailableText('wsl')).toBe(OLD)
  desktop(true, false)
  expect(structuredChatUnavailableText('wsl')).toBe(OLD)
})

it('keeps the terminal-only words in serve-only, where Add WSL distro is hidden', () => {
  desktop(true, true, false)
  expect(structuredChatUnavailableText('wsl')).toBe(OLD)
})

it('leaves the SSH refusal alone', () => {
  desktop(true, true)
  expect(structuredChatUnavailableText('remote')).toBe(
    'Chat is not available over SSH. Open the agent in a terminal instead.'
  )
})
