import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS, type FeatureTip } from '../../../../shared/feature-tips'
import { NativeChatUpgradeTipDialog } from './NativeChatUpgradeTipDialog'
import { NativeChatUpgradeFeatureTipVisual } from './NativeChatUpgradeFeatureTipVisual'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

describe('NativeChatUpgradeTipDialog', () => {
  it('shows the approved copy with one Got it button and the Experimental settings link', () => {
    const text = textOf(
      renderToStaticMarkup(
        <NativeChatUpgradeTipDialog
          open
          tip={getTip()}
          primaryBusy={false}
          onOpenChange={() => {}}
          onPrimaryAction={() => {}}
          onSettingsClick={() => {}}
        />
      )
    )
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
  })

  it('pictures both real menu actions, one at a time', () => {
    const html = renderToStaticMarkup(<NativeChatUpgradeFeatureTipVisual />)
    expect(html).toContain('Agent Session History')
    expect(html).toMatch(/data-highlighted="true"[^>]*>.*Resume in New CLI/)
    expect(html).not.toContain('Resume in New Native Chat')
  })
})
