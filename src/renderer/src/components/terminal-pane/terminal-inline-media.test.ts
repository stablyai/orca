// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  findAnchorRow,
  inlineMediaKind,
  inlinePlayerBox,
  closeInlineMediaPlayers,
  localPathFromFileUrl,
  toggleInlineMedia
} from './terminal-inline-media'

describe('inlineMediaKind', () => {
  it('classifies video, audio and image files case-insensitively', () => {
    expect(inlineMediaKind('/tmp/clip.MP4')).toBe('video')
    expect(inlineMediaKind('/tmp/clip.mov')).toBe('video')
    expect(inlineMediaKind('/tmp/song.mp3')).toBe('audio')
    expect(inlineMediaKind('/tmp/take.wav')).toBe('audio')
    expect(inlineMediaKind('/tmp/frame.PNG')).toBe('image')
    expect(inlineMediaKind('C:\\renders\\poster.webp')).toBe('image')
  })

  it('leaves every other path to the usual link action', () => {
    expect(inlineMediaKind('/tmp/notes.md')).toBeNull()
    expect(inlineMediaKind('/tmp/report.pdf')).toBeNull()
    expect(inlineMediaKind('/tmp/Makefile')).toBeNull()
    expect(inlineMediaKind('/tmp/archive.mp4.zip')).toBeNull()
    expect(inlineMediaKind('/tmp/.mp4/readme')).toBeNull()
  })
})

describe('localPathFromFileUrl', () => {
  it('decodes local file URLs', () => {
    expect(localPathFromFileUrl('file:///Users/me/Downloads/my%20clip.mp4')).toBe(
      '/Users/me/Downloads/my clip.mp4'
    )
    expect(localPathFromFileUrl('file://localhost/tmp/a.mp3')).toBe('/tmp/a.mp3')
    expect(localPathFromFileUrl('file:///C:/Users/me/clip.mp4')).toBe('C:\\Users\\me\\clip.mp4')
  })

  it('refuses other hosts, other schemes and malformed text', () => {
    expect(localPathFromFileUrl('file://server/share/a.mp4')).toBeNull()
    expect(localPathFromFileUrl('https://example.com/a.mp4')).toBeNull()
    expect(localPathFromFileUrl('not a url')).toBeNull()
  })
})

describe('inlinePlayerBox', () => {
  const base = {
    rows: 60,
    cols: 120,
    cellWidth: 8,
    cellHeight: 16,
    aspect: 0
  } as const

  it('opens under the link when the rows below fit the player', () => {
    expect(inlinePlayerBox({ ...base, row: 5, kind: 'video' })).toEqual({
      top: 6 * 16,
      height: 20 * 16,
      width: 72 * 8
    })
  })

  it('flips above the link when it sits just over the prompt', () => {
    const box = inlinePlayerBox({ ...base, row: 55, kind: 'video' })
    expect(box).toEqual({ top: 35 * 16, height: 20 * 16, width: 72 * 8 })
  })

  it('shrinks to the room left when neither side fits the whole player', () => {
    const box = inlinePlayerBox({ ...base, rows: 12, row: 4, kind: 'video' })
    expect(box?.height).toBe(7 * 16)
    expect(box?.top).toBe(5 * 16)
  })

  it('gives up when there are not two rows on either side', () => {
    expect(inlinePlayerBox({ ...base, rows: 3, row: 1, kind: 'audio' })).toBeNull()
  })

  it('narrows to a vertical clip and never past the terminal', () => {
    const vertical = inlinePlayerBox({
      ...base,
      cellHeight: 32,
      row: 5,
      kind: 'video',
      aspect: 9 / 16
    })
    expect(vertical?.width).toBeCloseTo(((20 * 32 - 22) * 9) / 16)
    const tiny = inlinePlayerBox({
      ...base,
      row: 5,
      kind: 'video',
      aspect: 9 / 16
    })
    expect(tiny?.width).toBe(240)
    const narrowTerminal = inlinePlayerBox({
      ...base,
      cols: 30,
      row: 5,
      kind: 'video'
    })
    expect(narrowTerminal?.width).toBe(28 * 8)
  })
})

describe('findAnchorRow', () => {
  const screen = ['a', 'link', 'b', 'link', 'c']

  it('returns the copy nearest to where the player was', () => {
    expect(findAnchorRow((row) => screen[row] ?? '', 5, 'link', 3)).toBe(3)
    expect(findAnchorRow((row) => screen[row] ?? '', 5, 'link', 0)).toBe(1)
  })

  it('reports -1 once the line has scrolled off screen', () => {
    expect(findAnchorRow((row) => screen[row] ?? '', 5, 'gone', 2)).toBe(-1)
  })
})

