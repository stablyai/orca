import { describe, expect, it, vi } from 'vitest'
import { wrapTerminalBracketedPasteText } from './terminal-bracketed-paste'
import { writeTerminalDropPathsToCapturedTarget } from './terminal-drop-path-writer'

function createTransport(
  sendInput: ReturnType<typeof vi.fn>,
  ptyId = 'pty-1',
  sendInputAccepted?: ReturnType<typeof vi.fn>
) {
  return {
    sendInput,
    ...(sendInputAccepted ? { sendInputAccepted } : {}),
    getPtyId: vi.fn(() => ptyId),
    isConnected: vi.fn(() => true)
  }
}

function createManager() {
  const pane = { id: 1, leafId: 'leaf-1' }
  return {
    pane,
    manager: {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
  }
}

describe('terminal drop path writer', () => {
  it('stops writing dropped paths when the PTY rejects a path', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => false)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    const result = await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/a.ts', '/repo/b.ts'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    expect(result).toEqual({
      sentAnyPath: false,
      targetCurrent: false,
      pathsWritten: 0,
      failureReason: 'write-rejected'
    })
    expect(sendInputAccepted).toHaveBeenCalledTimes(1)
    expect(sendInputAccepted).toHaveBeenCalledWith('/repo/a.ts ', 'driving', {
      signal: expect.any(AbortSignal)
    })
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('writes dropped image paths as a bracketed paste of the raw path', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    const result = await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/tmp/orca-paste-1-abc.png'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    expect(result).toEqual({ sentAnyPath: true, targetCurrent: true, pathsWritten: 1 })
    // Why: image attachment detection in terminal TUIs keys off bracketed paste
    // of the literal path — no shell-escaping, no trailing space.
    expect(sendInputAccepted).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('/tmp/orca-paste-1-abc.png'),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
  })

  it('pastes a spaced macOS screenshot name as a backslash-escaped path', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/tmp/drag/Screenshot 2026-09-28 at 4.03.11\u202fPM.png'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    // Why: pasted raw, Codex shlex-splits the ASCII spaces and keeps the path as text.
    expect(sendInputAccepted).toHaveBeenCalledTimes(1)
    expect(sendInputAccepted).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText(
        '/tmp/drag/Screenshot\\ 2026-09-28\\ at\\ 4.03.11\u202fPM.png'
      ),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
  })

  it('pastes a spaced Windows image name as a double-quoted path', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['C:\\Users\\me\\My Pictures\\shot.png'],
      targetShell: 'windows',
      inputShell: 'powershell'
    })

    expect(sendInputAccepted).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('"C:\\Users\\me\\My Pictures\\shot.png"'),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
  })

  it('keeps separating spaces around escaped spaced image pastes', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/Screenshot 1.png', '/repo/Screenshot 2.png', '/repo/a.ts'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      1,
      `${wrapTerminalBracketedPasteText('/repo/Screenshot\\ 1.png')} `,
      'driving',
      { signal: expect.any(AbortSignal) }
    )
    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      2,
      `${wrapTerminalBracketedPasteText('/repo/Screenshot\\ 2.png')} `,
      'driving',
      { signal: expect.any(AbortSignal) }
    )
    expect(sendInputAccepted).toHaveBeenNthCalledWith(3, '/repo/a.ts ', 'driving', {
      signal: expect.any(AbortSignal)
    })
  })

  it('keeps shell-escaped input for mixed image and non-image drops', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/a.ts', '/repo/shot.png'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    expect(sendInputAccepted).toHaveBeenNthCalledWith(1, '/repo/a.ts ', 'driving', {
      signal: expect.any(AbortSignal)
    })
    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      2,
      wrapTerminalBracketedPasteText('/repo/shot.png'),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
  })

  it('separates an image paste from a following non-image path', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/shot.png', '/repo/a.ts'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    // Why: the image paste carries no trailing space of its own, so a following
    // non-image path would collide with it without an explicit separator.
    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      1,
      `${wrapTerminalBracketedPasteText('/repo/shot.png')} `,
      'driving',
      { signal: expect.any(AbortSignal) }
    )
    expect(sendInputAccepted).toHaveBeenNthCalledWith(2, '/repo/a.ts ', 'driving', {
      signal: expect.any(AbortSignal)
    })
  })

  it('does not insert a separator between back-to-back image pastes', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/one.png', '/repo/two.png'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    // Why: bracketed pastes are self-delimiting; a stray space would land in the
    // TUI input between the two attachments.
    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      1,
      wrapTerminalBracketedPasteText('/repo/one.png'),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      2,
      wrapTerminalBracketedPasteText('/repo/two.png'),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
  })

  it('pastes a shell-escaped image path with POSIX shell metacharacters', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/a.png; touch /tmp/pwned #.png'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    // Why: the text stays escaped so a shell still gets one argument; the
    // paste frame is what lets agent TUIs attach the image.
    expect(sendInputAccepted).toHaveBeenCalledTimes(1)
    expect(sendInputAccepted).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('/repo/a.png\\;\\ touch\\ /tmp/pwned\\ \\#.png'),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
  })

  it('pastes an image filename with parentheses as a backslash-escaped path', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/.orca/drops/download (1).png'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    // Why: browser download names like `download (1).png` were written as
    // unframed keystrokes, so agent TUIs left the path as text.
    expect(sendInputAccepted).toHaveBeenCalledTimes(1)
    expect(sendInputAccepted).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('/repo/.orca/drops/download\\ \\(1\\).png'),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
  })

  it('keeps shell-escaped image pastes separate shell arguments from following images', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/download (1).png', "/repo/it's.png", '/repo/shot.png'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    // Why: a shell ignores paste boundaries, so without the space
    // `/repo/download\ \(1\).png/repo/it\'s.png` would be one argument.
    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      1,
      `${wrapTerminalBracketedPasteText('/repo/download\\ \\(1\\).png')} `,
      'driving',
      { signal: expect.any(AbortSignal) }
    )
    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      2,
      `${wrapTerminalBracketedPasteText("/repo/it\\'s.png")} `,
      'driving',
      { signal: expect.any(AbortSignal) }
    )
    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      3,
      wrapTerminalBracketedPasteText('/repo/shot.png'),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
  })

  it('separates a shell-escaped image paste from a following non-image path', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/download (1).png', '/repo/a.ts'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      1,
      `${wrapTerminalBracketedPasteText('/repo/download\\ \\(1\\).png')} `,
      'driving',
      { signal: expect.any(AbortSignal) }
    )
    expect(sendInputAccepted).toHaveBeenNthCalledWith(2, '/repo/a.ts ', 'driving', {
      signal: expect.any(AbortSignal)
    })
  })

  it('pastes a quoted image path with Windows shell metacharacters', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['C:\\Users\\me\\Pictures\\a&b.png'],
      targetShell: 'windows',
      inputShell: 'powershell'
    })

    expect(sendInputAccepted).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('"C:\\Users\\me\\Pictures\\a&b.png"'),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
  })

  it('separates an image paste from a following image path that must be shell escaped', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/shot.png', '/repo/a.png; touch /tmp/pwned #.png'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      1,
      `${wrapTerminalBracketedPasteText('/repo/shot.png')} `,
      'driving',
      { signal: expect.any(AbortSignal) }
    )
    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      2,
      wrapTerminalBracketedPasteText('/repo/a.png\\;\\ touch\\ /tmp/pwned\\ \\#.png'),
      'driving',
      { signal: expect.any(AbortSignal) }
    )
  })

  it.each([
    ['/repo/a\nb.png', 'an image'],
    ['/repo/a\u0015b.txt', 'a non-image']
  ])('refuses the whole drop when %j (%s path) contains control bytes', async (unsafePath) => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    const result = await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/safe.ts', unsafePath],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    // Why: typed, C-u would discard the open quote and LF would submit the line.
    expect(result).toEqual({
      sentAnyPath: false,
      targetCurrent: true,
      pathsWritten: 0,
      failureReason: 'control-character-path'
    })
    expect(sendInputAccepted).not.toHaveBeenCalled()
    expect(sendInput).not.toHaveBeenCalled()
  })

  it.each([
    ['powershell', "'C:\\Users\\me\\$(calc) a&b.txt' "],
    ['cmd', '"C:\\Users\\me\\$(calc) a&b.txt" '],
    ['posix', `'C:'"\\\\"'Users'"\\\\"'me'"\\\\"'$(calc) a&b.txt' `]
  ] as const)('types a Windows path quoted for a %s pane', async (inputShell, typed) => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['C:\\Users\\me\\$(calc) a&b.txt'],
      targetShell: 'windows',
      inputShell
    })

    expect(sendInputAccepted).toHaveBeenCalledWith(typed, 'driving', {
      signal: expect.any(AbortSignal)
    })
  })

  it('types a Windows image path a double-quoted paste would expand, after a separating space', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['C:\\t\\shot.png', 'C:\\t\\$(calc).png'],
      targetShell: 'windows',
      inputShell: 'powershell'
    })

    // Why: pasted as `"…$(calc)…"`, PowerShell would run calc once the user presses Enter.
    expect(sendInputAccepted).toHaveBeenNthCalledWith(
      1,
      `${wrapTerminalBracketedPasteText('C:\\t\\shot.png')} `,
      'driving',
      { signal: expect.any(AbortSignal) }
    )
    expect(sendInputAccepted).toHaveBeenNthCalledWith(2, "'C:\\t\\$(calc).png' ", 'driving', {
      signal: expect.any(AbortSignal)
    })
  })

  it('times out dropped path writes that never receive PTY acknowledgement', async () => {
    vi.useFakeTimers()
    try {
      const sendInput = vi.fn(() => true)
      const sendInputAccepted = vi.fn(() => new Promise<boolean>(() => {}))
      const { manager, pane } = createManager()
      const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

      const result = writeTerminalDropPathsToCapturedTarget({
        dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
        manager: manager as never,
        paneTransports: new Map([[pane.id, transport]]) as never,
        paths: ['/repo/a.ts'],
        targetShell: 'posix',
        inputShell: 'posix',
        operationTimeoutMs: 25
      })

      await vi.advanceTimersByTimeAsync(25)

      await expect(result).resolves.toEqual({
        sentAnyPath: false,
        targetCurrent: false,
        pathsWritten: 0,
        failureReason: 'operation-timeout'
      })
      expect(sendInputAccepted).toHaveBeenCalledTimes(1)
      expect(sendInput).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports partial writes when the captured target becomes stale between paths', async () => {
    const sendInput = vi.fn(() => true)
    let ptyId = 'pty-1'
    const sendInputAccepted = vi.fn(async () => {
      ptyId = 'pty-2'
      return true
    })
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)
    transport.getPtyId.mockImplementation(() => ptyId)

    const result = await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/a.ts', '/repo/b.ts'],
      targetShell: 'posix',
      inputShell: 'posix'
    })

    expect(result).toEqual({
      sentAnyPath: true,
      targetCurrent: false,
      pathsWritten: 1,
      failureReason: 'target-stale'
    })
    expect(sendInputAccepted).toHaveBeenCalledTimes(1)
  })
})
