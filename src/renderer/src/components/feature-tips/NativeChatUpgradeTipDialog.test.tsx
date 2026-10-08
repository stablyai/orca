// @vitest-environment happy-dom

import { act, type JSX, type ReactNode, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS, type FeatureTip } from '../../../../shared/feature-tips'
import { NativeChatUpgradeTipDialog } from './NativeChatUpgradeTipDialog'

const dialogContentPropsMock = vi.hoisted(() => vi.fn())

vi.mock('./NativeChatUpgradeFeatureTipVisual', () => ({
  NativeChatUpgradeFeatureTipVisual: () => <div data-testid="native-chat-upgrade-visual" />
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    ...props
  }: {
    children: ReactNode
    onOpenAutoFocus?: (event: Event) => void
  }) => {
    dialogContentPropsMock(props)
    return <div>{children}</div>
  },
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))

vi.mock('./FeatureTipActions', () => ({
  FeatureTipActions: ({
    label,
    showSkip,
    primaryButtonRef
  }: {
    label: string
    showSkip: boolean
    primaryButtonRef?: RefObject<HTMLButtonElement | null>
  }) => (
    <button ref={primaryButtonRef} data-testid="feature-tip-actions" data-skip={String(showSkip)}>
      {label}
    </button>
  )
}))

function getTip(): FeatureTip {
  const tip = FEATURE_TIPS.find((entry) => entry.id === 'native-chat-upgrade')
  if (!tip) {
    throw new Error('Expected native-chat-upgrade feature tip')
  }
  return tip
}

function renderDialog(tip: FeatureTip): JSX.Element {
  return (
    <NativeChatUpgradeTipDialog
      open
      tip={tip}
      primaryBusy={false}
      onOpenChange={vi.fn()}
      onPrimaryAction={vi.fn()}
      onSettingsClick={vi.fn()}
    />
  )
}

describe('NativeChatUpgradeTipDialog', () => {
  it('explains both Resume actions honestly and points at Chat settings', () => {
    const tip = getTip()
    const markup = renderToStaticMarkup(renderDialog(tip))

    expect(markup).toContain('native-chat-upgrade-visual')
    expect(markup).toContain(tip.title)
    expect(markup).toContain('In Agent Session History, in the right sidebar:')
    expect(markup).toContain('Resume in New Native Chat')
    expect(markup).toContain('moves a CLI session into a chat.')
    expect(markup).toContain('Resume in New CLI')
    expect(markup).toContain(
      'copies a Claude or Codex chat into a new CLI session. The chat stays as it is.'
    )
    expect(markup).toContain('Settings → Chat')
    expect(markup).toContain('data-skip="false"')
    expect(markup).toContain('Got it')
  })

  it('opens with the title at the top and Got it focused outside the scrolling copy', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(renderDialog(getTip())))
    const copy = container.querySelector('[data-testid="native-chat-upgrade-tip-copy"]')
    const button = container.querySelector<HTMLButtonElement>('[data-testid="feature-tip-actions"]')
    if (!copy || !button) {
      throw new Error('Expected the tip copy and the primary action button')
    }
    const focus = vi.spyOn(button, 'focus')
    const event = new Event('focus', { cancelable: true })

    dialogContentPropsMock.mock.lastCall?.[0].onOpenAutoFocus(event)

    expect(event.defaultPrevented).toBe(true)
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    expect(document.activeElement).toBe(button)
    const viewport = copy.querySelector('[data-slot="scroll-area-viewport"]')
    expect(viewport?.scrollTop).toBe(0)
    // The copy scrolls on its own only from md; below md it keeps its height and the column scrolls.
    expect(copy.classList.contains('md:flex-1')).toBe(true)
    expect(copy.classList.contains('flex-1')).toBe(false)
    expect(viewport?.classList.contains('md:flex-1')).toBe(true)
    expect(copy.contains(container.querySelector('h1'))).toBe(true)
    expect(copy.contains(container.querySelector('footer'))).toBe(false)
    expect(container.querySelector('footer')?.contains(button)).toBe(true)

    await act(async () => root.unmount())
    container.remove()
  })
})
