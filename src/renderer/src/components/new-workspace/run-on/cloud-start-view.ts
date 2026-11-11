// What the composer card needs for Orca Cloud, shared by the hook and the card. Picking Orca Cloud
// changes nothing else in the dialog (composer-redo): setup lives on its own page after Start.
import type { CloudOnlyRepo } from './use-cloud-only-repo'
import type { OrcaCloudWallNotice } from '@/lib/orca-cloud/run-on-preflight'

export type CloudStartView = {
  /** Picks Orca Cloud even while the account still needs setup; Start walks it on a page. */
  onSelectOrcaCloud: () => void
  onUserPick: () => void
  /** D4: GitHub repositories with no clone here, and the one picked. */
  cloudOnly?: CloudOnlyRepo
  /** The project is a plain folder: Orca Cloud needs a GitHub repository instead (D3/D4). */
  folderProject?: boolean
  /** JA-21b (flagged): Orca Cloud is selected and a billing wall applies; Create waits for the fix. */
  wall?: OrcaCloudWallNotice | null
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}
