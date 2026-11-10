import { afterEach, describe, expect, it, vi } from 'vitest'

const { info } = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info } }))

import { getDefaultSettings } from '../../../shared/constants'
import { revealFloatingWorkspacePanel } from './floating-workspace-panel-reveal'

describe('revealing the floating workspace in the web client (#40268)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    info.mockReset()
  })

  it('explains that it needs the desktop app instead of silently doing nothing', () => {
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })
    const updateSettings = vi.fn(async () => {})

    const revealed = revealFloatingWorkspacePanel({
      settings: { ...getDefaultSettings('/home/user'), floatingTerminalEnabled: false },
      updateSettings,
      floatingWorkspacePanelOpen: false
    })

    expect(revealed).toBe(false)
    expect(updateSettings).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledOnce()
  })
})
