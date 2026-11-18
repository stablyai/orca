import { useEffect, useState } from 'react'

/** Where the key file arrives from while the key step is open. Orca's own browser needs no watch:
 *  main takes the key as that page downloads it. */
export type KeySource = { kind: 'downloads' } | null

/** Takes the app key the moment it lands in Downloads. */
export function useCaptureClientKey(
  source: KeySource,
  onClient: (text: string) => Promise<void>
): { error: string | null; gaveUp: boolean } {
  const [error, setError] = useState<string | null>(null)
  // Downloads can't be watched here: waiting again would fail at once, so only the file input is left.
  const [downloadsUnwatchable, setDownloadsUnwatchable] = useState(false)
  const [round, setRound] = useState(0)
  const armed = source !== null
  const gaveUp = downloadsUnwatchable && armed
  useEffect(() => {
    if (!armed || gaveUp) {
      return undefined
    }
    let live = true
    void window.api.googleSetup
      .watchDownloads()
      .then(async (result) => {
        if (!live) {
          return
        }
        if (!result.ok && result.unwatchable) {
          setError(result.message)
          setDownloadsUnwatchable(true)
          return
        }
        if (!result.ok) {
          throw new Error(result.message)
        }
        setError(null)
        await onClient(result.text)
      })
      .catch((failure: unknown) => {
        if (live) {
          setError(failure instanceof Error ? failure.message : String(failure))
          // Wait for the next download, e.g. after creating the right kind of key.
          setRound((value) => value + 1)
        }
      })
    return () => {
      live = false
      void window.api.googleSetup.stopWatchingDownloads().catch(() => {})
    }
  }, [armed, onClient, round, gaveUp])
  return { error, gaveUp }
}
