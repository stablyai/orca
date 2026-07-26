import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: the toggle switch is hand-rolled at every call site instead of living in a
// primitive, so the handle offset drifts. The track is `h-5 w-9` with a 1px border
// and `box-sizing: border-box`, leaving 34px of content for a 14px (`size-3.5`)
// handle. `translate-x-0.5` insets the off state by 2px, so the on state must be
// 34 - 14 - 2 = 18px (`translate-x-4.5`). `translate-x-4` (16px) leaves 4px on the
// right and reads visibly off-center.

const COMPONENTS_DIR = resolve(__dirname)

const OFF_STATE = 'translate-x-0.5'
const ON_STATE = 'translate-x-4.5'

const HANDLE_SIZE = /\bsize-3\.5\b|\bh-3\.5 w-3\.5\b/

function listSwitchSources(): string[] {
  const output = execFileSync('git', ['grep', '-l', '--', 'role="switch"', '--', '*.tsx'], {
    cwd: COMPONENTS_DIR,
    encoding: 'utf8'
  })
  return output
    .split('\n')
    .filter((file) => file.length > 0 && !file.includes('.test.'))
    .map((file) => resolve(COMPONENTS_DIR, file))
}

/**
 * Offsets of the standard `h-5 w-9` switch handle, one entry per handle span. The
 * `size-3.5` class and the translate utilities are usually on separate lines (the
 * class list wraps around a ternary), so the size is matched against a small
 * lookback window rather than the same line.
 */
function findHandleOffsets(source: string): { line: number; offsets: string[] }[] {
  const lines = source.split('\n')
  const found: { line: number; offsets: string[] }[] = []

  lines.forEach((line, index) => {
    const offsets = [...line.matchAll(/\btranslate-x-(\d+(?:\.\d+)?)\b/g)].map(
      (match) => `translate-x-${match[1]}`
    )
    if (offsets.length === 0) {
      return
    }
    const context = [lines[index - 2] ?? '', lines[index - 1] ?? '', line].join(' ')
    if (!HANDLE_SIZE.test(context)) {
      return
    }
    found.push({ line: index + 1, offsets })
  })

  return found
}

describe('toggle switch handle alignment', () => {
  it('finds the hand-rolled switch call sites', () => {
    expect(listSwitchSources().length).toBeGreaterThan(20)
  })

  it('offsets the on state so both edges inset by 2px', () => {
    const offenders: string[] = []
    let handles = 0

    for (const file of listSwitchSources()) {
      for (const handle of findHandleOffsets(readFileSync(file, 'utf8'))) {
        handles += 1
        for (const offset of handle.offsets) {
          if (offset !== OFF_STATE && offset !== ON_STATE) {
            offenders.push(`${file}:${handle.line}: ${offset} (expected ${ON_STATE})`)
          }
        }
      }
    }

    expect(handles).toBeGreaterThan(25)
    expect(offenders).toEqual([])
  })

  it('pairs every two-state handle with the symmetric on/off offsets', () => {
    const pairs: string[] = []

    for (const file of listSwitchSources()) {
      for (const handle of findHandleOffsets(readFileSync(file, 'utf8'))) {
        if (handle.offsets.length === 2) {
          pairs.push([...handle.offsets].sort().join(' '))
        }
      }
    }

    expect(pairs.length).toBeGreaterThan(20)
    expect([...new Set(pairs)]).toEqual([[ON_STATE, OFF_STATE].sort().join(' ')])
  })
})
