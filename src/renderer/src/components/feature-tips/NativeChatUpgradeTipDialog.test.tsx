// @vitest-environment happy-dom

import { act, type JSX, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS, type FeatureTip } from '../../../../shared/feature-tips'
import { NativeChatUpgradeTipDialog } from './NativeChatUpgradeTipDialog'
import { NativeChatUpgradeFeatureTipVisual } from './NativeChatUpgradeFeatureTipVisual'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))

function getTip(): FeatureTip {
  const tip = FEATURE_TIPS.find((entry) => entry.id === 'native-chat-upgrade')
  if (!tip) {
    throw new Error('Expected native-chat-upgrade feature tip fixture')
  }
  return tip
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
}

// Why: repo convention — React only suppresses its act() warning when this global is set.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function dialog(
  chatModeOn: boolean,
  onPrimaryAction = (): void => {},
  onOpenChange = (_open: boolean): void => {},
  primaryBusy = false
): JSX.Element {
  return (
    <NativeChatUpgradeTipDialog
      open
      tip={getTip()}
      primaryBusy={primaryBusy}
      chatModeOn={chatModeOn}
      onOpenChange={onOpenChange}
      onPrimaryAction={onPrimaryAction}
      onSettingsClick={() => {}}
    />
  )
}

function renderDialog(chatModeOn: boolean): string {
  return renderToStaticMarkup(dialog(chatModeOn))
}

describe('NativeChatUpgradeTipDialog', () => {
  it('shows the approved copy with one Got It button and the Experimental settings link', () => {
    const text = textOf(renderDialog(true))
    expect(text).toContain('NEW')
    expect(text).toContain('Native chat got an upgrade')
    expect(text).toContain(
      'New chats with supported agents now open in the upgraded chat view. To move between chat and CLI, open Agent Session History in the right sidebar:'
    )
    expect(text).toContain('Resume in New Chat opens a supported CLI conversation in native chat.')
    expect(text).toContain(
      'Resume in New Terminal copies a Claude or Codex chat into a new CLI session. The original chat stays as it is.'
    )
    expect(text).toContain('Manage Chat UI in Settings → Experimental.')
    expect(text).toContain('Got It')
    expect(text).not.toContain('Maybe Later')
    expect(text).not.toContain('Turn on chat mode')
    expect(renderDialog(true)).toContain('27rem')
  })

  it('shows only Got It when chat mode is already on', () => {
    const html = renderDialog(true)
    const text = textOf(html)
    expect(text).not.toContain('Turn on chat mode')
    expect(text).not.toContain('Enable Now')
    expect(text).not.toContain('Leave Off')
    expect(html).not.toContain('role="switch"')
  })

  it('offers Leave Off and Enable Now when chat mode is off, without a switch', () => {
    const html = renderDialog(false)
    const text = textOf(html)
    expect(text).toContain('Leave Off')
    expect(text).toContain('Enable Now')
    expect(text).not.toContain('Got It')
    expect(text).not.toContain('Turn on chat mode')
    expect(html).not.toContain('role="switch"')
    expect(html).toContain('27rem')
    // The way back to the terminal stays in the tip.
    expect(text).toContain('Resume in New Terminal copies a Claude or Codex chat')
  })

  it('dismisses with Leave Off and runs the primary action only with Enable Now', () => {
    const onPrimaryAction = vi.fn()
    const onOpenChange = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(dialog(false, onPrimaryAction, onOpenChange)))
    const buttons = container.querySelectorAll<HTMLButtonElement>('footer button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.textContent).toBe('Leave Off')
    // Leave Off is plain text, not a Button primitive.
    expect(buttons[0]?.hasAttribute('data-variant')).toBe(false)
    expect(buttons[1]?.textContent).toBe('Enable Now')
    expect(buttons[1]?.getAttribute('data-variant')).toBe('default')
    // Enable Now takes the row width Leave Off leaves.
    expect(buttons[1]?.classList.contains('flex-1')).toBe(true)
    expect(buttons[0]?.classList.contains('flex-1')).toBe(false)
    act(() => buttons[0]?.click())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onPrimaryAction).not.toHaveBeenCalled()
    act(() => buttons[1]?.click())
    expect(onPrimaryAction).toHaveBeenCalledOnce()
    act(() => root.render(dialog(false, onPrimaryAction, onOpenChange, true)))
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('footer button')).every(
        (b) => b.disabled
      )
    ).toBe(true)
    act(() => root.render(dialog(true, onPrimaryAction, onOpenChange)))
    expect(container.querySelectorAll('footer button')).toHaveLength(1)
    expect(container.querySelector('footer button')?.textContent).toBe('Got It')
    expect(container.querySelector('[role="switch"]')).toBeNull()
    act(() => root.unmount())
  })

  it('pictures both real menu actions, one at a time', () => {
    const html = renderToStaticMarkup(<NativeChatUpgradeFeatureTipVisual />)
    expect(html).toContain('Agent Session History')
    expect(html).toMatch(/data-highlighted="true"[^>]*>.*Resume in New Terminal/)
    expect(html).not.toContain('Resume in New Chat')
  })
})
