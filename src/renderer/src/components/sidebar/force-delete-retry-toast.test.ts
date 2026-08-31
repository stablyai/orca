/**
 * STA-4895 guard: the explicit "Force Delete" retry is the one delete a user can reach from three
 * separate surfaces, and it is the delete whose failures carry the main process's English wire
 * anchors. Four leaks shipped because each surface was patched one at a time, so this asserts the
 * property structurally: every site that spends the PTY-stop waiver reports through the funnel.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import { WORKSPACE_DIRECTORY_HELD_HINT } from '../../../../shared/worktree/removal'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const { settleForceDeleteRetry } = await import('./force-delete-retry-toast')

const RENDERER_ROOT = join(__dirname, '..', '..')
/** The waiver only an explicit Force Delete may spend — so it names that call and nothing else. */
const FORCE_DELETE_WAIVER = 'allowUnverifiedPtyStop: true'
const FUNNEL_IMPORT = 'force-delete-retry-toast'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(path)
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) {
      return []
    }
    return [path]
  })
}

describe('every explicit Force Delete retry reports through the copy funnel', () => {
  const waiverSites = sourceFiles(RENDERER_ROOT)
    .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => source.includes(FORCE_DELETE_WAIVER))

  it('scans the surfaces that spend the PTY-stop waiver', () => {
    // Guards the sweep itself: a broken walk would pass every assertion below vacuously.
    expect(waiverSites.map(({ path }) => path.slice(RENDERER_ROOT.length + 1)).sort()).toEqual([
      'components/sidebar/delete-worktree-dialog-force-delete.ts',
      'components/sidebar/run-worktree-delete-with-toast.ts',
      'components/status-bar/workspace-space-force-delete.ts'
    ])
  })

  it('leaves no site rendering its own failure copy', () => {
    const unfunnelled = waiverSites
      .filter(({ source }) => !source.includes(FUNNEL_IMPORT))
      .map(({ path }) => path.slice(RENDERER_ROOT.length + 1))
    expect(unfunnelled).toEqual([])
  })
})

describe('settleForceDeleteRetry', () => {
  const HELD_ERROR = `Failed to force delete worktree at C:\\ws\\feature. EBUSY: resource busy or locked, rmdir 'C:\\ws\\feature' ${WORKSPACE_DIRECTORY_HELD_HINT}`

  function lastToast(): { title: string; description?: string } {
    const call = toastError.mock.calls.at(-1)
    return {
      title: call?.[0] as string,
      description: (call?.[1] as { description?: string })?.description
    }
  }

  it('titles a rejected retry as the force delete it was', async () => {
    toastError.mockClear()
    await settleForceDeleteRetry(Promise.reject(new Error(HELD_ERROR)), {
      worktreeName: 'feature',
      onDeleted: vi.fn()
    })
    expect(lastToast().title).toBe(
      translate('auto.components.sidebar.delete.worktree.flow.4f3876c0f5', 'MISSING')
    )
    expect(lastToast().description).toBe(
      translate('auto.components.sidebar.delete.worktree.toast.workspaceDirectoryHeld', 'MISSING')
    )
  })

  it('reports a success to its caller without a toast', async () => {
    toastError.mockClear()
    const onDeleted = vi.fn()
    await settleForceDeleteRetry(Promise.resolve({ ok: true }), {
      worktreeName: 'feature',
      onDeleted
    })
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })
})
