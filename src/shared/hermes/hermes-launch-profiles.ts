/** Named Hermes profiles the desktop can launch: read from the local Hermes home on demand. */
export type HermesLaunchProfiles = {
  /** Profile ids under `<root>/profiles/`, sorted; empty when none exist. */
  profiles: string[]
  /** The sticky `hermes profile use` choice, or null when the root home is active. */
  active: string | null
}
