import type { TuiAgent } from './tui-agent'

export type RuledScreen = { lines: readonly string[]; alternateScreen: boolean }

/** OMP paints idle before setup; its alternate-screen overlays still own input. */
export function readScreenInputVeto(
  agent: TuiAgent | null | undefined,
  readScreen: () => RuledScreen | null
): boolean | null {
  return agent === 'omp' ? (readScreen()?.alternateScreen ?? null) : null
}
