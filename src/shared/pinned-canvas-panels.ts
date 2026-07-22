import type { PinnedCanvasPanel } from './types'

// Why a bound: each board carries a tldraw snapshot on disk and a bound omp
// agent with its own session dir, so an unbounded list is real disk and real
// processes, not just sidebar rows. Lower than the web-panel cap for that
// reason.
export const MAX_PINNED_CANVAS_PANELS = 8

const MAX_PANEL_TITLE_LENGTH = 60

/** Board ids key a snapshot filename and an omp `--session-dir`, so they are
 *  sanitized to the same conservative alphabet the pet uses for its session
 *  dirs (`petSessionDirName`) — anything else could escape the state dir. */
const BOARD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

function normalizeBoardId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return BOARD_ID_PATTERN.test(trimmed) ? trimmed : null
}

/** Drops malformed entries instead of failing the whole settings write, so one
 *  bad board (hand-edited profile, older build) can't wedge the rest —
 *  same contract as `normalizePinnedWebPanels`. */
export function normalizePinnedCanvasPanels(value: unknown): PinnedCanvasPanel[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seenIds = new Set<string>()
  const seenBoardIds = new Set<string>()
  const panels: PinnedCanvasPanel[] = []
  for (const entry of value) {
    if (panels.length >= MAX_PINNED_CANVAS_PANELS) {
      break
    }
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const { id, title, boardId, groupId, order } = entry as Record<string, unknown>
    const normalizedBoardId = normalizeBoardId(boardId)
    if (typeof id !== 'string' || id.length === 0 || seenIds.has(id)) {
      continue
    }
    // Why boardId uniqueness matters more than id uniqueness: two entries
    // sharing a boardId would drive one snapshot and one omp session from two
    // sidebar rows, and the second writer would clobber the first.
    if (normalizedBoardId === null || seenBoardIds.has(normalizedBoardId)) {
      continue
    }
    const trimmedTitle =
      typeof title === 'string' ? title.trim().slice(0, MAX_PANEL_TITLE_LENGTH) : ''
    const trimmedGroupId =
      typeof groupId === 'string' && groupId.trim().length > 0 ? groupId.trim() : ''
    const orderNum =
      typeof order === 'number' && Number.isFinite(order) ? Math.trunc(order) : undefined
    seenIds.add(id)
    seenBoardIds.add(normalizedBoardId)
    panels.push({
      id,
      // Why: an empty title renders an unclickable-looking blank row; the
      // board id is the only other thing that identifies the entry.
      title: trimmedTitle.length > 0 ? trimmedTitle : normalizedBoardId,
      boardId: normalizedBoardId,
      ...(trimmedGroupId.length > 0 ? { groupId: trimmedGroupId } : {}),
      ...(orderNum !== undefined ? { order: orderNum } : {})
    })
  }
  return panels
}
