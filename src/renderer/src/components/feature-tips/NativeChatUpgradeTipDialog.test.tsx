import type { ReactNode } from 'react'
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

function renderDialog(chatModeOn: boolean): string {
  return renderToStaticMarkup(
    <NativeChatUpgradeTipDialog
      open
      tip={getTip()}
      primaryBusy={false}
      chatModeOn={chatModeOn}
      onOpenChange={() => {}}
      onPrimaryAction={() => {}}
      onChatModeChange={() => {}}
      onSettingsClick={() => {}}
    />
  )
}

describe('NativeChatUpgradeTipDialog', () => {
  it('shows the approved copy with one Got it button and the Experimental settings link', () => {
    const text = textOf(renderDialog(true))
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
    expect(renderDialog(true)).toContain('27rem')
  })

  it('offers chat mode, in a taller tip, when new agent tabs still open in the terminal', () => {
    const html = renderDialog(false)
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

  it('pictures both real menu actions, one at a time', () => {
    const html = renderToStaticMarkup(<NativeChatUpgradeFeatureTipVisual />)
    expect(html).toContain('Agent Session History')
    expect(html).toMatch(/data-highlighted="true"[^>]*>.*Resume in New CLI/)
    expect(html).not.toContain('Resume in New Native Chat')
  })
})
