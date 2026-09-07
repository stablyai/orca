// @vitest-environment happy-dom

import { act, type ReactNode, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS, type FeatureTip } from '../../../../shared/feature-tips'
import { VoiceDictationTipDialog } from './VoiceDictationTipDialog'

const shortcutMock = vi.hoisted(() => vi.fn(() => ({ keys: ['⌘', 'E'], doubleTap: false })))
const dialogContentPropsMock = vi.hoisted(() => vi.fn())
const featureTipActionsPropsMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyDetails: shortcutMock
}))

vi.mock('./VoiceDictationFeatureTipVisual', () => ({
  VoiceDictationFeatureTipVisual: () => <div data-testid="voice-visual" />
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
  FeatureTipActions: (props: { primaryButtonRef?: RefObject<HTMLButtonElement | null> }) => {
    featureTipActionsPropsMock(props)
    return <button ref={props.primaryButtonRef}>Primary action</button>
  }
}))

function getVoiceTip(): FeatureTip {
  const tip = FEATURE_TIPS.find((entry) => entry.id === 'voice-dictation')
  if (!tip) {
    throw new Error('Expected voice-dictation feature tip fixture')
  }
  return { ...tip }
}

function renderDialog(): string {
  return renderToStaticMarkup(
    <VoiceDictationTipDialog
      open
      tip={getVoiceTip()}
      primaryBusy={false}
      onOpenChange={vi.fn()}
      onPrimaryAction={vi.fn()}
      onSkip={vi.fn()}
      onVoiceSettingsClick={vi.fn()}
    />
  )
}

describe('VoiceDictationTipDialog', () => {
  beforeEach(() => {
    shortcutMock.mockReturnValue({ keys: ['⌘', 'E'], doubleTap: false })
    dialogContentPropsMock.mockClear()
    featureTipActionsPropsMock.mockClear()
  })

  it('uses the established feature-tip layout and durable copy', () => {
    const html = renderDialog()

    expect(html).toContain('TIP')
    expect(html).toContain('Dictate into any pane')
    expect(html).not.toContain('Turn speech into text wherever')
    expect(html).not.toContain('is here')
  })

  it('shows the live dictation shortcut and voice settings path', () => {
    const html = renderDialog()

    expect(html).toContain('⌘')
    expect(html).toContain('E')
    expect(html).toContain('to start voice dictation. Press')
    expect(html).toContain('again to stop.')
    expect(html).toContain('Settings → Voice')
  })

  it('uses generic instructions instead of a shortcut the user has unassigned', () => {
    shortcutMock.mockReturnValue({ keys: [], doubleTap: false })

    const html = renderDialog()

    expect(html).toContain(
      'Assign a dictation shortcut before starting voice dictation in a focused pane.'
    )
    expect(html).not.toContain('to start voice dictation. Press')
    expect(html).not.toContain('Ctrl')
  })

  it('moves initial focus to the primary action', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <VoiceDictationTipDialog
          open
          tip={getVoiceTip()}
          primaryBusy={false}
          onOpenChange={vi.fn()}
          onPrimaryAction={vi.fn()}
          onSkip={vi.fn()}
          onVoiceSettingsClick={vi.fn()}
        />
      )
    })
    const event = { preventDefault: vi.fn() } as unknown as Event

    dialogContentPropsMock.mock.lastCall?.[0].onOpenAutoFocus(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(document.activeElement?.textContent).toBe('Primary action')

    await act(async () => root.unmount())
    container.remove()
  })
})
