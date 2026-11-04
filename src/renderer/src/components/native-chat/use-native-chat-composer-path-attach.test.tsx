/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement, useCallback, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { attachExplorerFileAsContext } from '@/components/right-sidebar/file-explorer-attach-as-context'
import { formatNativeChatFileReference } from './native-chat-composer-target'
import {
  markNativeChatComposerPathAttachFocused,
  resetNativeChatComposerPathAttachForTests
} from './native-chat-composer-path-attach'
import { useNativeChatComposerPathAttach } from './use-native-chat-composer-path-attach'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ProbeProps = {
  scopeKey: string
  caret: number
  disabled: boolean
  initialDraft: string
}

function Probe({ scopeKey, caret, disabled, initialDraft }: ProbeProps): React.JSX.Element {
  const [draft, setDraft] = useState(initialDraft)
  const attachResolvedPaths = useCallback(
    (paths: string[]) => {
      const insertion = `${paths.map(formatNativeChatFileReference).join(' ')} `
      setDraft((previous) => `${previous.slice(0, caret)}${insertion}${previous.slice(caret)}`)
    },
    [caret]
  )
  useNativeChatComposerPathAttach(scopeKey, attachResolvedPaths, disabled)
  return <output data-draft={scopeKey}>{draft}</output>
}

async function renderDual(args: {
  focusedCaret: number
  backgroundCaret?: number
  focusedDisabled?: boolean
}): Promise<{
  backgroundDraft: () => string
  focusedDraft: () => string
  root: Root
  strayTextarea: HTMLTextAreaElement
  rerender: (next: {
    focusedCaret: number
    backgroundCaret?: number
    focusedDisabled?: boolean
  }) => Promise<void>
}> {
  const container = document.createElement('div')
  const strayTextarea = document.createElement('textarea')
  strayTextarea.value = 'leave me'
  document.body.append(container, strayTextarea)
  const root = createRoot(container)
  const render = async (next: {
    focusedCaret: number
    backgroundCaret?: number
    focusedDisabled?: boolean
  }): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(Probe, {
            scopeKey: 'pane-a',
            caret: next.backgroundCaret ?? 3,
            disabled: false,
            initialDraft: 'aa '
          }),
          createElement(Probe, {
            scopeKey: 'pane-b',
            caret: next.focusedCaret,
            disabled: next.focusedDisabled ?? false,
            initialDraft: 'bb '
          })
        )
      )
    })
  }
  await render(args)
  return {
    backgroundDraft: () => container.querySelector('[data-draft="pane-a"]')?.textContent ?? '',
    focusedDraft: () => container.querySelector('[data-draft="pane-b"]')?.textContent ?? '',
    root,
    strayTextarea,
    rerender: render
  }
}

describe('useNativeChatComposerPathAttach', () => {
  afterEach(() => {
    resetNativeChatComposerPathAttachForTests()
    document.body.replaceChildren()
  })

  it('keeps the focused controlled composer after a caret move when two are ready', async () => {
    const view = await renderDual({ focusedCaret: 3 })
    markNativeChatComposerPathAttachFocused('pane-b')

    await view.rerender({ focusedCaret: 0 })

    await act(async () => {
      expect(attachExplorerFileAsContext('/repo/a.ts')).toBe(true)
    })

    expect(view.focusedDraft()).toBe(`${formatNativeChatFileReference('/repo/a.ts')} bb `)
    expect(view.backgroundDraft()).toBe('aa ')
    expect(view.strayTextarea.value).toBe('leave me')
    act(() => view.root.unmount())
  })

  it('honors a later disabled flag without dropping the other ready composer', async () => {
    const view = await renderDual({ focusedCaret: 3 })
    markNativeChatComposerPathAttachFocused('pane-b')

    await view.rerender({ focusedCaret: 3, focusedDisabled: true })

    await act(async () => {
      expect(attachExplorerFileAsContext('/repo/a.ts')).toBe(true)
    })

    expect(view.backgroundDraft()).toBe(`aa ${formatNativeChatFileReference('/repo/a.ts')} `)
    expect(view.focusedDraft()).toBe('bb ')
    act(() => view.root.unmount())
  })
})
