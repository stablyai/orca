import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** Keep telemetry labels open: older hosts must not reject launches over a newer client’s surface name.
 * Resolve unknown labels leniently where consumed, rather than using launchSourceSchema here. */
export const LaunchSourceParam = lazyZodSchema(() => z.string())
