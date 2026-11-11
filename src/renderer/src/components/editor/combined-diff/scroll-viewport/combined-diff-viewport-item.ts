import type { CombinedDiffViewportOwner, DiffSemanticPoint } from './combined-diff-viewport-owner'
import type { DiffItemLayout, DiffViewportLayout } from './combined-diff-layout'

export type DiffViewportBinding = {
  apply(layout: DiffItemLayout, viewport: DiffViewportLayout, width: number): void
  readHeight(): number | null
  isScrollApplied?(): boolean
  capture(edge: number, previous?: DiffSemanticPoint): DiffSemanticPoint | null
  hasFocus(): boolean
  detach(): void
}
export type DiffViewportItem = {
  readonly key: string
  readonly generation: string
  readonly owner: CombinedDiffViewportOwner
  index: number
  height: number
  collapsed: boolean
  bodyKind?: 'pending' | 'native' | 'final'
  measured: boolean
  retired: boolean
  node: HTMLDivElement | null
  chrome: { header: HTMLElement | null; conflict: HTMLElement | null; body: HTMLElement | null }
  binding: DiffViewportBinding | null
  readonly onRetire: Set<() => void>
}
