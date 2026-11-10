// What the composer card renders for "Start in Orca Cloud", shared by the hook and the card.
import type { CloudSetupStep } from './cloud-start-model'
import type { CloudOnlyRepo } from './use-cloud-only-repo'

/** What the card renders: Run on's Orca Cloud segment, the setup panel and the fallback button. */
export type CloudStartView = {
  steps: CloudSetupStep[]
  panelVisible: boolean
  allSet: boolean
  onSelectOrcaCloud: () => void
  onUserPick: () => void
  /** Present while setup blocks a start: creates the same prompt on this computer. */
  onUseThisComputer?: () => void
  /** D4: GitHub repositories with no clone here, and the one picked. */
  cloudOnly?: CloudOnlyRepo
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}
