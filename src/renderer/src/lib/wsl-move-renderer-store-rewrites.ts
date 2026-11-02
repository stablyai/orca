/**
 * The renderer's stores of a committed WSL move: a moved workspace's quick-open history,
 * CSV and PDF view preferences and notebook interpreter choices gain a copy keyed for the WSL host,
 * beside the local entry a downgrade still reads. Native chats stay local (owner decision C).
 *
 * Storage here flushes lazily and main's flush before a ledger entry is only a request, so every
 * startup re-applies each store for every committed move unless this window's applied-marker says
 * it landed. The marker is written only after the store's own write succeeded, in the same storage
 * area, so a lost flush loses both and the store runs again.
 */
import {
  WSL_MOVE_RENDERER_REWRITE_STORE_IDS,
  type WslMovePendingRendererRewrite,
  type WslMoveRendererRewriteStoreId
} from '../../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import {
  wslMoveRendererRewriteScope,
  type WslMoveRendererRewriteScope
} from '../../../shared/wsl-move/wsl-move-renderer-rewrite-scope'
import {
  listPendingWslMoveRendererRewrites,
  recordWslMoveRendererStoreRewritten
} from './wsl-move-renderer-rewrite-client'
import {
  hostCsvColumnWidthsKey,
  hostFileViewPreferenceKey,
  hostNotebookEnvironment,
  hostQuickOpenHistoryScope
} from './wsl-move-renderer-store-keys'

const APPLIED_STORAGE_KEY = 'orca.wsl-move.renderer-rewrites.v1'
const MAX_APPLIED_MARKERS = 2_048

// Loaded only when a move exists, so a profile without one never pays for these modules.
const STORE_REWRITES: Record<
  WslMoveRendererRewriteStoreId,
  (scope: WslMoveRendererRewriteScope) => Promise<void>
> = {
  'quick-open-history': async (scope) => {
    const { copyQuickOpenHistoryScopes } = await import('./quick-open-file-history')
    copyQuickOpenHistoryScopes((key) => hostQuickOpenHistoryScope(key, scope))
  },
  'file-view-preferences': async (scope) => {
    const [{ copyFileViewPreferences }, { PDF_SCALE_PREFERENCES_STORAGE_KEY }, csv] =
      await Promise.all([
        import('../components/editor/file-view-preference-storage'),
        import('../components/editor/pdf-scale-preference-storage'),
        import('../components/editor/csv/csv-column-width-preferences')
      ])
    copyFileViewPreferences(PDF_SCALE_PREFERENCES_STORAGE_KEY, (key) =>
      hostFileViewPreferenceKey(key, scope)
    )
    copyFileViewPreferences(csv.CSV_COLUMN_WIDTHS_STORAGE_KEY, (key) =>
      hostCsvColumnWidthsKey(key, scope)
    )
  },
  'notebook-environments': async (scope) => {
    const { copyEnvironments } = await import('../components/editor/ipynb-kernel-store')
    copyEnvironments((filePath, environment) =>
      hostNotebookEnvironment(filePath, environment, scope)
    )
  }
}

function readAppliedMarkers(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(APPLIED_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

function writeAppliedMarker(marker: string): void {
  const markers = [...readAppliedMarkers().filter((entry) => entry !== marker), marker]
  try {
    localStorage.setItem(APPLIED_STORAGE_KEY, JSON.stringify(markers.slice(-MAX_APPLIED_MARKERS)))
  } catch {
    // Unavailable storage: the next startup re-applies, which only re-finds its copies.
  }
}

// Main's refusals a later call can clear. Another window (`not-main-window`) never becomes the main
// one, and the rest mean the store is no longer pending.
const RETRYABLE_RECORD_REASONS: ReadonlySet<string> = new Set(['gated-off', 'failed'])

/** True when a store's ledger entry still has to land: the move stays unfinished until it does. */
async function rewriteMove(move: WslMovePendingRendererRewrite): Promise<boolean> {
  const scope = wslMoveRendererRewriteScope(move)
  let unrecorded = false
  for (const storeId of WSL_MOVE_RENDERER_REWRITE_STORE_IDS) {
    const marker = `${move.migrationId}:${storeId}`
    try {
      if (!readAppliedMarkers().includes(marker)) {
        await STORE_REWRITES[storeId](scope)
        writeAppliedMarker(marker)
      }
      if (move.storeIds.includes(storeId)) {
        const result = await recordWslMoveRendererStoreRewritten(move.migrationId, storeId)
        if (!result.recorded && RETRYABLE_RECORD_REASONS.has(result.reason)) {
          // A refused record left the move stuck until the next app start.
          console.warn(`[wsl-move] Renderer rewrite ${storeId} not recorded: ${result.reason}`)
          unrecorded = true
        }
      }
    } catch (error) {
      // No marker and no ledger entry: the next startup tries this store again.
      console.warn(`[wsl-move] Renderer rewrite ${storeId} of ${move.migrationId} paused:`, error)
      unrecorded = true
    }
  }
  return unrecorded
}

let inFlight: Promise<void> | null = null
// Backoff for a pass that left a store unrecorded; past the last, the next startup tries again.
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]
let retryTimer: ReturnType<typeof setTimeout> | null = null

/** Never throws; a second call while one runs joins it, so no store is applied twice at once. */
export function runWslMoveRendererStoreRewrites(attempt = 0): Promise<void> {
  inFlight ??= rewritePendingMoves()
    .then((unrecorded) => {
      const delay = RETRY_DELAYS_MS[attempt]
      if (unrecorded && delay !== undefined && retryTimer === null) {
        retryTimer = setTimeout(() => {
          retryTimer = null
          void runWslMoveRendererStoreRewrites(attempt + 1)
        }, delay)
      }
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

async function rewritePendingMoves(): Promise<boolean> {
  let unrecorded = false
  try {
    const moves = await listPendingWslMoveRendererRewrites()
    for (const move of moves) {
      unrecorded = (await rewriteMove(move)) || unrecorded
    }
  } catch (error) {
    // Transient (main not ready yet); the backoff bounds a bridge that never answers.
    console.warn('[wsl-move] Could not list renderer rewrites:', error)
    unrecorded = true
  }
  return unrecorded
}
