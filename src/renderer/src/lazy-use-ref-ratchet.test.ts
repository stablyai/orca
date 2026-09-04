import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `useRef(create())` evaluates its argument on EVERY render and discards every result after the
 * first, so any real work there is pure waste. The lazy form keeps the same value with none of the
 * churn:
 *
 *   const ref = useRef<T>(undefined!)
 *   ref.current ??= create()
 *
 * Use a `useState` lazy initializer instead when the seed can legitimately be null/undefined, or
 * an explicit `seededRef` guard when both are true.
 */
const RENDERER_ROOT = import.meta.dirname

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue
      }
      collectSourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) {
      continue
    }
    out.push(full)
  }
  return out
}

/** Reads the balanced argument text of the `useRef(...)` starting at `from`. */
function readUseRefArgument(source: string, from: number): { arg: string; end: number } | null {
  let i = from
  while (source[i] === ' ') {
    i++
  }
  if (source[i] === '<') {
    let depth = 0
    while (i < source.length) {
      if (source[i] === '<') {
        depth++
      } else if (source[i] === '>') {
        depth--
        if (depth === 0) {
          i++
          break
        }
      }
      i++
    }
  }
  while (source[i] === ' ') {
    i++
  }
  if (source[i] !== '(') {
    return null
  }
  const argStart = i + 1
  let depth = 0
  while (i < source.length) {
    if (source[i] === '(') {
      depth++
    } else if (source[i] === ')') {
      depth--
      if (depth === 0) {
        return { arg: source.slice(argStart, i).trim(), end: i + 1 }
      }
    }
    i++
  }
  return null
}

// Allowed because none of these is work that a render repeats for nothing:
//  - an empty collection literal, which the repo keeps in the direct form
//  - `undefined!`, the lazy-seed marker
//  - a function literal, which is the ref's payload rather than its initialization
//  - a primitive coercion of an already-computed value
const ALLOWED_ARGUMENT = new RegExp(
  [
    '^new (Map|Set|WeakMap|WeakSet)(<[\\s\\S]*>)?\\(\\)$',
    '^undefined!$',
    '^(async )?\\([\\s\\S]*?\\)\\s*(:[^=]*)?=>[\\s\\S]*$',
    '^(Boolean|Number|String)\\([\\s\\S]*\\)$',
    '^[A-Za-z_$][\\w$.?\\[\\]\'"]*$'
  ].join('|')
)

function findNonLazyUseRefs(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const findings: string[] = []
  let index = 0
  while ((index = source.indexOf('useRef', index)) !== -1) {
    const start = index
    index += 'useRef'.length
    if (/[\w$.]/.test(source[start - 1] ?? '')) {
      continue
    }
    const parsed = readUseRefArgument(source, index)
    if (!parsed) {
      continue
    }
    index = parsed.end
    const arg = parsed.arg
    if (arg === '' || ALLOWED_ARGUMENT.test(arg)) {
      continue
    }
    // Only a call or constructor invocation actually burns work per render.
    if (!/\(/.test(arg) && !/\bnew\b/.test(arg)) {
      continue
    }
    const line = source.slice(0, start).split('\n').length
    findings.push(
      `${path.relative(RENDERER_ROOT, file)}:${line} useRef(${arg.replace(/\s+/g, ' ').slice(0, 90)})`
    )
  }
  return findings
}

describe('renderer useRef initializers', () => {
  it('never does work in the useRef argument', () => {
    const findings = collectSourceFiles(RENDERER_ROOT).flatMap(findNonLazyUseRefs)
    expect(findings).toEqual([])
  })
})
