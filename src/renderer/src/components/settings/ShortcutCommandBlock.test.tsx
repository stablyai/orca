// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getKeybindingDefinition } from '../../../../shared/keybindings'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ShortcutCommandBlock } from './ShortcutCommandBlock'

afterEach(cleanup)

describe('ShortcutCommandBlock', () => {
  it('wraps persistent conflict remediation instead of truncating it', () => {
    const warning = 'Blocked by Mission Control. Remap here or change it in System Settings.'
    const item = getKeybindingDefinition('tab.selectByIndex')
    expect(item).not.toBeNull()

    render(
      <TooltipProvider>
        <ShortcutCommandBlock
          item={item!}
          groupTitle="Tab Navigation"
          platform="darwin"
          effective={['Ctrl+1']}
          modified={false}
          warnings={[warning]}
          previousBindings={[]}
          recordingBindingIndex={null}
          onStartRecordingAt={vi.fn()}
          onAppendBinding={vi.fn()}
          onCancelRecording={vi.fn()}
          onCapture={vi.fn()}
          onClearError={vi.fn()}
          onRemoveBindingAt={vi.fn()}
          onResetAction={vi.fn()}
          onDisableAction={vi.fn()}
          onEnableAction={vi.fn()}
        />
      </TooltipProvider>
    )

    const helper = screen.getByText(warning)
    expect(helper.classList.contains('whitespace-normal')).toBe(true)
    expect(helper.classList.contains('truncate')).toBe(false)
  })

  it('renders title with tooltip trigger for truncated names', () => {
    const item = getKeybindingDefinition('worktree.history.back')
    expect(item).not.toBeNull()

    render(
      <TooltipProvider>
        <ShortcutCommandBlock
          item={item!}
          groupTitle="Navigation"
          platform="darwin"
          effective={['Ctrl+Alt+Left']}
          modified={false}
          warnings={[]}
          previousBindings={[]}
          recordingBindingIndex={null}
          onStartRecordingAt={vi.fn()}
          onAppendBinding={vi.fn()}
          onCancelRecording={vi.fn()}
          onCapture={vi.fn()}
          onClearError={vi.fn()}
          onRemoveBindingAt={vi.fn()}
          onResetAction={vi.fn()}
          onDisableAction={vi.fn()}
          onEnableAction={vi.fn()}
        />
      </TooltipProvider>
    )

    const titleElement = screen.getByText(item!.title)
    expect(titleElement.getAttribute('data-slot')).toBe('tooltip-trigger')
  })
})
