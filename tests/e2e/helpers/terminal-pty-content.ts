import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

export async function focusTerminalPaneForPtyId(page: Page, ptyId: string): Promise<void> {
  await page.evaluate((targetPtyId) => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      const pane = manager
        .getPanes?.()
        .find((candidate) => candidate.container?.dataset?.ptyId === targetPtyId)
      if (!pane) {
        continue
      }
      manager.setActivePane?.(pane.id, { focus: true })
      window.api.pty.setActiveRendererPty?.(targetPtyId, true)
      return
    }
    throw new Error(`Unable to focus terminal PTY ${targetPtyId}`)
  }, ptyId)
}

export async function focusTerminalInputForPtyId(page: Page, ptyId: string): Promise<void> {
  const focusTarget = async (): Promise<{ focused: boolean; visible: boolean }> =>
    page.evaluate((targetPtyId) => {
      for (const manager of window.__paneManagers?.values() ?? []) {
        const pane = manager
          .getPanes?.()
          .find((candidate) => candidate.container?.dataset?.ptyId === targetPtyId)
        const textarea =
          pane?.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
        if (!pane || !textarea) {
          continue
        }
        manager.setActivePane?.(pane.id, { focus: true })
        window.api.pty.setActiveRendererPty?.(targetPtyId, true)
        pane.terminal.focus()
        textarea.focus()
        const rect = pane.container.getBoundingClientRect()
        return {
          focused: document.activeElement === textarea,
          visible: rect.width > 0 && rect.height > 0
        }
      }
      throw new Error(`Terminal input is unavailable for PTY ${targetPtyId}`)
    }, ptyId)

  await focusTarget()
  await expect
    .poll(focusTarget, {
      timeout: 1_000,
      message: `Terminal input for PTY ${ptyId} did not stay focused and visible`
    })
    .toEqual({ focused: true, visible: true })
}

export async function getTerminalContentForPtyId(
  page: Page,
  ptyId: string,
  charLimit = 4_000
): Promise<string> {
  return page.evaluate(
    ({ ptyId: targetPtyId, charLimit: limit }) => {
      for (const manager of window.__paneManagers?.values() ?? []) {
        for (const pane of manager.getPanes?.() ?? []) {
          if (pane.container?.dataset?.ptyId === targetPtyId) {
            return (pane.serializeAddon?.serialize?.() ?? '').slice(-limit)
          }
        }
      }
      return ''
    },
    { ptyId, charLimit }
  )
}

export async function terminalDomTextIncludesMarker(
  page: Page,
  ptyId: string,
  marker: string
): Promise<boolean> {
  return page.evaluate(
    ({ marker, ptyId: targetPtyId }) => {
      for (const manager of window.__paneManagers?.values() ?? []) {
        for (const pane of manager.getPanes?.() ?? []) {
          if (pane.container?.dataset?.ptyId === targetPtyId) {
            return pane.container.textContent?.includes(marker) ?? false
          }
        }
      }
      return false
    },
    { marker, ptyId }
  )
}

const MARKER_SERIALIZE_POLL_CHAR_LIMIT = 12_000

export async function terminalOutputIncludesMarker(
  page: Page,
  ptyId: string,
  marker: string,
  includeSerializedBuffer: boolean
): Promise<boolean> {
  if (await terminalDomTextIncludesMarker(page, ptyId, marker)) {
    return true
  }
  return (
    includeSerializedBuffer &&
    (await getTerminalContentForPtyId(page, ptyId, MARKER_SERIALIZE_POLL_CHAR_LIMIT)).includes(
      marker
    )
  )
}

export async function readFocusedTerminalDebug(page: Page): Promise<{
  activeElementTag: string | null
  activeElementClass: string | null
  focusedPtyId: string | null
}> {
  return page.evaluate(() => {
    const active = document.activeElement
    const activeElement = active instanceof HTMLElement ? active : null
    const ptyElement = activeElement?.closest<HTMLElement>('[data-pty-id]') ?? null
    return {
      activeElementTag: activeElement?.tagName ?? null,
      activeElementClass: activeElement?.className ?? null,
      focusedPtyId: ptyElement?.dataset.ptyId ?? null
    }
  })
}
