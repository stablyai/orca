import { useCallback, useState } from 'react'

export type MaestroRunPanelVisibility = 'expanded' | 'compact' | 'hidden'

const MAESTRO_RUN_PANEL_VISIBILITY_PREFIX = 'orca:maestro-run-panel:'
const DEFAULT_MAESTRO_RUN_PANEL_VISIBILITY: MaestroRunPanelVisibility = 'expanded'

type VisibilityStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): VisibilityStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

function isMaestroRunPanelVisibility(value: string | null): value is MaestroRunPanelVisibility {
  return value === 'expanded' || value === 'compact' || value === 'hidden'
}

export function maestroRunPanelVisibilityStorageKey(
  executionHostId: string,
  workspaceKey: string
): string {
  return `${MAESTRO_RUN_PANEL_VISIBILITY_PREFIX}${JSON.stringify([executionHostId, workspaceKey])}`
}

export function readMaestroRunPanelVisibility(
  storageKey: string,
  storage: VisibilityStorage | null = browserStorage()
): MaestroRunPanelVisibility {
  try {
    const stored = storage?.getItem(storageKey) ?? null
    return isMaestroRunPanelVisibility(stored) ? stored : DEFAULT_MAESTRO_RUN_PANEL_VISIBILITY
  } catch {
    return DEFAULT_MAESTRO_RUN_PANEL_VISIBILITY
  }
}

export function writeMaestroRunPanelVisibility(
  storageKey: string,
  visibility: MaestroRunPanelVisibility,
  storage: VisibilityStorage | null = browserStorage()
): void {
  try {
    storage?.setItem(storageKey, visibility)
  } catch {
    // A blocked storage provider must not make the Run panel unusable.
  }
}

export function useMaestroRunPanelVisibility(scope: {
  execution_host_id: string
  workspace_key: string
}): readonly [MaestroRunPanelVisibility, (visibility: MaestroRunPanelVisibility) => void] {
  const storageKey = maestroRunPanelVisibilityStorageKey(
    scope.execution_host_id,
    scope.workspace_key
  )
  const [stored, setStored] = useState(() => ({
    storageKey,
    visibility: readMaestroRunPanelVisibility(storageKey)
  }))
  const visibility =
    stored.storageKey === storageKey ? stored.visibility : readMaestroRunPanelVisibility(storageKey)
  const setVisibility = useCallback(
    (next: MaestroRunPanelVisibility): void => {
      writeMaestroRunPanelVisibility(storageKey, next)
      setStored({ storageKey, visibility: next })
    },
    [storageKey]
  )
  return [visibility, setVisibility] as const
}
