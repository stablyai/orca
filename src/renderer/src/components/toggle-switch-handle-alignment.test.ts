import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
// TypeScript 7 is a native CLI; AST tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

// Why: the h-5 w-9 switch is hand-rolled at every call site instead of living in a
// primitive, so the handle offset drifts. The 1px-bordered track leaves a 34px content
// box for the 14px (`size-3.5`) handle, and `translate-x-0.5` insets the off state by
// 2px, so a symmetric on state is 34 - 14 - 2 = 18px (`translate-x-4.5`).

const RENDERER_ROOT = resolve('src/renderer/src')

const OFF_STATE = 'translate-x-0.5'
const ON_STATE = 'translate-x-4.5'

/** The track geometry the arithmetic above is derived from; other switch sizes are not ours to check. */
const TRACK = ['h-5', 'w-9']

/** The handle's 14px size, in both the shorthand and long-hand spellings in use. */
const HANDLE_SIZE = [['size-3.5'], ['h-3.5', 'w-3.5']]

/** Every current handle is the round knob; this is what separates it from a size-3.5 icon in the same track. */
const HANDLE_SHAPE = 'rounded-full'

/** Any horizontal translate — negative, arbitrary, variant-prefixed or named — so no respelling reads as "no offset". */
const OFFSET = /(?:^|:)-?translate-x-\S+$/

/** Anything that moves the track off the 34px content box the 18px on-state is derived from. */
const BORDER_WIDTH = /^border(?:-[xytrbles])?-(?:\d+|\[)/
const TRACK_PADDING = /^p[xytrbles]?-(?:\d|\[)/

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const filePath = resolve(dir, name)
    if (statSync(filePath).isDirectory()) {
      collectSourceFiles(filePath, files)
    } else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) {
      files.push(filePath)
    }
  }
  return files
}

/** Class tokens anywhere under a node, flattening the ternaries, template holes and `cn()` args a className is built from. */
function tokensIn(node: ts.Node): string[] {
  const tokens: string[] = []
  const read = (child: ts.Node): void => {
    if (ts.isStringLiteral(child) || ts.isTemplateLiteralToken(child)) {
      tokens.push(...child.text.split(/\s+/).filter(Boolean))
    }
    ts.forEachChild(child, read)
  }
  read(node)
  return tokens
}

/** Reading the className attribute's own subtree keeps a child element's classes out of its parent's token set. */
function classNameOf(element: ts.JsxOpeningLikeElement): ts.Node | undefined {
  const className = element.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === 'className'
  )
  return className?.initializer
}

function hasAll(tokens: string[], required: string[]): boolean {
  return required.every((token) => tokens.includes(token))
}

/**
 * The offsets each side of a conditional className contributes. A handle that toggles is
 * two-state by construction, so this tells a deliberately single-state knob apart from one
 * that lost a branch — which a flat token list cannot.
 */
function offsetBranches(node: ts.Node): [string[], string[]][] {
  const branches: [string[], string[]][] = []
  const read = (child: ts.Node): void => {
    if (ts.isConditionalExpression(child)) {
      const whenTrue = tokensIn(child.whenTrue).filter((token) => OFFSET.test(token))
      const whenFalse = tokensIn(child.whenFalse).filter((token) => OFFSET.test(token))
      if (whenTrue.length > 0 || whenFalse.length > 0) {
        branches.push([whenTrue, whenFalse])
        return
      }
    }
    ts.forEachChild(child, read)
  }
  read(node)
  return branches
}

function trackDrift(tokens: string[]): string | undefined {
  if (!tokens.includes('border')) {
    return 'no 1px border'
  }
  if (tokens.includes('box-content')) {
    return 'box-content'
  }
  return tokens.find((token) => BORDER_WIDTH.test(token) || TRACK_PADDING.test(token))
}

type Handle = { at: string; offsets: string[] }
type Toggle = { at: string; branches: [string[], string[]] }
type Scan = { handles: Handle[]; toggles: Toggle[]; drifted: string[]; knobless: string[] }

