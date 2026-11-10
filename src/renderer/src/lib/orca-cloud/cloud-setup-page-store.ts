// The full-page "Set up Orca Cloud" view (composer-redo): Start in the composer closes the dialog
// and opens this page when the account isn't ready yet. The page walks the missing steps, then
// starts the saved prompt. One request at a time; a new Start replaces an older one.
import { useSyncExternalStore } from 'react'
import type { OrcaCloudAvailability } from '../../../../shared/orca-yaml-hook-types'
import type { ComposerModalData } from '@/components/new-workspace/composer-modal-data'

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

const AGENT_SKIP_KEY = 'orca.cloudSetup.agentSkipped.v1'

/** "Skip for now" on the agent step is remembered, so a ready account isn't asked on every Start. */
export function isCloudSetupAgentSkipped(agent: string | null): boolean {
  if (!agent || typeof localStorage === 'undefined') {
    return false
  }
  try {
    return localStorage.getItem(`${AGENT_SKIP_KEY}:${agent}`) === '1'
  } catch {
    return false
  }
}

export function rememberCloudSetupAgentSkipped(agent: string | null): void {
  if (!agent || typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(`${AGENT_SKIP_KEY}:${agent}`, '1')
  } catch {
    // Private mode: the step asks again next time.
  }
}
