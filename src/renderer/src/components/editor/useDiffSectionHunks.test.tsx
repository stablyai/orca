// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getPatch: vi.fn() }))
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitFileDiffPatch: mocks.getPatch
}))

import { useDiffSectionHunks } from './useDiffSectionHunks'
import type { ParsedFileDiff } from '../../../../shared/git-hunk-patch'

const PATCH = [
  'diff --git a/foo.ts b/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,2 +1,3 @@',
  ' a',
  '+b',
  ' c',
  ''
].join('\n')

type Props = Parameters<typeof useDiffSectionHunks>[0]
const BASE: Props = {
  enabled: true,
  worktreeId: 'wt',
  worktreePath: '/repo',
  connectionId: undefined,
  settings: null,
  filePath: 'foo.ts',
  staged: false,
  contentGeneration: 0
}

let latest: ParsedFileDiff | null = null
const roots: Root[] = []

function Probe(props: Props): null {
  latest = useDiffSectionHunks(props)
  return null
}

async function renderProbe(props: Props): Promise<void> {
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => {
    root.render(<Probe {...props} />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount())
  }
  roots.length = 0
  latest = null
  mocks.getPatch.mockReset()
})

describe('useDiffSectionHunks', () => {
  it('fetches and parses hunks when enabled', async () => {
    mocks.getPatch.mockResolvedValue(PATCH)
    await renderProbe(BASE)
    expect(latest?.hunks).toHaveLength(1)
    expect(mocks.getPatch).toHaveBeenCalledWith(
      { settings: null, worktreeId: 'wt', worktreePath: '/repo', connectionId: undefined },
      { filePath: 'foo.ts', staged: false }
    )
  })

  it('does not fetch and stays empty when disabled', async () => {
    await renderProbe({ ...BASE, enabled: false })
    expect(latest?.hunks).toHaveLength(0)
    expect(mocks.getPatch).not.toHaveBeenCalled()
  })

  it('falls back to empty hunks when the fetch fails', async () => {
    mocks.getPatch.mockRejectedValue(new Error('git.diffPatch unavailable'))
    await renderProbe(BASE)
    expect(latest?.hunks).toHaveLength(0)
  })
})
