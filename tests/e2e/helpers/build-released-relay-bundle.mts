/**
 * Prints `{ bundleDir, version }` for the released relay's bundle. Run through tsx so the
 * Playwright spec never loads the ESM-only release checkout and build tooling itself.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
 */
import { materializeReleaseCheckout } from '../cross-version-wire/release-checkout.ts'
import {
  buildReleasedRelayBundle,
  PREVIOUS_RELAY_REF
} from '../cross-version-wire/released-relay-daemon.ts'

const built = await buildReleasedRelayBundle(await materializeReleaseCheckout(PREVIOUS_RELAY_REF))
process.stdout.write(`${JSON.stringify(built)}\n`)
