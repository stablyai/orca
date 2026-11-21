import type * as NodeFs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTree, removeTreeSync } from './windows-transient-lock-removal'

const rmSync = vi.hoisted(() => vi.fn())

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, rmSync }
})

describe('removeTree empty path', () => {
  beforeEach(() => {
    rmSync.mockReset()
  })

  it('never forwards an empty path to rm, which Bun on Windows resolves to the cwd', async () => {
    const rm = vi.fn(async () => {})
    await removeTree('', { rm })
    await removeTree('/tmp/orca-remove-tree-missing', { rm })
    expect(rm.mock.calls).toEqual([
      ['/tmp/orca-remove-tree-missing', { recursive: true, force: true }]
    ])
  })

  it('never forwards an empty path to rmSync', () => {
    removeTreeSync('')
    removeTreeSync('/tmp/orca-remove-tree-missing')
    expect(rmSync.mock.calls.map(([path]) => path)).toEqual(['/tmp/orca-remove-tree-missing'])
  })
})
