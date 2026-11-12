// The full-page "Set up Orca Cloud" view (composer-redo): Start in the composer closes the dialog
// and opens this page when the account isn't ready yet. The page walks the missing steps, then
// starts the saved prompt. One request at a time; a new Start replaces an older one.
import { useSyncExternalStore } from 'react'
import type { OrcaCloudAvailability } from '../../../../shared/orca-yaml-hook-types'
import type { ComposerModalData } from '@/components/new-workspace/composer-modal-data'
import type { OrcaCloudRunTargetAccess } from '@/components/new-workspace/orca-cloud-run-target-access'
import { e2eConfig } from '@/app-shell/startup/e2e-config'
import { cancelCloudCreateIntent } from './cloud-create-intent'

export type CloudSetupPageRequest = {
  prompt: string
  repoId: string
  agent: string | null
  /** What main reported when Start was pressed; the page upgrades it once sign-in lands. */
  availability: OrcaCloudAvailability
  /** D4: a GitHub repository with no clone here; the start goes through the composer visibly. */
  cloudOnlyRepo: string | null
  /** The composer as it was: Back and the auto-start reopen it with everything kept. */
  composer: ComposerModalData
  /** The Create press this setup belongs to: its start uses it once; Exit and Back cancel it. */
  intentId: string
  /**
   * Dev and e2e only: pins the account's billing answer so every step can be walked against the
   * real page (dev sign-in has no billing). Never set by the app.
   */
  debugAccess?: OrcaCloudRunTargetAccess
  openedAt: number
}

let current: CloudSetupPageRequest | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function openCloudSetupPage(request: Omit<CloudSetupPageRequest, 'openedAt'>): void {
  // A newer Start replaces an older setup: the older press can never create.
  if (current && current.intentId !== request.intentId) {
    cancelCloudCreateIntent(current.intentId)
  }
  current = { ...request, openedAt: Date.now() }
  emit()
}

export function closeCloudSetupPage(): void {
  if (current === null) {
    return
  }
  current = null
  emit()
}

export function getCloudSetupPageRequest(): CloudSetupPageRequest | null {
  return current
}

export function useCloudSetupPageRequest(): CloudSetupPageRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current
  )
}

// Dev and e2e: drive the page from the console or CDP (as `__store` is), e.g. to walk the trial step.
if ((import.meta.env.DEV || e2eConfig.exposeStore) && typeof window !== 'undefined') {
  Object.assign(window, {
    __cloudSetupPage: {
      open: openCloudSetupPage,
      close: closeCloudSetupPage,
      get: getCloudSetupPageRequest
    }
  })
}
