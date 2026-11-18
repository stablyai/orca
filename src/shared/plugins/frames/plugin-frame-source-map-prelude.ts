/** `Symbol.for` key of the hook the components runtime installs to learn served modules' maps. */
export const PLUGIN_SOURCE_MAP_HOOK = 'orca.pluginSourceMap'

/**
 * Prepended to line 1 of a transpiled plugin module (so lines stay the source's): hands the
 * runtime the module's VLQ mappings, since Chromium's `error.stack` ignores source maps. A no-op
 * in frames without the runtime. Line 1 columns then sit this many characters to the right.
 */
export function pluginSourceMapPrelude(mappings: string): string {
  return `globalThis[Symbol.for(${JSON.stringify(PLUGIN_SOURCE_MAP_HOOK)})]?.(import.meta.url,${JSON.stringify(mappings)});`
}
