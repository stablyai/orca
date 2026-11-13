// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProcess } from '@orca/process-host'

const mocks = vi.hoisted(() => ({ runWorktreeDelete: vi.fn() }))
vi.mock('../../../sidebar/workspace-actions/deletion/delete-worktree-flow', () => mocks)
vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { deleteStateByWorktreeId: object }) => unknown) =>
    selector({ deleteStateByWorktreeId: {} })
}))

import { SourceControlMergedReviewNotice } from './merged-review-workspace-notice'
import { makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'

it('requires the ignored-file confirmation for an ignored-only merged checkout', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'merged-notice-'))
  const container = document.createElement('div')
  const root = createRoot(container)
  const git = async (args: string[]) => {
    const result = await runProcess({ program: 'git', args, cwd: directory })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  }
  try {
    await git(['init', '--quiet'])
    await writeFile(path.join(directory, '.gitignore'), '.env\n')
    await git(['add', '.gitignore'])
    await git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'initial'
    ])
    await writeFile(path.join(directory, '.env'), 'LOCAL_ONLY=value\n')
    const head = await git(['rev-parse', 'HEAD'])
    const status = await git(['status', '--porcelain'])
    expect(status).toBe('')
    const worktree = makeWorktree('ignored-only', 'Ignored only', {
      path: directory,
      instanceId: 'original'
    })
    await act(async () =>
      root.render(
        <SourceControlMergedReviewNotice
          review={{
            provider: 'github',
            number: 1,
            state: 'merged',
            headSha: head,
            title: '',
            url: '',
            status: 'success',
            updatedAt: '',
            mergeable: 'UNKNOWN'
          }}
          worktree={worktree}
          statusHeadOid={head}
          uncommittedCount={0}
        />
      )
    )
    await act(async () => container.querySelector('button')?.click())
    expect(mocks.runWorktreeDelete).toHaveBeenCalledWith('ignored-only', {
      expectedHostId: undefined,
      expectedInstanceId: 'original',
      forceConfirm: true
    })
  } finally {
    await act(async () => root.unmount())
    await rm(directory, { recursive: true, force: true })
  }
})
