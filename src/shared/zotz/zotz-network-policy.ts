/** Zotz never phones home to Orca/StablyAI services unless a cloud feature is listed here. */
export type ZotzCloudFeature =
  | 'telemetry'
  | 'login'
  | 'relay'
  | 'share'
  | 'connector'
  | 'push'
  | 'github-star'
  | 'agent-state-rules'
  | 'wsl-hosts-policy'

// push.onorca.dev stays on until Hugo resolves "Decisiones abiertas" #1 in docs/zotz/PLAN.md.
const ZOTZ_ALLOWED_CLOUD_FEATURES: ReadonlySet<ZotzCloudFeature> = new Set(['push'])

declare global {
  // Global so upstream suites that reset modules keep testing Orca's cloud behavior.
  var zotzCloudFeaturesOpenForTests: boolean | undefined
}

export const ZOTZ_CLOUD_DISABLED_MESSAGE = 'Orca Cloud services are disabled in Zotz.'

export function isZotzCloudFeatureAllowed(feature: ZotzCloudFeature): boolean {
  return (
    ZOTZ_ALLOWED_CLOUD_FEATURES.has(feature) || globalThis.zotzCloudFeaturesOpenForTests === true
  )
}

export function _setZotzCloudFeaturesOpenForTests(open: boolean): void {
  globalThis.zotzCloudFeaturesOpenForTests = open
}
