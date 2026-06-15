import type { GlobalSettings, SourceControlViewMode } from '../../../../shared/types'

export function getNextSourceControlViewMode(mode: SourceControlViewMode): SourceControlViewMode {
  return mode === 'tree' ? 'list' : 'tree'
}

export type SourceControlViewModePreferenceWriteState = {
  writeChain: Promise<void>
  writeSeq: number
}

export function requestSourceControlViewModePreferenceWrite({
  hydrated,
  currentMode,
  writeState,
  setOptimisticMode,
  updateSettings
}: {
  hydrated: boolean
  currentMode: SourceControlViewMode
  writeState: SourceControlViewModePreferenceWriteState
  setOptimisticMode: (mode: SourceControlViewMode | null) => void
  updateSettings: (
    updates: Pick<GlobalSettings, 'sourceControlViewMode'>
  ) => Promise<GlobalSettings | void>
}): SourceControlViewMode | null {
  if (!hydrated) {
    return null
  }
  const next = getNextSourceControlViewMode(currentMode)
  const writeSeq = writeState.writeSeq + 1
  writeState.writeSeq = writeSeq
  setOptimisticMode(next)

  // Why: settings writes cross IPC. Queue them so rapid toolbar clicks keep the
  // user's final intent as the persisted value even if earlier writes would
  // otherwise resolve after later clicks.
  const write = writeState.writeChain
    .catch(() => undefined)
    .then(() => updateSettings({ sourceControlViewMode: next }))
    .then(() => undefined)
  writeState.writeChain = write
  void write
    .finally(() => {
      if (writeState.writeSeq === writeSeq) {
        setOptimisticMode(null)
      }
    })
    .catch(() => undefined)

  return next
}
