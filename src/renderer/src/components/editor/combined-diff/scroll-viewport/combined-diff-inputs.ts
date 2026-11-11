import type { DiffSection } from '../../diff/sections/diff-section-types'
import { getDiffSectionRowEstimatedHeight } from '../../diff/sections/diff-section-layout'
import type { CombinedDiffViewportOwner } from './combined-diff-viewport-owner'
import type { DiffViewportInput } from './combined-diff-viewport-items'

type InputEntry = {
  section: DiffSection
  measuredHeight: number | undefined
  input: DiffViewportInput
}
const notice: DiffViewportInput = {
  key: 'combined-diff-notice',
  generation: 'notice',
  height: 88,
  collapsed: false,
  index: -1
}

export class CombinedDiffInputs {
  private sections: readonly DiffSection[] | null = null
  private heights: Readonly<Record<number, number>> | null = null
  private prefix = false
  private entries = new Map<string, InputEntry>()
  constructor(private readonly owner: CombinedDiffViewportOwner) {}

  update(
    sections: readonly DiffSection[],
    heights: Readonly<Record<number, number>>,
    prefix: boolean
  ): void {
    if (sections === this.sections && heights === this.heights && prefix === this.prefix) {
      return
    }
    let structure = sections.length !== this.sections?.length || prefix !== this.prefix
    const changes: DiffViewportInput[] = []
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index]
      const entry = this.entries.get(section.key)
      if (section.key !== this.sections?.[index]?.key) {
        structure = true
      }
      if (
        entry?.section === section &&
        entry.measuredHeight === heights[index] &&
        entry.input.index === index
      ) {
        continue
      }
      const generation =
        entry?.section === section
          ? entry.input.generation
          : `${section.contentGeneration ?? 0}:${section.loading ? 'loading' : section.error ? 'error' : section.loadOnDemand ? 'deferred' : section.largeDiffRenderLimit?.limited ? 'limited' : (section.diffResult?.kind ?? 'text')}`
      const retained = this.owner.getItem(section.key)
      const measured =
        retained?.measured &&
        retained.generation === generation &&
        retained.collapsed === section.collapsed
      const height =
        measured && entry
          ? entry.input.height
          : getDiffSectionRowEstimatedHeight(section, heights[index])
      const previous = entry?.input
      const input =
        previous &&
        previous.generation === generation &&
        previous.height === height &&
        previous.collapsed === section.collapsed &&
        previous.index === index
          ? previous
          : { key: section.key, generation, height, collapsed: section.collapsed, index }
      if (previous?.generation !== generation) {
        structure = true
      }
      this.entries.set(section.key, { section, measuredHeight: heights[index], input })
      if (input !== previous) {
        changes.push(input)
      }
    }
    this.sections = sections
    this.heights = heights
    this.prefix = prefix
    if (structure) {
      const inputs = sections.map((section) => this.entries.get(section.key)!.input)
      this.entries = new Map(
        sections.map((section) => [section.key, this.entries.get(section.key)!])
      )
      this.owner.setItems(prefix ? [notice, ...inputs] : inputs)
    } else if (changes.length) {
      this.owner.updateItems(changes)
    }
  }
}
