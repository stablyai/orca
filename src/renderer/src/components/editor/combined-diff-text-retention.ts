import type { DiffSection } from './diff-section-types'

export const COMBINED_DIFF_TEXT_BYTES_PER_CHARACTER = 2
// Why: bound raw UTF-16 text before Monaco creates its own models; inactive
// snapshots split the same budget and may refetch an oversized file on revisit.
export const MAX_RETAINED_COMBINED_DIFF_TEXT_BYTES = 24 * 1024 * 1024
export const MAX_RETAINED_COMBINED_DIFF_TEXT_CHARACTERS = Math.floor(
  MAX_RETAINED_COMBINED_DIFF_TEXT_BYTES / COMBINED_DIFF_TEXT_BYTES_PER_CHARACTER
)
export const COMBINED_DIFF_VIEW_STATE_CACHE_MAX_ENTRIES = 20

export type CombinedDiffTextRetentionInspection = {
  characters: number
  approximateBytes: number
  sectionsWithText: number
}

export type CombinedDiffTextRetentionResult = CombinedDiffTextRetentionInspection & {
  sections: DiffSection[]
  loadedIndices: number[]
  evictedIndices: number[]
}

type CombinedDiffTextViewState = {
  sections: DiffSection[]
  loadedIndices: number[]
}

function getSectionTextCharacters(section: DiffSection): number {
  if (section.diffResult?.kind !== 'text') {
    return 0
  }
  return section.originalContent.length + section.modifiedContent.length
}

export function inspectCombinedDiffTextRetention(
  sections: readonly DiffSection[]
): CombinedDiffTextRetentionInspection {
  let characters = 0
  let sectionsWithText = 0
  for (const section of sections) {
    const sectionCharacters = getSectionTextCharacters(section)
    if (sectionCharacters === 0) {
      continue
    }
    characters += sectionCharacters
    sectionsWithText += 1
  }
  return {
    characters,
    approximateBytes: characters * COMBINED_DIFF_TEXT_BYTES_PER_CHARACTER,
    sectionsWithText
  }
}

function isReloadableSection(
  section: DiffSection,
  protectedSectionKeys: ReadonlySet<string>
): boolean {
  return (
    getSectionTextCharacters(section) > 0 &&
    !section.loading &&
    !section.dirty &&
    !section.error &&
    !protectedSectionKeys.has(section.key)
  )
}

function releaseSectionText(section: DiffSection): DiffSection {
  return {
    ...section,
    originalContent: '',
    modifiedContent: '',
    diffResult: null,
    loading: true,
    contentGeneration: (section.contentGeneration ?? 0) + 1,
    textEvictedForRetention: true
  }
}

export function getCombinedDiffViewedSectionKeys(
  sections: readonly DiffSection[]
): ReadonlySet<string> {
  return new Set(
    sections
      .filter((section) => !section.loading || section.textEvictedForRetention === true)
      .map((section) => section.key)
  )
}

export function retainCombinedDiffSectionText({
  sections,
  loadedIndices,
  protectedSectionKeys = new Set<string>(),
  maxCharacters = MAX_RETAINED_COMBINED_DIFF_TEXT_CHARACTERS
}: {
  sections: DiffSection[]
  loadedIndices: Iterable<number>
  protectedSectionKeys?: ReadonlySet<string>
  maxCharacters?: number
}): CombinedDiffTextRetentionResult {
  const inspection = inspectCombinedDiffTextRetention(sections)
  const loadedIndexOrder = Array.from(loadedIndices)
  if (inspection.characters <= maxCharacters) {
    return {
      ...inspection,
      sections,
      loadedIndices: loadedIndexOrder,
      evictedIndices: []
    }
  }

  // Why: loaded indices preserve load order; a refetched section rejoins at the tail.
  const orderedCandidates = loadedIndexOrder.filter((index) => {
    const section = sections[index]
    return section !== undefined && isReloadableSection(section, protectedSectionKeys)
  })
  const orderedCandidateSet = new Set(orderedCandidates)
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    if (
      !orderedCandidateSet.has(index) &&
      section !== undefined &&
      isReloadableSection(section, protectedSectionKeys)
    ) {
      orderedCandidates.push(index)
    }
  }

  let retainedCharacters = inspection.characters
  let retainedSections = sections
  const evictedIndices: number[] = []
  for (const index of orderedCandidates) {
    if (retainedCharacters <= maxCharacters) {
      break
    }
    const section = retainedSections[index]
    const sectionCharacters = getSectionTextCharacters(section)
    if (sectionCharacters === 0) {
      continue
    }
    if (retainedSections === sections) {
      retainedSections = [...sections]
    }
    retainedSections[index] = releaseSectionText(section)
    retainedCharacters -= sectionCharacters
    evictedIndices.push(index)
  }

  const evictedIndexSet = new Set(evictedIndices)
  return {
    characters: retainedCharacters,
    approximateBytes: retainedCharacters * COMBINED_DIFF_TEXT_BYTES_PER_CHARACTER,
    sectionsWithText: inspection.sectionsWithText - evictedIndices.length,
    sections: retainedSections,
    loadedIndices: loadedIndexOrder.filter((index) => !evictedIndexSet.has(index)),
    evictedIndices
  }
}

export function inspectCombinedDiffViewStateTextRetention(
  viewStates: Iterable<CombinedDiffTextViewState>
): CombinedDiffTextRetentionInspection {
  let characters = 0
  let sectionsWithText = 0
  for (const viewState of viewStates) {
    const inspection = inspectCombinedDiffTextRetention(viewState.sections)
    characters += inspection.characters
    sectionsWithText += inspection.sectionsWithText
  }
  return {
    characters,
    approximateBytes: characters * COMBINED_DIFF_TEXT_BYTES_PER_CHARACTER,
    sectionsWithText
  }
}

export function retainCombinedDiffViewStateText<T extends CombinedDiffTextViewState>(
  viewStates: Map<string, T>,
  maxCharacters = MAX_RETAINED_COMBINED_DIFF_TEXT_CHARACTERS
): CombinedDiffTextRetentionInspection {
  let retainedCharacters = inspectCombinedDiffViewStateTextRetention(viewStates.values()).characters
  // Why: view-state Maps are LRUs, so iteration releases the oldest inactive view first.
  for (const [key, viewState] of viewStates) {
    if (retainedCharacters <= maxCharacters) {
      break
    }
    const viewStateCharacters = inspectCombinedDiffTextRetention(viewState.sections).characters
    const retained = retainCombinedDiffSectionText({
      sections: viewState.sections,
      loadedIndices: viewState.loadedIndices,
      maxCharacters: Math.max(0, viewStateCharacters - (retainedCharacters - maxCharacters))
    })
    if (retained.evictedIndices.length === 0) {
      continue
    }
    viewStates.set(key, {
      ...viewState,
      sections: retained.sections,
      loadedIndices: retained.loadedIndices
    })
    retainedCharacters -= viewStateCharacters - retained.characters
  }
  return inspectCombinedDiffViewStateTextRetention(viewStates.values())
}
