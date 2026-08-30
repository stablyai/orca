import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A census keyed on the surface rather than on the stripper.
 *
 * `ipc-error-call-site-census.test.ts` enumerates callers of `extractIpcErrorMessage`. That census
 * is structurally unable to see this leak: the terminal error toast is fed through an accumulator,
 * so a producer's raw `err.message` becomes one line of a newline-joined blob and never passes
 * through a site that census inspects. Listing the accumulator there would have fixed one entry and
 * left the shape — a value buffered before display — just as invisible.
 *
 * So this enumerates the doors into `terminalError`, the state the toast renders, and records how
 * each one is made safe. Adding a door fails this test until its verdict is written down. That is
 * what catches the next one: `formatClipboardImagePasteError` was a real envelope leak into this
 * same surface that bypassed the accumulator entirely, and no stripper-keyed census could see it.
 *
 * What this cannot see, stated rather than implied: it is scoped to one surface, and it reads source
 * text, so it sees the call, not the value. The two siblings it used to name — `use-task-page-gitlab-fetch.ts`
 * and `use-discard-confirmation.ts` — are fixed and now enumerated in `lib/ipc-error-call-site-census.test.ts`.
 *
 * That does not make the population closed, and the note there says why: enumerating by render sink
 * rather than by stripper finds 118 renderer modules that still hand a raw rejection to a user
 * surface with an IPC-capable producer behind it. Per-surface censuses like this one do not scale to
 * that, and a lint rule on the idiom would need suppressions. The proposal on the table is to strip
 * once at the preload boundary instead.
 */
const SURFACE_DOORS: Readonly<Record<string, string>> = {
  'setTerminalError(null)': 'clears the surface',
  'setTerminalError((prev) => appendTerminalErrorMessage(prev, message))':
    'accumulator — strips the IPC envelope for every pane-error producer',
  'setTerminalError((prev) => (prev && isTerminalZeroDimensionsDiagnostic(prev) ? null : prev))':
    'derived from the value already on the surface',
  'setTerminalError(formatTerminalPasteExecutionError(execution.reason))':
    'total map from a paste-reason enum to literal copy — no rejection reaches it',
  "setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.')":
    'literal copy',
  'setTerminalError(formatClipboardImagePasteError(error))':
    'strips the IPC envelope — clipboard:saveImageAsTempFile rejects through here',
  "setTerminalError('Paste failed.')": 'literal copy',
  'setTerminalError(kept)': 'derived from the value already on the surface'
}

const PANE_SOURCE = join(__dirname, 'TerminalPane.tsx')

// Why by name and not by regex: the call is written across lines in places, so the argument text is
// normalised to one line before matching rather than the pattern being widened to swallow newlines.
function listSurfaceDoors(source: string): string[] {
  const doors: string[] = []
  const marker = 'setTerminalError('
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    let depth = 0
    let end = at + marker.length - 1
    for (; end < source.length; end += 1) {
      if (source[end] === '(') {
        depth += 1
      } else if (source[end] === ')') {
        depth -= 1
        if (depth === 0) {
          break
        }
      }
    }
    doors.push(source.slice(at, end + 1).replace(/\s+/g, ' '))
  }
  return doors
}

describe('the terminal error surface', () => {
  it('has exactly the enumerated doors, each with a written-down verdict', () => {
    const doors = new Set(listSurfaceDoors(readFileSync(PANE_SOURCE, 'utf8')))

    expect([...doors].sort()).toEqual(Object.keys(SURFACE_DOORS).sort())
  })

  it('records why every door is safe', () => {
    expect(Object.values(SURFACE_DOORS).filter((verdict) => verdict === '')).toEqual([])
  })
})
