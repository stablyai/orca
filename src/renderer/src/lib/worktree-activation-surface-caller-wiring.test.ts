import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: `providesInitialSurface: true` is invisible to behavior tests — every opted-out caller
// still works with the flag deleted, it just re-seeds a shell the user never asked for in a
// closed-last-terminal workspace. Three review rounds each found a missed caller, so this is
// the census: activation callers that open their own surface (editor, browser, diff, agent tab)
// must appear here, and adding or removing an opt-out anywhere must update this list.
const SURFACE_PROVIDING_CALLERS = [
  'src/renderer/src/components/editor/check-annotation-open.ts',
  'src/renderer/src/components/feature-wall/FeatureWallBrowserAction.tsx',
  'src/renderer/src/components/sidebar/NonGitFolderDialog.tsx',
  'src/renderer/src/components/sidebar/folder-workspace-composer-submit.ts',
  'src/renderer/src/components/sidebar/run-worktree-delete-with-toast.ts',
  'src/renderer/src/components/terminal-pane/terminal-file-open-routing.ts',
  'src/renderer/src/hooks/composer-state/full-creation-execution.ts',
  'src/renderer/src/lib/fix-checks-agent-launch.ts',
  'src/renderer/src/lib/launch-work-item-direct.ts',
  'src/renderer/src/lib/worktree-creation-flow-execute.ts',
  'src/renderer/src/lib/workspace-port-actions.ts',
  'src/renderer/src/store/repos/repo-add-actions.ts'
]

// The activation seam itself: declares the option and forwards it into the tombstone gate.
const SEAM_FILES = ['src/renderer/src/lib/worktree-activation.ts']

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath)
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      return []
    }
    return [fullPath]
  })
}

// Why: bound to an actual activation call so a comment or dead code containing the flag
// text cannot satisfy the census, and a variable-valued flag cannot hide in it. Comments
// are stripped first — commenting the flag out in place must fail this test.
const ACTIVATION_CALL_WITH_OPT_OUT =
  /activateAndReveal(?:Worktree|FolderWorkspace|Workspace)\([\s\S]*?providesInitialSurface: true/

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('providesInitialSurface caller wiring', () => {
  it.each(SURFACE_PROVIDING_CALLERS)('%s opts out of tombstone re-seeding', (relativePath) => {
    const source = stripComments(readFileSync(join(process.cwd(), relativePath), 'utf8'))
    expect(source).toMatch(ACTIVATION_CALL_WITH_OPT_OUT)
  })

  it('the census matches every mention under src/', () => {
    const root = join(process.cwd(), 'src')
    const mentions = listSourceFiles(root)
      .filter((filePath) => readFileSync(filePath, 'utf8').includes('providesInitialSurface'))
      .map((filePath) => relative(process.cwd(), filePath).split(sep).join('/'))
      .sort()
    expect(mentions).toEqual([...SURFACE_PROVIDING_CALLERS, ...SEAM_FILES].sort())
  })
})
