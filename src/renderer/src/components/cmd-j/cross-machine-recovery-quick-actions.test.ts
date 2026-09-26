// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { getCrossMachineRecoveryQuickActions } from './cross-machine-recovery-quick-actions'
import { getCmdJQuickActions } from './quick-actions'
import type { CmdJQuickActionContext } from './quick-action-context'
import {
  consumeCrossMachineRecoveryDialogRequest,
  getCrossMachineRecoveryDialogRequest
} from '@/components/cross-machine-recovery/cross-machine-recovery-dialog-request'
import { createWebCrossMachineRecoveryApi } from '@/web/preload-api/web-cross-machine-recovery-api'

function installBridge(isSupported: boolean): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { crossMachineRecovery: { ...createWebCrossMachineRecoveryApi(), isSupported } }
  })
}

const ctx: CmdJQuickActionContext = {
  activeView: 'terminal',
  activeWorktreeId: null,
  activeWorktree: null,
  isLoading: false,
  sshStatus: null,
  runtimeMode: 'local-desktop',
  activeGroupId: null,
  openNewBrowserTab: async () => {},
  openNewMarkdownFile: async () => {},
  openNewTerminalTab: async () => {},
  openCreateWorkspace: () => {},
  deleteActiveWorkspace: () => {},
  openAddQuickCommand: () => {}
}

afterEach(() => consumeCrossMachineRecoveryDialogRequest())

describe('recover-sessions quick action', () => {
  it('is registered in the Cmd-J catalog', () => {
    expect(getCmdJQuickActions().some((action) => action.id === 'recover-sessions')).toBe(true)
  })

  it('is hidden on the web build, whose bridge is unsupported', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { crossMachineRecovery: createWebCrossMachineRecoveryApi() }
    })
    const [action] = getCrossMachineRecoveryQuickActions()
    expect(action.isAvailable(ctx)).toEqual({
      available: false,
      reason: 'client-action-unsupported'
    })
    await expect(action.run(ctx)).resolves.toEqual({
      status: 'unavailable',
      reason: 'client-action-unsupported'
    })
    expect(getCrossMachineRecoveryDialogRequest()).toBe(false)
  })

  it('opens the recovery dialog on a supported desktop', async () => {
    installBridge(true)
    const [action] = getCrossMachineRecoveryQuickActions()
    expect(action.isAvailable(ctx)).toEqual({ available: true })
    await expect(action.run(ctx)).resolves.toEqual({ status: 'ok' })
    expect(getCrossMachineRecoveryDialogRequest()).toBe(true)
  })

  it('stays hidden when the desktop bridge reports unsupported', () => {
    installBridge(false)
    expect(getCrossMachineRecoveryQuickActions()[0].isAvailable(ctx).available).toBe(false)
  })
})
