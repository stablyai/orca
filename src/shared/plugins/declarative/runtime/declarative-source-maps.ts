import {
  PLUGIN_SOURCE_MAP_HOOK,
  pluginSourceMapPrelude
} from '../../frames/plugin-frame-source-map-prelude'

/** Generated column, then source line and column (all 0-based); sucrase maps one source. */
type Segment = readonly [number, number, number]
type ModuleMap = { mappings: string; lineOneShift: number; lines?: Segment[][] }

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
// Why a cap: hot reload registers every revision of every module in a long-lived guest.
const MAX_MODULES = 256
const maps = new Map<string, ModuleMap>()

/** Source map v3 `mappings`, decoded per generated line. */
export function decodeSourceMapMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = []
  const state = [0, 0, 0, 0, 0]
  for (const line of mappings.split(';')) {
    const segments: Segment[] = []
    state[0] = 0
    for (const text of line.split(',')) {
      const fields: number[] = []
      let value = 0
      let shift = 0
      for (const char of text) {
        const digit = BASE64.indexOf(char)
        value += (digit & 31) << shift
        if (digit & 32) {
          shift += 5
          continue
        }
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1)
        value = 0
        shift = 0
      }
      for (const [index, delta] of fields.entries()) {
        state[index] += delta
      }
      if (fields.length >= 4) {
        segments.push([state[0], state[2], state[3]])
      }
    }
    lines.push(segments)
  }
  return lines
}

export function registerPluginSourceMap(url: string, mappings: string): void {
  maps.delete(url)
  maps.set(url, { mappings, lineOneShift: pluginSourceMapPrelude(mappings).length })
  for (const oldest of maps.keys()) {
    if (maps.size <= MAX_MODULES) {
      break
    }
    maps.delete(oldest)
  }
}

/** Installs the hook served modules call from their prelude (plugin-frame-source-map-prelude). */
export function installPluginSourceMapHook(): void {
  Object.assign(globalThis, { [Symbol.for(PLUGIN_SOURCE_MAP_HOOK)]: registerPluginSourceMap })
}

/** 1-based source position of a 1-based generated one in `url`, as Node's
 *  `--enable-source-maps` reports it (the segment's start); null when `url` sent no map. */
export function originalPluginPosition(
  url: string,
  line: number,
  column: number
): { line: number; column: number } | null {
  const map = maps.get(url)
  if (!map) {
    return null
  }
  map.lines ??= decodeSourceMapMappings(map.mappings)
  const generated = column - 1 - (line === 1 ? map.lineOneShift : 0)
  let found: Segment | undefined
  for (const segment of map.lines[line - 1] ?? []) {
    if (segment[0] > generated) {
      break
    }
    found = segment
  }
  return found ? { line: found[1] + 1, column: found[2] + 1 } : null
}
