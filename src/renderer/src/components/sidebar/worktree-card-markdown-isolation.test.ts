import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererSrc = join(__dirname, '../..')
const entry = join(rendererSrc, 'main.tsx')
const COMMENT_MARKDOWN = join(rendererSrc, 'components/sidebar/CommentMarkdown.tsx')

function source(relativePath: string): string {
  return readFileSync(join(rendererSrc, relativePath), 'utf8')
}

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

function resolveImport(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(rendererSrc, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null
  if (base === null) {
    return null
  }
  for (const extension of ['', ...MODULE_EXTENSIONS]) {
    const candidate = base + extension
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = join(base, `index${extension}`)
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

// Static `from '...'` edges only; `import('...')` and `import type` do not ship
// code onto the eager graph.
const STATIC_IMPORT =
  /(?:^|[\n;])\s*(?:import|export)(?:(?!\bfrom\b)[\s\S])*?\bfrom\s*['"]([^'"]+)['"]/g

/** Walks the renderer entry's static import graph, recording how each module was reached. */
function eagerModuleGraph(): Map<string, string | null> {
  const parents = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.shift() as string
    const contents = readFileSync(current, 'utf8')
    for (const match of contents.matchAll(STATIC_IMPORT)) {
      if (/^\s*(?:import|export)\s+type\b/.test(match[0].replace(/^[\n;]/, ''))) {
        continue
      }
      const resolved = resolveImport(match[1], current)
      if (resolved === null || parents.has(resolved)) {
        continue
      }
      parents.set(resolved, current)
      queue.push(resolved)
    }
  }
  return parents
}

function importChain(parents: Map<string, string | null>, module: string): string[] {
  const chain: string[] = []
  let cursor: string | null | undefined = module
  while (cursor) {
    chain.push(cursor.slice(rendererSrc.length + 1))
    cursor = parents.get(cursor)
  }
  return chain.toReversed()
}

describe('worktree card markdown performance isolation', () => {
  it('keeps CommentMarkdown off the renderer boot graph entirely', () => {
    const parents = eagerModuleGraph()

    // Names the offending chain when this regresses, instead of a bare boolean.
    const chain = parents.has(COMMENT_MARKDOWN) ? importChain(parents, COMMENT_MARKDOWN) : []
    expect(chain).toEqual([])
    expect(parents.size).toBeGreaterThan(1000)
  })

  it('routes both sidebar markdown surfaces through the shared lazy boundary', () => {
    const lazyBoundary = source('components/sidebar/comment-markdown-lazy.tsx')
    expect(lazyBoundary).toContain("import('./CommentMarkdown')")
    // A fallback in the same box keeps first paint from shifting layout.
    expect(lazyBoundary).toContain('React.Suspense')

    for (const file of [
      'components/sidebar/WorktreeCardMeta.tsx',
      'components/dashboard/DashboardAgentRowMessage.tsx'
    ]) {
      const contents = source(file)
      expect(contents).not.toMatch(/^import CommentMarkdown from/m)
      expect(contents).toContain('CommentMarkdownAsync')
      // The chunk must be warmed before the surface renders, not on demand.
      expect(contents).toContain('preloadCommentMarkdown')
    }
  })
})
