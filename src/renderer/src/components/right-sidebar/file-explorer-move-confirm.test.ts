import { describe, expect, it } from 'vitest'
import {
  formatFileExplorerMovePath,
  shouldConfirmFileExplorerMove
} from './file-explorer-move-confirm'

describe('shouldConfirmFileExplorerMove', () => {
  it('never prompts when mode is never or unset', () => {
    expect(shouldConfirmFileExplorerMove('never', true)).toBe(false)
    expect(shouldConfirmFileExplorerMove('never', false)).toBe(false)
    expect(shouldConfirmFileExplorerMove(undefined, true)).toBe(false)
    expect(shouldConfirmFileExplorerMove(null, false)).toBe(false)
  })

  it('prompts only for directories in directories mode', () => {
    expect(shouldConfirmFileExplorerMove('directories', true)).toBe(true)
    expect(shouldConfirmFileExplorerMove('directories', false)).toBe(false)
  })

  it('always prompts when mode is always', () => {
    expect(shouldConfirmFileExplorerMove('always', true)).toBe(true)
    expect(shouldConfirmFileExplorerMove('always', false)).toBe(true)
  })
})

describe('formatFileExplorerMovePath', () => {
  it('returns paths relative to the worktree root', () => {
    expect(formatFileExplorerMovePath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(formatFileExplorerMovePath('C:\\repo\\src\\a.ts', 'C:\\repo')).toBe('src\\a.ts')
  })

  it('falls back to the absolute path when outside the worktree', () => {
    expect(formatFileExplorerMovePath('/other/file.ts', '/repo')).toBe('/other/file.ts')
  })
})
