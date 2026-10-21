/**
 * The renderer's stores of a committed WSL move (D1b-7d): a moved workspace's quick-open history,
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

async function rewriteMove(move: WslMovePendingRendererRewrite): Promise<void> {
  const scope = wslMoveRendererRewriteScope(move)
  for (const storeId of WSL_MOVE_RENDERER_REWRITE_STORE_IDS) {
    const marker = `${move.migrationId}:${storeId}`
    try {
      if (!readAppliedMarkers().includes(marker)) {
        await STORE_REWRITES[storeId](scope)
        writeAppliedMarker(marker)
      }
      if (move.storeIds.includes(storeId)) {
        await recordWslMoveRendererStoreRewritten(move.migrationId, storeId)
      }
    } catch (error) {
      // No marker and no ledger entry: the next startup tries this store again.
      console.warn(`[wsl-move] Renderer rewrite ${storeId} of ${move.migrationId} paused:`, error)
    }
  }
}

let inFlight: Promise<void> | null = null

/** Never throws; a second call while one runs joins it, so no store is applied twice at once. */
export function runWslMoveRendererStoreRewrites(): Promise<void> {
  inFlight ??= rewritePendingMoves().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function rewritePendingMoves(): Promise<void> {
  try {
    const moves = await listPendingWslMoveRendererRewrites()
    for (const move of moves) {
      await rewriteMove(move)
    }
  } catch (error) {
    console.warn('[wsl-move] Could not list renderer rewrites:', error)
  }
}
