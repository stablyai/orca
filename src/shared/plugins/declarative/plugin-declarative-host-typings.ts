import { pluginHostMethodTypeTexts } from '../workers/plugin-host-api-reference-doc'
import { PLUGIN_HOST_API, pluginHostMethodsFor } from '../workers/plugin-host-api'

/** Markers around the generated region of resources/plugins/declarative/orca.d.ts. */
export const ORCA_HOST_TYPINGS_BEGIN = '  // <generated: host methods, from plugin-host-api.ts>'
export const ORCA_HOST_TYPINGS_END = '  // </generated>'

/** The panel's host methods as `HostMethods`, so `host.call` is typed from the same table. */
export function renderOrcaHostTypings(): string {
  const lines = [ORCA_HOST_TYPINGS_BEGIN, '  export type HostMethods = {']
  for (const name of pluginHostMethodsFor('panel')) {
    const spec = PLUGIN_HOST_API[name]
    const types = pluginHostMethodTypeTexts(spec.params, spec.result)
    const text = (value: string): string => value.replace(/\bJSON\b/g, 'JsonValue')
    // A method without params takes none; `{}` would accept anything.
    const params = types.params === '{}' ? 'Record<string, never>' : text(types.params)
    lines.push(`    /** ${spec.summary} */`)
    lines.push(`    '${name}': { params: ${params}; result: ${text(types.result)} }`)
  }
  lines.push('  }', ORCA_HOST_TYPINGS_END)
  return lines.join('\n')
}

/** `file` with its generated region replaced; throws when the markers are missing. */
export function spliceOrcaHostTypings(file: string): string {
  const begin = file.indexOf(ORCA_HOST_TYPINGS_BEGIN)
  const end = file.indexOf(ORCA_HOST_TYPINGS_END, begin)
  if (begin === -1 || end === -1) {
    throw new Error('orca.d.ts lacks the generated host-method markers')
  }
  return (
    file.slice(0, begin) + renderOrcaHostTypings() + file.slice(end + ORCA_HOST_TYPINGS_END.length)
  )
}
