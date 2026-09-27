import type { Page } from '@stablyai/playwright-test'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  seedOrdinaryRowsAboveLineage,
  seedVirtualLineage
} from './sidebar-lineage-virtualization-state'

export async function prepareRenameTyping(
  page: Page,
  targetId: string,
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference'
) {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await seedVirtualLineage(page, false)
  if (targetId.startsWith('ordinary-')) {
    await seedOrdinaryRowsAboveLineage(page)
  }
  await page.evaluate((targetId) => {
    window.__store!.setState((state) => ({
      activeWorktreeId: targetId,
      activeWorkspaceKey: `worktree:${targetId}`,
      pendingRevealWorktree: null,
      keybindings: { ...state.keybindings, 'workspace.rename': ['Mod+Alt+R'] }
    }))
  }, targetId)
  await page.emulateMedia({ reducedMotion })
  const scroller = page.locator('[data-worktree-sidebar]')
  await scroller.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }))
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    // Terminal context keeps the real global shortcut enabled without sending text to a PTY.
    const terminal = document.createElement('textarea')
    terminal.className = 'xterm-helper-textarea'
    terminal.id = 'rename-typing-terminal'
    terminal.style.cssText = 'position:fixed;left:0;bottom:0;width:10px;height:10px;opacity:0'
    document.body.append(terminal)
    terminal.focus()
  })
}

export async function recordRenameMotion(page: Page) {
  return page.evaluateHandle(() => {
    const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
    const started = performance.now()
    const frames: { time: number; top: number }[] = []
    const writes: { time: number; from: number; top: number; behavior?: string }[] = []
    const inputs: number[] = []
    const descriptor = Object.getOwnPropertyDescriptor(scroller, 'scrollTo')
    const scrollTo = scroller.scrollTo.bind(scroller)
    scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      if (typeof options === 'number') {
        scrollTo(options, y ?? 0)
      } else {
        writes.push({
          time: performance.now() - started,
          from: scroller.scrollTop,
          top: options?.top ?? scroller.scrollTop,
          behavior: options?.behavior
        })
        scrollTo(options)
      }
    }
    const onInput = () => inputs.push(performance.now() - started)
    scroller.addEventListener('input', onInput, true)
    let focusedAt: number | null = null
    let frame = 0
    const focus = (event: FocusEvent) => {
      if (
        event.target instanceof Element &&
        event.target.matches('[data-worktree-title-rename-input]')
      ) {
        focusedAt ??= performance.now() - started
      }
    }
    const sample = () => {
      frames.push({ time: performance.now() - started, top: scroller.scrollTop })
      frame = requestAnimationFrame(sample)
    }
    document.addEventListener('focusin', focus, true)
    frame = requestAnimationFrame(sample)
    return {
      finish() {
        cancelAnimationFrame(frame)
        document.removeEventListener('focusin', focus, true)
        scroller.removeEventListener('input', onInput, true)
        if (descriptor) {
          Object.defineProperty(scroller, 'scrollTo', descriptor)
        } else {
          Reflect.deleteProperty(scroller, 'scrollTo')
        }
        return { focusedAt, frames, writes, inputs }
      }
    }
  })
}
