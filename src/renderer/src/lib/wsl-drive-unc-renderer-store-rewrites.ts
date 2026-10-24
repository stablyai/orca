/**
 * The renderer's stores of a UNC Windows-drive conversion (D1c): a converted workspace's quick-open
 * history, CSV and PDF view preferences and notebook interpreter choices gain a copy under its drive
 * path, as the WSL move's renderer rewrite does for a host (wsl-move-renderer-store-rewrites.ts).
 * Storage flushes lazily, so each startup re-applies a store unless this window's marker says it
 * landed; the marker is written only after the store's own write.
 */
import {
  convertedCsvColumnWidthsKey,
  convertedFileViewPreferenceKey,
  convertedNotebookEnvironment,
  convertedQuickOpenHistoryScope,
  WSL_DRIVE_UNC_RENDERER_STORE_IDS,
  wslDriveUncRendererKeys,
  type WslDriveUncPendingRendererRewrite,
  type WslDriveUncRendererKeys
} from '../../../shared/wsl-drive-unc-renderer-store-keys'

const APPLIED_STORAGE_KEY = 'orca.wsl-drive-unc.renderer-rewrites.v1'
const MAX_APPLIED_MARKERS = 256

type StoreId = (typeof WSL_DRIVE_UNC_RENDERER_STORE_IDS)[number]

// Loaded only when a conversion is pending, so a profile without one never pays for these modules.
const STORE_REWRITES: Record<StoreId, (keys: WslDriveUncRendererKeys) => Promise<void>> = {
  'quick-open-history': async (keys) => {
    const { copyQuickOpenHistoryScopes } = await import('./quick-open-file-history')
    copyQuickOpenHistoryScopes((scope) => convertedQuickOpenHistoryScope(scope, keys))
  },
  'file-view-preferences': async (keys) => {
    const [{ copyFileViewPreferences }, { PDF_SCALE_PREFERENCES_STORAGE_KEY }, csv] =
      await Promise.all([
        import('../components/editor/file-view-preference-storage'),
        import('../components/editor/pdf-scale-preference-storage'),
        import('../components/editor/csv/csv-column-width-preferences')
      ])
    copyFileViewPreferences(PDF_SCALE_PREFERENCES_STORAGE_KEY, (key) =>
      convertedFileViewPreferenceKey(key, keys)
    )
    copyFileViewPreferences(csv.CSV_COLUMN_WIDTHS_STORAGE_KEY, (key) =>
      convertedCsvColumnWidthsKey(key, keys)
    )
  },
  'notebook-environments': async (keys) => {
    const { copyEnvironments } = await import('../components/editor/ipynb-kernel-store')
    copyEnvironments((filePath, environment) =>
      convertedNotebookEnvironment(filePath, environment, keys)
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

async function rewriteConversion(conversion: WslDriveUncPendingRendererRewrite): Promise<void> {
  const keys = wslDriveUncRendererKeys(conversion)
  for (const storeId of WSL_DRIVE_UNC_RENDERER_STORE_IDS) {
    const marker = `${conversion.migrationId}:${storeId}`
    try {
      if (!readAppliedMarkers().includes(marker)) {
        await STORE_REWRITES[storeId](keys)
        writeAppliedMarker(marker)
      }
      if (conversion.storeIds.includes(storeId)) {
        await window.api.wslDriveUnc.recordStoreRewritten({
          migrationId: conversion.migrationId,
          storeId
        })
      }
    } catch (error) {
      // No marker and no ledger entry: the next startup tries this store again.
      console.warn(`[wsl-drive-unc] Renderer store ${storeId} paused:`, error)
    }
  }
}

/** Never throws. */
export async function runWslDriveUncRendererStoreRewrites(): Promise<void> {
  try {
    const conversions = await window.api.wslDriveUnc.listPendingRendererRewrites()
    for (const conversion of conversions) {
      await rewriteConversion(conversion)
    }
  } catch (error) {
    console.warn('[wsl-drive-unc] Could not list renderer stores to convert:', error)
  }
}
