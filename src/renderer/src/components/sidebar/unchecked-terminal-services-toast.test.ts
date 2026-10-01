import { beforeEach, describe, expect, it, vi } from 'vitest'

const { infoMock } = vi.hoisted(() => ({ infoMock: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: infoMock } }))

import { showUncheckedTerminalServicesToast } from './unchecked-terminal-services-toast'

const unchecked = { uncheckedTerminalServices: [{ protocolVersion: 35 }] }

describe('showUncheckedTerminalServicesToast', () => {
  beforeEach(() => {
    infoMock.mockReset()
  })

  it('offers to open Manage Sessions for a delete on this machine, under one toast id', () => {
    const openManageSessions = vi.fn()
    showUncheckedTerminalServicesToast(unchecked, openManageSessions)
    showUncheckedTerminalServicesToast(unchecked, openManageSessions)

    expect(infoMock).toHaveBeenCalledTimes(2)
    const [title, options] = infoMock.mock.calls[0]!
    expect(title).toContain('didn’t answer')
    expect(title).not.toContain('older')
    expect(options.id).toBe(infoMock.mock.calls[1]![1].id)
    options.action.onClick()
    expect(openManageSessions).toHaveBeenCalledOnce()
  })

  it('does not point a paired host’s delete at this machine’s Manage Sessions', () => {
    showUncheckedTerminalServicesToast(unchecked, undefined)

    const [, options] = infoMock.mock.calls[0]!
    expect(options.action).toBeUndefined()
    expect(options.description).not.toContain('Manage Sessions')
  })

  it('stays silent for an ordinary delete', () => {
    showUncheckedTerminalServicesToast({}, vi.fn())
    showUncheckedTerminalServicesToast(undefined, vi.fn())

    expect(infoMock).not.toHaveBeenCalled()
  })
})
