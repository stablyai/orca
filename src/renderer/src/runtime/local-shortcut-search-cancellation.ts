import type { ShortcutStory, ShortcutWorkspaceSelection } from '../../../shared/shortcut-types'
import { createBrowserUuid } from '@/lib/browser-uuid'

type LocalShortcutSearchArgs = {
  query: string
  limit?: number
  workspaceId?: ShortcutWorkspaceSelection
}

function createShortcutSearchAbortError(): Error {
  const error = new Error('Shortcut search aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Run a local Shortcut search that the main process can cancel.
 *
 * Without the cancel round-trip a superseded keystroke keeps its slot in the shared Shortcut
 * request pool until the abandoned query drains, which is what stalls the next search.
 */
export async function searchLocalShortcutStories(
  args: LocalShortcutSearchArgs,
  signal: AbortSignal
): Promise<ShortcutStory[]> {
  if (signal.aborted) {
    throw createShortcutSearchAbortError()
  }
  const requestId = createBrowserUuid()
  const handleAbort = (): void => {
    void window.api.shortcut.cancelSearchStories({ requestId }).catch(() => {})
  }
  signal.addEventListener('abort', handleAbort, { once: true })
  try {
    const stories = await window.api.shortcut.searchStories({ ...args, requestId })
    // Why: cancel can race ahead of main-process registration; drop late successes.
    if (signal.aborted) {
      throw createShortcutSearchAbortError()
    }
    return stories
  } finally {
    signal.removeEventListener('abort', handleAbort)
  }
}
