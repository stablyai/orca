/**
 * Issue #8903 — Cmd-J jump palette leaves keyboard focus on the wrong surface.
 *
 * After selecting a workspace, WorktreeJumpPalette calls
 * focusFallbackSurface() with NO preferred target, which resolves to
 * document.querySelector('.xterm-helper-textarea') — the first match in the
 * DOM. Inactive workspaces stay mounted (display:none), so the first xterm is
 * often a hidden workspace's terminal.
 *
 * Re-run:
 *   pnpm exec vitest run src/renderer/src/components/cmd-j/repro-8903-cmdj-focus-fallback.test.ts
 */
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePaletteFocusRestoreTarget } from './palette-focus-restore-target'

afterEach(() => {
  document.body.innerHTML = ''
})

function addTerminal(id: string, options?: { hidden?: boolean }): HTMLTextAreaElement {
  const wrap = document.createElement('div')
  if (options?.hidden) {
    wrap.style.display = 'none'
    wrap.dataset.worktree = 'background'
  } else {
    wrap.dataset.worktree = 'active'
  }
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  textarea.dataset.terminal = id
  wrap.appendChild(textarea)
  document.body.appendChild(wrap)
  return textarea
}

describe('#8903 Cmd-J focus falls back to first DOM xterm (often hidden)', () => {
  it('resolvePaletteFocusRestoreTarget(null) returns the first mounted xterm, not the visible one', () => {
    const hidden = addTerminal('hidden-background', { hidden: true })
    const visible = addTerminal('visible-destination')

    // Enter path in WorktreeJumpPalette: focusFallbackSurface() with no preferredTarget
    const target = resolvePaletteFocusRestoreTarget(null)

    expect(target).toBe(hidden)
    expect(target).not.toBe(visible)
    expect(target?.closest('[data-worktree]')?.getAttribute('data-worktree')).toBe('background')
  })

  it('source: handleSelectWorktree calls focusFallbackSurface() without a preferred element', () => {
    const source = readFileSync(join(__dirname, '../WorktreeJumpPalette.tsx'), 'utf8')
    // Destination jump skips previous-focus restore then generic-falls back.
    expect(source).toMatch(/skipRestoreFocusRef\.current\s*=\s*true/)
    expect(source).toMatch(/focusFallbackSurface\(\)/)
    // The generic resolver used by focusFallbackSurface
    expect(source).toContain('resolvePaletteFocusRestoreTarget')
  })

  it('source: resolvePaletteFocusRestoreTarget uses unscoped querySelector for xterm', () => {
    const source = readFileSync(join(__dirname, './palette-focus-restore-target.ts'), 'utf8')
    expect(source).toContain("doc.querySelector('.xterm-helper-textarea')")
    // Comments in-source already acknowledge background worktree risk
    expect(source).toMatch(/background worktree|mounted-but-hidden/i)
  })

  it('Esc path only restores when preferred target is still connected; else first DOM xterm', () => {
    const first = addTerminal('first')
    const second = addTerminal('second')
    const detached = document.createElement('textarea')
    detached.className = 'xterm-helper-textarea'

    expect(resolvePaletteFocusRestoreTarget(second)).toBe(second)
    expect(detached.isConnected).toBe(false)
    expect(resolvePaletteFocusRestoreTarget(detached)).toBe(first)
  })
})
