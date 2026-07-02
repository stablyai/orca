import { useSpotlightAutoSync } from '@/hooks/useSpotlightAutoSync'

/** Leaf mount for the Spotlight file-watch sync loop. Renders null so its
 *  store subscription (spotlightByRepo updates on every sync) never
 *  re-renders the App tree. */
export default function SpotlightAutoSyncGate(): null {
  useSpotlightAutoSync()
  return null
}