describe('toggleInlineMedia', () => {
  type Listener = () => void
  let renderListeners: Listener[]

  function fakeTerminal(lines: string[]): Terminal {
    const element = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    element.append(screen)
    document.body.append(element)
    const subscribe = (listener: Listener): { dispose: () => void } => {
      renderListeners.push(listener)
      return {
        dispose: () => {
          renderListeners = renderListeners.filter((candidate) => candidate !== listener)
        }
      }
    }
    return {
      element,
      rows: lines.length,
      cols: 80,
      buffer: {
        active: {
          viewportY: 0,
          getLine: (line: number) =>
            line < lines.length ? { translateToString: () => lines[line] } : undefined
        }
      },
      onRender: subscribe,
      onResize: subscribe,
      onScroll: subscribe
    } as unknown as Terminal
  }

  beforeEach(() => {
    renderListeners = []
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        api: {
          fs: {
            readFile: vi.fn(async () => ({
              content: '',
              isBinary: true,
              mediaUrl: 'orca-media://file/t'
            }))
          }
        }
      })
    )
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('opens one player under the link and closes it on a second click', () => {
    const lines = ['intro', 'clip: /tmp/clip.mp4', ...Array.from({ length: 30 }, () => '')]
    const terminal = fakeTerminal(lines)

    expect(toggleInlineMedia(terminal, 1, '/tmp/clip.mp4', 'video')).toBe(true)
    expect(document.querySelectorAll('[data-orca-inline-media="video"]')).toHaveLength(1)
    expect(renderListeners).toHaveLength(3)

    expect(toggleInlineMedia(terminal, 1, '/tmp/clip.mp4', 'video')).toBe(true)
    expect(document.querySelectorAll('[data-orca-inline-media]')).toHaveLength(0)
    expect(renderListeners).toHaveLength(0)
  })

  it('asks main for the file under the user-file grant', () => {
    const terminal = fakeTerminal(['/tmp/song.mp3', '', '', '', ''])
    toggleInlineMedia(terminal, 0, '/tmp/song.mp3', 'audio')
    expect(window.api.fs.readFile).toHaveBeenCalledWith({
      filePath: '/tmp/song.mp3',
      access: { kind: 'user-file' }
    })
  })

  it('pauses a player whose link line is gone, so no hidden sound keeps playing', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const lines = ['/tmp/song.mp3', '', '', '', '']
    const terminal = fakeTerminal(lines)
    toggleInlineMedia(terminal, 0, '/tmp/song.mp3', 'audio')
    await vi.waitFor(() => expect(document.querySelector('audio')).not.toBeNull())

    lines[0] = 'cleared'
    for (const listener of renderListeners) {
      listener()
    }

    const player = document.querySelector<HTMLElement>('[data-orca-inline-media]')
    expect(player?.style.display).toBe('none')
    expect(pause).toHaveBeenCalled()
    pause.mockRestore()
  })

  it('does not autoplay media that finishes loading after its player was hidden', async () => {
    let finishRead: (value: unknown) => void = () => {}
    vi.mocked(window.api.fs.readFile).mockImplementationOnce(
      () => new Promise((resolve) => (finishRead = resolve)) as never
    )
    const lines = ['/tmp/clip.mp4', ...Array.from({ length: 30 }, () => '')]
    const terminal = fakeTerminal(lines)
    toggleInlineMedia(terminal, 0, '/tmp/clip.mp4', 'video')

    lines[0] = 'cleared'
    for (const listener of renderListeners) {
      listener()
    }
    finishRead({ content: '', isBinary: true, mediaUrl: 'orca-media://file/t' })

    await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull())
    expect(document.querySelector('video')?.autoplay).toBe(false)
  })

  it('closes every player when its pane goes away', () => {
    const terminal = fakeTerminal([
      '/tmp/a.mp4',
      '/tmp/b.png',
      ...Array.from({ length: 30 }, () => '')
    ])
    toggleInlineMedia(terminal, 0, '/tmp/a.mp4', 'video')
    toggleInlineMedia(terminal, 1, '/tmp/b.png', 'image')
    expect(document.querySelectorAll('[data-orca-inline-media]')).toHaveLength(2)

    closeInlineMediaPlayers(terminal)

    expect(document.querySelectorAll('[data-orca-inline-media]')).toHaveLength(0)
    expect(renderListeners).toHaveLength(0)
  })

  it('declines a blank line so the link keeps its usual action', () => {
    const terminal = fakeTerminal(['', '', ''])
    expect(toggleInlineMedia(terminal, 0, '/tmp/clip.mp4', 'video')).toBe(false)
    expect(document.querySelectorAll('[data-orca-inline-media]')).toHaveLength(0)
  })
})
