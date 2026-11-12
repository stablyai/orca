import type { PaletteExtraSource } from './palette-extra-results'

const NO_SOURCES: readonly PaletteExtraSource[] = []

/** Each source registers here with its own hook; return a memoized list. */
export function usePaletteExtraSources(_args: {
  query: string
  visible: boolean
}): readonly PaletteExtraSource[] {
  return NO_SOURCES
}
