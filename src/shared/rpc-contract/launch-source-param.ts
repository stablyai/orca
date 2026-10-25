import { z } from 'zod'

/**
 * Which surface started an agent launch, deliberately `z.string()` rather than the closed
 * `launchSourceSchema`.
 *
 * Params are validated by the HOST, so a closed enum here is a version claim pointing the wrong
 * way: a newer client naming a launch surface an older host has never heard of would have its
 * whole launch refused over a label nothing reads as behaviour. Bookkeeping must not gate a user
 * action, so the arm set stays open here and the host resolves it leniently where it is used.
 */
export const LaunchSourceParam = z.string()
