import type { Terminal } from '@xterm/xterm'
import { MEDIA_FILE_MIME_TYPES } from '../../../../shared/media-file-extensions'
import { translate } from '@/i18n/i18n'
import { userNamedFileAccess } from '@/lib/local-file-access'

export type InlineMediaKind = 'video' | 'audio' | 'image'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
// Rows the player asks for under its link; an audio bar needs only its controls.
const WANTED_ROWS: Record<InlineMediaKind, number> = {
  video: 20,
  audio: 3,
  image: 20
}
const MAX_COLUMNS = 72
const MIN_WIDTH_PX = 240
const TITLE_BAR_PX = 22

type OpenPlayer = { key: string; close: () => void }
const openPlayers = new WeakMap<Terminal, OpenPlayer[]>()

/** The lower-cased extension of the path's last segment, dot included, or '' when it has none. */
function extensionOf(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/** What an inline player would show for this path, or null when it is not a playable file. */
export function inlineMediaKind(filePath: string): InlineMediaKind | null {
  const extension = extensionOf(filePath)
  const mimeType = MEDIA_FILE_MIME_TYPES[extension]
  if (mimeType) {
    return mimeType.startsWith('audio/') ? 'audio' : 'video'
  }
  return IMAGE_EXTENSIONS.has(extension) ? 'image' : null
}

/** The local path of a `file://` hyperlink (OSC 8, as agents print markdown links), or null. */
export function localPathFromFileUrl(text: string): string | null {
  try {
    const url = new URL(text)
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) {
      return null
    }
    const path = decodeURIComponent(url.pathname)
    // Why: `file:///C:/x.mp4` parses to `/C:/x.mp4`; Windows needs the drive path without the slash.
    return /^\/[A-Za-z]:[/\\]/.test(path) ? path.slice(1).replaceAll('/', '\\') : path
  } catch {
    return null
  }
}

export type InlinePlayerBox = { top: number; height: number; width: number }

/**
 * Where the player sits, in cells and pixels, for an anchor line at `row` of a `rows`-high
 * viewport, or null when there is no room. It opens under the link and flips above it when the
 * rows below run short, so a link printed just over an agent's prompt does not cover the prompt.
 */
export function inlinePlayerBox(input: {
  row: number
  rows: number
  cols: number
  cellWidth: number
  cellHeight: number
  kind: InlineMediaKind
  aspect: number
}): InlinePlayerBox | null {
  const { row, rows, cols, cellWidth, cellHeight, kind, aspect } = input
  const below = rows - row - 1
  const above = row
  const wanted = WANTED_ROWS[kind]
  const upward = below < wanted && above > below
  const height = Math.min(wanted, upward ? above : below)
  if (height < 2) {
    return null
  }
  const maxWidth = Math.min(cols - 2, MAX_COLUMNS) * cellWidth
  const pixelsHigh = height * cellHeight
  // Why from the media's own shape: a vertical clip in a wide box is mostly black bars.
  const width =
    aspect > 0
      ? Math.min(maxWidth, Math.max(MIN_WIDTH_PX, (pixelsHigh - TITLE_BAR_PX) * aspect))
      : maxWidth
  return {
    top: (upward ? row - height : row + 1) * cellHeight,
    height: pixelsHigh,
    width
  }
}

/**
 * The viewport row showing `anchor` nearest to `lastRow`, or -1. Why nearest: the same text can
 * repeat on screen, and the player stays with the copy it was opened on.
 */
export function findAnchorRow(
  rowText: (row: number) => string,
  rows: number,
  anchor: string,
  lastRow: number
): number {
  for (let offset = 0; offset < rows; offset += 1) {
    for (const candidate of [lastRow - offset, lastRow + offset]) {
      if (candidate >= 0 && candidate < rows && rowText(candidate) === anchor) {
        return candidate
      }
    }
  }
  return -1
}

/**
 * The `src` a player element loads: the `orca-media://` URL main grants for video and audio, or a
 * data URL for an image.
 */
async function mediaSource(filePath: string, kind: InlineMediaKind): Promise<string> {
  // Why the user-file grant: the click is the user naming this file, so it may live outside any
  // project (an agent's render in ~/Downloads). Main still serves only that one regular file.
  const read = (await window.api.fs.readFile({
    filePath,
    access: userNamedFileAccess()
  })) as {
    content: string
    mimeType?: string
    mediaUrl?: string
  }
  if (kind === 'image') {
    return `data:${read.mimeType ?? 'image/png'};base64,${read.content}`
  }
  if (!read.mediaUrl) {
    throw new Error('no media url')
  }
  return read.mediaUrl
}

/**
 * Builds the player inside `element`: a title bar with a close button, then the media, loaded
 * asynchronously. Reports the media's aspect ratio once known so the box can narrow to it.
 */
