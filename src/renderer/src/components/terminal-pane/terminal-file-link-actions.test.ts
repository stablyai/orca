import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLinkActionContext } from './terminal-link-action-request'

const mocks = vi.hoisted(() => ({
  canOpenWithSystemDefault: true,
  modifierInverts: false,
  openDetectedFilePath: vi.fn(),
  worktreeRoot: false
}))

vi.mock('./terminal-file-open-routing', () => ({
  getTerminalFileContext: () => ({}),
  isTerminalFileLinkModifierInverted: () => mocks.modifierInverts,
  mapTerminalFilePath: (filePath: string) => filePath,
  openDetectedFilePath: mocks.openDetectedFilePath,
  shouldOpenTerminalFileWithSystemDefault: () => mocks.canOpenWithSystemDefault,
  terminalLinkWslDistro: () => null
}))

vi.mock('./terminal-worktree-path-link', () => ({
  resolveKnownWorktreeRootPathLink: () => (mocks.worktreeRoot ? { id: 'wt-2' } : null)
}))

import { handleTerminalFileLink } from './terminal-file-link-actions'

const deps = { worktreeId: 'wt-1', worktreePath: '/repo' }

function plainEvent(): MouseEvent {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    clientX: 12,
    clientY: 24,
    preventDefault: vi.fn()
  } as unknown as MouseEvent
}

function modifierEvent(shiftKey: boolean): MouseEvent {
  return { ...plainEvent(), metaKey: true, shiftKey } as unknown as MouseEvent
}

function context(request: ReturnType<typeof vi.fn>): TerminalLinkActionContext {
  return {
    paneId: 3,
    pointerGesture: { canRequestAction: () => true, dispose: vi.fn() },
    claimPtyMouse: vi.fn(() => true),
    request: request as TerminalLinkActionContext['request'],
    focusTerminal: vi.fn()
  }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  mocks.canOpenWithSystemDefault = true
  mocks.modifierInverts = false
  mocks.worktreeRoot = false
  vi.clearAllMocks()
})

afterEach(() => vi.unstubAllGlobals())

describe('terminal file link actions', () => {
  it('offers Orca and system-default actions for a local file', () => {
    const request = vi.fn()
    expect(
      handleTerminalFileLink('/repo/src/main.ts', 12, 4, plainEvent(), deps, context(request))
    ).toBe(true)

    const actionRequest = request.mock.calls[0][0]
    expect(actionRequest).toEqual(
      expect.objectContaining({
        destination: '/repo/src/main.ts',
        kind: 'file',
        primary: expect.objectContaining({ label: 'Open file' }),
        alternate: expect.objectContaining({ label: 'Open with default app' })
      })
    )
    actionRequest.primary.run()
    actionRequest.alternate.run()
    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(1, '/repo/src/main.ts', 12, 4, deps)
    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(2, '/repo/src/main.ts', 12, 4, {
      ...deps,
      openWithSystemDefault: true
    })
  })

  it('sends the bare modifier to Orca and Shift to the default app', () => {
    handleTerminalFileLink('/repo/src/main.ts', 1, 1, modifierEvent(false), deps)
    handleTerminalFileLink('/repo/src/main.ts', 1, 1, modifierEvent(true), deps)

    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(1, '/repo/src/main.ts', 1, 1, {
      ...deps,
      openWithSystemDefault: false
    })
    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(2, '/repo/src/main.ts', 1, 1, {
      ...deps,
      openWithSystemDefault: true
    })
  })

  it('swaps the two chords when the modifier inverts', () => {
    mocks.modifierInverts = true
    handleTerminalFileLink('/repo/src/main.ts', 1, 1, modifierEvent(false), deps)
    handleTerminalFileLink('/repo/src/main.ts', 1, 1, modifierEvent(true), deps)

    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(1, '/repo/src/main.ts', 1, 1, {
      ...deps,
      openWithSystemDefault: true
    })
    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(2, '/repo/src/main.ts', 1, 1, {
      ...deps,
      openWithSystemDefault: false
    })
  })

  it('promotes the system-default action to primary when the modifier inverts', () => {
    mocks.modifierInverts = true
    const request = vi.fn()
    handleTerminalFileLink('/repo/src/main.ts', 12, 4, plainEvent(), deps, context(request))

    expect(request.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        primary: expect.objectContaining({ label: 'Open with default app' }),
        alternate: expect.objectContaining({ label: 'Open file' })
      })
    )
  })

  it('keeps Orca primary for a remote path the inverted modifier cannot reach', () => {
    mocks.canOpenWithSystemDefault = false
    mocks.modifierInverts = true
    const request = vi.fn()
    handleTerminalFileLink('/remote/src/main.ts', null, null, plainEvent(), deps, context(request))

    const actionRequest = request.mock.calls[0][0]
    expect(actionRequest.primary).toEqual(expect.objectContaining({ label: 'Open file' }))
    expect(actionRequest).not.toHaveProperty('alternate')
  })

  it('labels workspace switching and omits an impossible remote alternate', () => {
    mocks.worktreeRoot = true
    mocks.canOpenWithSystemDefault = false
    const request = vi.fn()
    handleTerminalFileLink('/repo', null, null, plainEvent(), deps, context(request))

    const actionRequest = request.mock.calls[0][0]
    expect(actionRequest).toEqual(
      expect.objectContaining({
        kind: 'workspace',
        primary: expect.objectContaining({ label: 'Switch workspace' })
      })
    )
    expect(actionRequest).not.toHaveProperty('alternate')
  })
})
