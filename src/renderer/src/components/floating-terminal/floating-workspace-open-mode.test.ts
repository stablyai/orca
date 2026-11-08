import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  selectFloatingWorkspaceOnScreen,
  selectFloatingWorkspacePanelVisible
} from '@/store/workspaces/floating/floating-workspace-panel-selector'
import {
  canOpenFloatingWorkspacePopout,
  resolveFloatingWorkspaceMode
} from './floating-workspace-open-mode'

const popoutSettings = {
  ...getDefaultSettings('/test'),
  floatingTerminalEnabled: true,
  experimentalFloatingWorkspacePopout: true,
  experimentalFloatingWorkspaceMode: 'popout' as const
}

describe('Floating Workspace open mode', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('a web client resolves in-window with every flag on and cannot open the pop-out', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    expect(canOpenFloatingWorkspacePopout()).toBe(false)
    expect(resolveFloatingWorkspaceMode(popoutSettings)).toBe('in-window')
  })

  it('splits panel-visible from on-screen in pop-out mode', () => {
    const state = { settings: popoutSettings, floatingWorkspacePanelOpen: true }
    expect(selectFloatingWorkspacePanelVisible(state)).toBe(false)
    expect(selectFloatingWorkspaceOnScreen(state)).toBe(true)
    const inWindow = {
      settings: { ...popoutSettings, experimentalFloatingWorkspaceMode: 'in-window' as const },
      floatingWorkspacePanelOpen: true
    }
    expect(selectFloatingWorkspacePanelVisible(inWindow)).toBe(true)
    expect(selectFloatingWorkspaceOnScreen(inWindow)).toBe(true)
  })
})
