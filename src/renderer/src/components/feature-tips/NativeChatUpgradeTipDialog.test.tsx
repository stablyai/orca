// @vitest-environment happy-dom

import { act, type JSX, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS, type FeatureTip } from '../../../../shared/feature-tips'
import type { NativeChatUpgradeTipVariant } from '../../../../shared/native-chat-upgrade-tip-audience'
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

function dialog(variant: NativeChatUpgradeTipVariant, chatModeOn: boolean): JSX.Element {
  return (
    <NativeChatUpgradeTipDialog
      open
      tip={getTip()}
      primaryBusy={false}
      variant={variant}
      chatModeOn={chatModeOn}
      onOpenChange={() => {}}
      onPrimaryAction={() => {}}
      onChatModeChange={() => {}}
      onSettingsClick={() => {}}
    />
  )
}

function renderDialog(variant: NativeChatUpgradeTipVariant, chatModeOn: boolean): string {
  return renderToStaticMarkup(dialog(variant, chatModeOn))
}

describe('NativeChatUpgradeTipDialog', () => {
  it('shows the approved copy with one Got it button and the Experimental settings link', () => {
    const text = textOf(renderDialog('standard', true))
    expect(text).toContain('NEW')
    expect(text).toContain('Native chat got an upgrade')
    expect(text).toContain(
      'New chats with supported agents now open in the upgraded chat view. To move between chat and CLI, open Agent Session History in the right sidebar:'
    )
    expect(text).toContain(
      'Resume in New Native Chat opens a supported CLI conversation in native chat.'
    )
    expect(text).toContain(
      'Resume in New CLI copies a Claude or Codex chat into a new CLI session. The original chat stays as it is.'
    )
    expect(text).toContain('Manage Chat UI in Settings → Experimental.')
    expect(text).toContain('Got it')
    expect(text).not.toContain('Maybe Later')
    expect(text).not.toContain('Turn on chat mode')
    expect(renderDialog('standard', true)).toContain('27rem')
  })

  it('never offers chat mode to a chat-view member, even with Chat UI turned off', () => {
    const html = renderDialog('standard', false)
    const text = textOf(html)
    expect(text).not.toContain('New agent tabs still open in the terminal')
    expect(text).not.toContain('Turn on chat mode')
    expect(html).not.toContain('role="switch"')
    expect(html).toContain('27rem')
    expect(html).not.toContain('33rem')
  })

  it('offers chat mode, in a taller tip, when new agent tabs still open in the terminal', () => {
    const html = renderDialog('keep-terminal', false)
    const text = textOf(html)
    expect(text).toContain('New agent tabs still open in the terminal, as before.')
    expect(text).toContain('Turn on chat mode')
    expect(text).toContain('New agent tabs open as chat instead.')
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('33rem')
    // The way back to the terminal stays in the tip.
    expect(text).toContain('Resume in New CLI copies a Claude or Codex chat')
  })

  it('keeps offering chat mode, switched on, when Chat UI was already on', () => {
    const html = renderDialog('keep-terminal', true)
    expect(textOf(html)).toContain('Turn on chat mode')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('33rem')
  })

  it('keeps the switch in place, now on, after it is flipped', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(dialog('keep-terminal', false)))
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    act(() => root.render(dialog('keep-terminal', true)))
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
    expect(container.textContent).toContain('New agent tabs still open in the terminal, as before.')
    expect(container.innerHTML).toContain('33rem')
    act(() => root.unmount())
  })

  it('pictures both real menu actions, one at a time', () => {
    const html = renderToStaticMarkup(<NativeChatUpgradeFeatureTipVisual />)
    expect(html).toContain('Agent Session History')
    expect(html).toMatch(/data-highlighted="true"[^>]*>.*Resume in New CLI/)
    expect(html).not.toContain('Resume in New Native Chat')
  })
})
