/** Metadata key on an enum field: the release each value arrived in. Kept apart from the floor
 *  check so value tables can declare it without importing zod-walking code. */
export const PLUGIN_ENUM_SINCE_KEY = 'x-orca-enum-since'
