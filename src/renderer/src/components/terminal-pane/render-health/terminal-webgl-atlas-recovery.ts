import { resetAndRefreshAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'

const ATLAS_RECOVERY_DELAYS_MS = [120, 500]

function scheduleNextFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(callback)
    return
  }
  globalThis.setTimeout(callback, 0)
}

function resetAtlasesAndRefreshPanes(reason: string): void {
  try {
    // Shared atlas reset requires repainting every rebuilt render model.
    resetAndRefreshAllTerminalWebglAtlases(reason)
  } catch {
    // Scheduled recovery may outlive the pane.
  }
}

function scheduleAtlasRecoveryBurst(reason: string): void {
  scheduleNextFrame(() => resetAtlasesAndRefreshPanes(reason))
  for (const delayMs of ATLAS_RECOVERY_DELAYS_MS) {
    globalThis.setTimeout(() => resetAtlasesAndRefreshPanes(reason), delayMs)
  }
}

export function scheduleImagePasteWebglAtlasRecovery(): void {
  // Image chips can repaint after paste parsing; cover that short window with bounded immediate atlas recovery.
  scheduleAtlasRecoveryBurst('image-paste')
}
