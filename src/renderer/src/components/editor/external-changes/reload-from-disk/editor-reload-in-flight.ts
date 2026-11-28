import { useSyncExternalStore } from 'react'

// Per-file reload state shared by the header icon, the "…" item, the palette and the paused-root check.
type InFlight = { busy: boolean; spinner: boolean }

const IDLE: InFlight = { busy: false, spinner: false }
const states = new Map<string, InFlight>()
// Silent checks in flight, by model file path: an explicit reload of that model (from the same tab,
// its preview or its source) marks them overtaken. Entries exist only while a silent read runs.
const silentReads = new Map<string, Set<{ overtaken: boolean }>>()
// Bumped by a fixture reset so timers and cleanups of runs from before it write nothing.
let resetGeneration = 0

export function noteExplicitReload(modelPath: string): void {
  for (const read of silentReads.get(modelPath) ?? []) {
    read.overtaken = true
  }
}

/** Registers one silent read of `modelPath`; always `stop()` it when the read settles. */
export function watchExplicitReloads(modelPath: string): {
  overtaken: () => boolean
  stop: () => void
} {
  const read = { overtaken: false }
  const set = silentReads.get(modelPath) ?? new Set<{ overtaken: boolean }>()
  set.add(read)
  silentReads.set(modelPath, set)
  return {
    overtaken: () => read.overtaken,
    stop: () => {
      set.delete(read)
      if (set.size === 0 && silentReads.get(modelPath) === set) {
        silentReads.delete(modelPath)
      }
    }
  }
}
const subscribers = new Set<() => void>()

/** Local reads finish before this, so they never flash a spinner. */
export const RELOAD_SPINNER_DELAY_MS = 200
/** Once shown, the spinner stays long enough to read as feedback rather than a flicker. */
export const RELOAD_SPINNER_MIN_MS = 300

function set(fileId: string, next: InFlight): void {
  if (next.busy) {
    states.set(fileId, next)
  } else {
    states.delete(fileId)
  }
  for (const notify of subscribers) {
    notify()
  }
}

export function isEditorReloadInFlight(fileId: string): boolean {
  return states.get(fileId)?.busy === true
}

/** Runs `work` once per file at a time; returns null when a reload for the file is already running. */
export async function runEditorReloadExclusive<T>(
  fileId: string,
  work: () => Promise<T>,
  options: { showSpinner: boolean }
): Promise<T | null> {
  if (isEditorReloadInFlight(fileId)) {
    return null
  }
  set(fileId, { busy: true, spinner: false })
  const generation = resetGeneration
  const write = (next: InFlight): void => {
    if (generation === resetGeneration) {
      set(fileId, next)
    }
  }
  let spinnerShownAt: number | null = null
  const spinnerTimer = options.showSpinner
    ? setTimeout(() => {
        spinnerShownAt = Date.now()
        write({ busy: true, spinner: true })
      }, RELOAD_SPINNER_DELAY_MS)
    : null
  try {
    return await work()
  } finally {
    if (spinnerTimer) {
      clearTimeout(spinnerTimer)
    }
    const shownFor = spinnerShownAt === null ? null : Date.now() - spinnerShownAt
    if (shownFor !== null && shownFor < RELOAD_SPINNER_MIN_MS) {
      // Keep the guard with the spinner so a click during the hold is still ignored.
      setTimeout(() => write(IDLE), RELOAD_SPINNER_MIN_MS - shownFor)
    } else {
      write(IDLE)
    }
  }
}

/** Component fixtures share one page; each starts with no reload running. */
export function resetEditorReloadInFlight(): void {
  resetGeneration += 1
  states.clear()
  for (const notify of subscribers) {
    notify()
  }
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => subscribers.delete(notify)
}

export function useEditorReloadInFlight(fileId: string): InFlight {
  return useSyncExternalStore(
    subscribe,
    () => states.get(fileId) ?? IDLE,
    () => IDLE
  )
}
