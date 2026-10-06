import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Leaving the activity view is a user decision: the bell toggles the body, and only explicit
 * "show me this in the workspace list" requests switch it (activation only via showWorkspaceList).
 * Reveals must never write sidebarBody, or every incidental activation kicks the user out.
 */
const RENDERER_ROOT = path.resolve(import.meta.dirname, '../../..')

const SLICE_DEFINITION_FILES = [
  'store/slices/ui/ui-slice-contract-preferences.ts',
  'store/slices/ui/ui-slice-preference-actions.ts'
]

const BODY_WRITER_FILES = [
  // The bell toggle.
  'components/sidebar/SidebarHeader.tsx',
  // Explicit workspace-list requests.
  'components/sidebar/use-workspace-reveal-body-redirect.ts',
  'components/use-worktree-jump-palette-selection-actions.ts',
  'lib/worktree-activation.ts',
  'store/slices/ui/ui-slice-agent-actions.ts'
]

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        collectSourceFiles(full, out)
      }
      continue
    }
    if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function filesMatching(pattern: RegExp): string[] {
  return (
    collectSourceFiles(RENDERER_ROOT)
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      // Test harnesses stub the actions without being callers.
      .filter(({ source }) => pattern.test(source) && !source.includes("from 'vitest'"))
      .map(({ file }) => file)
      .map((file) => path.relative(RENDERER_ROOT, file).split(path.sep).join('/'))
      .sort()
  )
}

describe('sidebarBody writers', () => {
  it('only the slice defines sidebarBody state writes', () => {
    expect(filesMatching(/\bsidebarBody\s*:/)).toEqual(SLICE_DEFINITION_FILES)
  })

  it('only the bell toggle and explicit workspace-list requests call setSidebarBody', () => {
    expect(filesMatching(/\bsetSidebarBody\b/)).toEqual(
      [...SLICE_DEFINITION_FILES, ...BODY_WRITER_FILES].sort()
    )
  })
})