/**
 * Handles are found *inside* a track element rather than by scanning source text forward, so
 * neither a sibling element nor a same-file icon can be mistaken for the knob.
 */
function collectFile(filePath: string, source: string, scan: Scan): void {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )

  const at = (node: ts.Node): string => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return `${relative(RENDERER_ROOT, filePath)}:${line + 1}`
  }

  const readHandles = (node: ts.Node): void => {
    if (ts.isJsxOpeningLikeElement(node)) {
      const className = classNameOf(node)
      const tokens = className ? tokensIn(className) : []
      if (
        className &&
        HANDLE_SIZE.some((size) => hasAll(tokens, size)) &&
        tokens.includes(HANDLE_SHAPE)
      ) {
        scan.handles.push({ at: at(node), offsets: tokens.filter((token) => OFFSET.test(token)) })
        for (const branches of offsetBranches(className)) {
          scan.toggles.push({ at: at(node), branches })
        }
      }
    }
    ts.forEachChild(node, readHandles)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningLikeElement(node)) {
      const className = classNameOf(node)
      const tokens = className ? tokensIn(className) : []
      if (hasAll(tokens, TRACK)) {
        const drift = trackDrift(tokens)
        if (drift) {
          scan.drifted.push(`${at(node)}: ${drift}`)
        }
        // The knob lives in the track's subtree; a self-closing track has no subtree to walk.
        const found = scan.handles.length
        if (ts.isJsxOpeningElement(node)) {
          readHandles(node.parent)
        }
        // A track whose knob moved into a child component would otherwise leave the scan silently.
        if (scan.handles.length === found) {
          scan.knobless.push(at(node))
        }
        return
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

let cached: Scan | undefined

/** Parsing every gated file is the expensive part, so all three assertions share one scan. */
function scanRenderer(): Scan {
  if (!cached) {
    const scan: Scan = { handles: [], toggles: [], drifted: [], knobless: [] }

    for (const filePath of collectSourceFiles(RENDERER_ROOT)) {
      const source = readFileSync(filePath, 'utf8')
      if (TRACK.every((token) => source.includes(token))) {
        collectFile(filePath, source, scan)
      }
    }

    // A track nested inside another h-5 w-9 element would otherwise be collected twice.
    const seen = new Set<string>()
    scan.handles = scan.handles.filter((handle) => !seen.has(handle.at) && seen.add(handle.at))
    cached = scan
  }

  // A scan that stops finding switches has lost its bounds, not proven the tree clean. The
  // floor only has to catch a collapse — `knobless` and `drifted` catch the structural cases —
  // so it sits well under the ~34 handles in the tree rather than pinning the current count.
  expect(cached.handles.length, 'the switch scan lost its bounds').toBeGreaterThan(25)

  return cached
}

describe('toggle switch handle alignment', () => {
  it('insets the handle by 2px at both ends of the track', () => {
    const offenders = scanRenderer().handles.flatMap((handle) =>
      handle.offsets.length === 0
        ? [`${handle.at}: no translate-x offset`]
        : handle.offsets
            .filter((offset) => offset !== OFF_STATE && offset !== ON_STATE)
            .map((offset) => `${handle.at}: ${offset}`)
    )

    expect(offenders).toEqual([])
  })

  it('gives every toggling handle both ends of the pair', () => {
    const pairs = (on: string[], off: string[]): boolean =>
      on.length === 1 && on[0] === ON_STATE && off.length === 1 && off[0] === OFF_STATE

    const offenders = scanRenderer()
      .toggles.filter(({ branches: [a, b] }) => !pairs(a, b) && !pairs(b, a))
      .map(
        ({ at, branches }) => `${at}: ${branches.map((side) => side.join(' ') || '—').join(' / ')}`
      )

    expect(offenders).toEqual([])
  })

  it('keeps every track on the geometry the 18px on-state is derived from', () => {
    expect(scanRenderer().drifted).toEqual([])
  })

  it('keeps every track a knob the scan can see', () => {
    expect(scanRenderer().knobless).toEqual([])
  })
})
