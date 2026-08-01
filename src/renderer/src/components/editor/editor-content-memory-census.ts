/**
 * Sizes of the file bodies each mounted editor panel holds in React state.
 *
 * Why this is separate from the store profile: renderer-memory-profile only walks
 * zustand collections, so the largest strings in the renderer — loaded file
 * contents — are structurally invisible when an OOM highwater breadcrumb fires.
 */
import { registerRendererMemoryProfileContributor } from '../../lib/renderer-memory-profile'
import type { DiffContent, FileContent } from './editor-panel-content-types'

export type EditorFileContentCensus = { files: number; chars: number }
/** Separate from file bodies: a diff tab holds two of them, so folding the sums
 *  together hides which of the two shapes filled the heap. */
export type EditorDiffContentCensus = { diffTabs: number; diffChars: number }
export type EditorContentCensus = EditorFileContentCensus & EditorDiffContentCensus

const readers = new Set<() => EditorContentCensus>()

// Why bounded: each reader closes over a panel's fileContents, so a panel that ever
// leaked its unmount would make this diagnostic a retainer of what it measures.
const MAX_CENSUS_READERS = 64

// Why a waiting set rather than dropping outright: panels register once, in a mount
// effect, so a panel that arrives while the cap is full would stay invisible for its
// whole life even after siblings unmount and free slots. Bounded the same way, for
// the same retention reason.
const waitingReaders = new Set<() => EditorContentCensus>()

// Why counted: an undercount with no signal is worse than no number at all in the one
// artifact meant to settle where the heap went. Live, not cumulative — panels that got
// neither a slot nor a waiting place and are still mounted.
let droppedReaders = 0

/** Registers one live panel's contents; call the returned function on unmount. */
export function registerEditorContentCensusReader(read: () => EditorContentCensus): () => void {
  if (readers.size < MAX_CENSUS_READERS) {
    readers.add(read)
  } else if (waitingReaders.size < MAX_CENSUS_READERS) {
    waitingReaders.add(read)
  } else {
    droppedReaders += 1
    // Why latched and clamped: a second cleanup call, or one crossing a test reset,
    // must not release a drop this panel no longer owns.
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      droppedReaders = Math.max(0, droppedReaders - 1)
    }
  }
  return () => {
    readers.delete(read)
    waitingReaders.delete(read)
    promoteWaitingReaders()
  }
}

function promoteWaitingReaders(): void {
  for (const read of waitingReaders) {
    if (readers.size >= MAX_CENSUS_READERS) {
      return
    }
    waitingReaders.delete(read)
    readers.add(read)
  }
}

export function measureEditorFileContents(
  fileContents: Record<string, FileContent>
): EditorFileContentCensus {
  let files = 0
  let chars = 0
  for (const key in fileContents) {
    if (!Object.hasOwn(fileContents, key)) {
      continue
    }
    files += 1
    chars += fileContents[key]?.content?.length ?? 0
  }
  return { files, chars }
}

/**
 * Why measured at all: a diff tab retains `originalContent` *and* `modifiedContent`,
 * so a review session with many diff tabs holds two full file bodies per tab and
 * shows up nowhere in the file-contents census — the most plausible heap shape for
 * a reviewer's OOM, and previously invisible.
 */
export function measureEditorDiffContents(
  diffContents: Record<string, DiffContent>
): EditorDiffContentCensus {
  let diffTabs = 0
  let diffChars = 0
  for (const key in diffContents) {
    if (!Object.hasOwn(diffContents, key)) {
      continue
    }
    const diff = diffContents[key]
    diffTabs += 1
    diffChars += (diff?.originalContent?.length ?? 0) + (diff?.modifiedContent?.length ?? 0)
  }
  return { diffTabs, diffChars }
}

registerRendererMemoryProfileContributor('editorContent', () => {
  let panels = 0
  let files = 0
  let chars = 0
  let diffTabs = 0
  let diffChars = 0
  let readErrors = 0
  for (const read of readers) {
    try {
      const census = read()
      // Why commit together: a throw mid-read must not leave a panel counted with its
      // sizes missing, which reads as a panel holding nothing.
      panels += 1
      files += census.files
      chars += census.chars
      diffTabs += census.diffTabs
      diffChars += census.diffChars
    } catch {
      // Why isolated: one panel tearing down mid-collect would otherwise fail the whole
      // contributor, which reports only `editorContent.error` and erases every sibling's
      // sizes — the subsystem most needed for review-session OOM attribution.
      readErrors += 1
    }
  }
  // `chars`/`diffChars` are UTF-16 code units, not bytes: CJK and emoji bodies
  // under-report against a byte budget by up to 3x.
  return {
    panels,
    files,
    chars,
    diffTabs,
    diffChars,
    // Live panels this collect could not see: waiting for a slot, plus the ones still
    // mounted past both caps.
    droppedPanels: waitingReaders.size + droppedReaders,
    readErrors
  }
})

/** Test-only: the cap is process-wide, so suites must be able to clear it. */
export function resetEditorContentCensusForTesting(): void {
  readers.clear()
  waitingReaders.clear()
  droppedReaders = 0
}
