import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS, type FeatureTip } from '../../../../shared/feature-tips'
import { CmdJPaletteTipDialog } from './CmdJPaletteTipDialog'

const shortcutLabelMock = vi.hoisted(() => vi.fn(() => '⌘J'))
const formatShortcutLabelMock = vi.hoisted(() => vi.fn(() => '⌘J'))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: shortcutLabelMock,
  formatShortcutLabel: formatShortcutLabelMock
}))

vi.mock('./CmdJPaletteFeatureTipVisual', () => ({
  CmdJPaletteFeatureTipVisual: () => <div data-testid="palette-visual" />
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))

vi.mock('./FeatureTipActions', () => ({
  FeatureTipActions: () => <div data-testid="feature-tip-actions" />
}))

function getCmdJPaletteTip(): FeatureTip {
  const tip = FEATURE_TIPS.find((entry) => entry.id === 'cmd-j-palette')
  if (!tip) {
    throw new Error('Expected cmd-j-palette feature tip fixture')
  }
  return { ...tip }
}

const paletteTip = getCmdJPaletteTip()

function renderDialog(): string {
  return renderToStaticMarkup(
    <CmdJPaletteTipDialog
      open
      tip={paletteTip}
      primaryBusy={false}
      onOpenChange={vi.fn()}
      onPrimaryAction={vi.fn()}
      onSkip={vi.fn()}
      onRebindClick={vi.fn()}
    />
  )
}

describe('CmdJPaletteTipDialog', () => {
  it('shows a tip badge so the dialog reads as education, not a new feature', () => {
    const html = renderDialog()

    expect(html).toContain('TIP')
  })

  it('inlines the live shortcut label in the title', () => {
    shortcutLabelMock.mockReturnValue('⌘J')

    const html = renderDialog()

    expect(html).toContain('Jump to a worktree with')
    expect(html).toContain('⌘J')
  })

  it('falls back to the default shortcut label when the binding is unassigned', () => {
    shortcutLabelMock.mockReturnValue('Unassigned')
    formatShortcutLabelMock.mockReturnValue('Ctrl+Shift+J')

    const html = renderDialog()

    expect(formatShortcutLabelMock).toHaveBeenCalledWith('worktree.palette')
    expect(html).toContain('Ctrl+Shift+J')
    expect(html).not.toContain('Unassigned')
  })

  it('keeps the rebind guidance inside the dialog description', () => {
    const html = renderDialog()

    expect(html).toContain('Settings → Shortcuts')
    expect(html).toContain('spin up a new worktree')
  })
})