function mountPlayer(
  element: HTMLElement,
  filePath: string,
  kind: InlineMediaKind,
  close: () => void,
  onAspect: (ratio: number) => void
): void {
  element.dataset.orcaInlineMedia = kind
  element.className =
    'absolute z-10 flex flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md'
  // Why stop here: a press inside the player must not start a terminal selection or refocus xterm.
  for (const type of ['mousedown', 'mouseup', 'click', 'wheel', 'contextmenu']) {
    element.addEventListener(type, (event) => event.stopPropagation())
  }

  const bar = document.createElement('div')
  bar.className = 'flex shrink-0 items-center gap-2 px-2 text-xs text-muted-foreground'
  bar.style.height = `${TITLE_BAR_PX}px`
  const title = document.createElement('span')
  title.className = 'min-w-0 flex-1 truncate'
  title.textContent = filePath.split(/[/\\]/).pop() ?? filePath
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'cursor-pointer rounded px-1 hover:text-foreground'
  closeButton.textContent = '✕'
  closeButton.setAttribute(
    'aria-label',
    translate('mediaPreview.closeInlinePlayer', 'Close player')
  )
  closeButton.addEventListener('click', close)
  bar.append(title, closeButton)

  const body = document.createElement('div')
  // Why an explicit height: flex growth alone let a tall video push the body past the box.
  body.className = 'flex items-center justify-center overflow-hidden bg-black'
  body.style.height = `calc(100% - ${TITLE_BAR_PX}px)`
  element.append(bar, body)

  // Why fill + contain: a vertical clip must fit whole in the box, never be cropped.
  const fit = 'block h-full w-full object-contain'
  void mediaSource(filePath, kind)
    .then((src) => {
      if (!element.isConnected) {
        return
      }
      if (kind === 'image') {
        const image = document.createElement('img')
        image.className = fit
        image.alt = title.textContent ?? ''
        image.addEventListener('load', () => onAspect(image.naturalWidth / image.naturalHeight))
        image.src = src
        body.append(image)
        return
      }
      const media = document.createElement(kind === 'audio' ? 'audio' : 'video')
      media.className = kind === 'audio' ? 'w-full' : fit
      media.controls = true
      // Why check now: the read is async, and the anchor may have gone while it ran; a player
      // already hidden must not start playing out of sight.
      media.autoplay = element.style.display !== 'none'
      media.preload = 'metadata'
      if (media instanceof HTMLVideoElement) {
        media.addEventListener('loadedmetadata', () => {
          if (media.videoWidth && media.videoHeight) {
            onAspect(media.videoWidth / media.videoHeight)
          }
        })
      }
      media.src = src
      body.append(media)
    })
    .catch(() => {
      body.className = 'flex items-center justify-center p-2 text-xs text-muted-foreground'
      body.textContent = translate(
        'mediaPreview.unavailable',
        'Unable to play this media file. The file may be unavailable or use an unsupported codec.'
      )
    })
}

/** The trimmed text of one buffer line, the player's anchor. */
function lineText(terminal: Terminal, line: number): string {
  return terminal.buffer.active.getLine(line)?.translateToString(true).trim() ?? ''
}

/**
 * Opens a player for a media file just under the terminal line that printed its link, or closes the
 * one already open there. Returns false when the player cannot be placed, so the caller falls back
 * to the link's usual action.
 *
 * Why an overlay that follows the line's text, not an xterm decoration: agents such as Claude Code
 * draw in the alternate screen, where xterm hides every decoration, and they redraw their own
 * scrolling there, so no marker follows the line. After each render the player finds its anchor
 * line again by its text, and hides while that line is off screen.
 */
export function toggleInlineMedia(
  terminal: Terminal,
  bufferLine: number,
  filePath: string,
  kind: InlineMediaKind
): boolean {
  const anchor = lineText(terminal, bufferLine)
  const key = `${anchor}\u0000${filePath}`
  const players = openPlayers.get(terminal) ?? []
  const existing = players.find((player) => player.key === key)
  if (existing) {
    existing.close()
    return true
  }
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!anchor || !screen) {
    return false
  }

  const element = document.createElement('div')
  let lastRow = bufferLine - terminal.buffer.active.viewportY
  let aspect = 0

  /** Re-finds the anchor line and moves the player under or above it; hides and pauses it when gone. */
  const place = (): void => {
    const viewportY = terminal.buffer.active.viewportY
    const row = findAnchorRow(
      (candidate) => lineText(terminal, viewportY + candidate),
      terminal.rows,
      anchor,
      lastRow
    )
    const box =
      row === -1
        ? null
        : inlinePlayerBox({
            row,
            rows: terminal.rows,
            cols: terminal.cols,
            cellWidth: screen.clientWidth / terminal.cols,
            cellHeight: screen.clientHeight / terminal.rows,
            kind,
            aspect
          })
    if (!box) {
      // Why pause: a hidden player (anchor cleared or scrolled away) must not keep playing sound.
      element.style.display = 'none'
      element.querySelector<HTMLMediaElement>('video, audio')?.pause()
      return
    }
    lastRow = row
    element.style.display = ''
    element.style.left = `${screen.clientWidth / terminal.cols}px`
    element.style.top = `${box.top}px`
    element.style.width = `${box.width}px`
    element.style.height = `${box.height}px`
  }

  const subscriptions = [
    terminal.onRender(place),
    terminal.onResize(place),
    terminal.onScroll(place)
  ]
  const player: OpenPlayer = {
    key,
    /** Stops the media, releases its decoder, removes the player and its listeners. */
    close: () => {
      for (const subscription of subscriptions) {
        subscription.dispose()
      }
      // Why release the source: a detached element keeps its media decoder until src is cleared.
      const media = element.querySelector<HTMLMediaElement>('video, audio')
      if (media) {
        media.pause()
        media.removeAttribute('src')
        media.load()
      }
      element.remove()
      openPlayers.set(
        terminal,
        (openPlayers.get(terminal) ?? []).filter((candidate) => candidate !== player)
      )
    }
  }
  mountPlayer(element, filePath, kind, player.close, (ratio) => {
    aspect = ratio
    place()
  })
  screen.appendChild(element)
  place()
  openPlayers.set(terminal, [...players, player])
  return true
}

/**
 * Closes every player open in this terminal. Called when its pane goes away, so no audio keeps
 * playing and no render listener outlives the pane.
 */
export function closeInlineMediaPlayers(terminal: Terminal): void {
  for (const player of openPlayers.get(terminal) ?? []) {
    player.close()
  }
  openPlayers.delete(terminal)
}
