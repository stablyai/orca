// @vitest-environment happy-dom

import { act, type JSX, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS, type FeatureTip } from '../../../../shared/feature-tips'
import { NativeChatUpgradeTipDialog } from './NativeChatUpgradeTipDialog'

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

describe('NativeChatUpgradeTipDialog', () => {
  it('dismisses with Leave Off and runs the primary action only with Enable Now', () => {
    const onPrimaryAction = vi.fn()
    const onOpenChange = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(dialog(false, onPrimaryAction, onOpenChange)))
    const buttons = container.querySelectorAll<HTMLButtonElement>('footer button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.textContent).toBe('Leave Off')
    expect(buttons[0]?.hasAttribute('data-variant')).toBe(false)
    expect(buttons[1]?.textContent).toBe('Enable Now')
    expect(buttons[1]?.getAttribute('data-variant')).toBe('default')
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
})
