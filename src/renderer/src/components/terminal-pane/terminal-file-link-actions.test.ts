import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLinkActionContext } from './terminal-link-action-request'

const mocks = vi.hoisted(() => ({
  canOpenWithSystemDefault: true,
  openDetectedFilePath: vi.fn(),
  worktreeRoot: false
}))

vi.mock('./terminal-file-open-routing', () => ({
  getTerminalFileContext: () => ({}),
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
