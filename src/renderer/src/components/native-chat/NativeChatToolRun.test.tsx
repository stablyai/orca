// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NativeChatToolRun } from './NativeChatToolRun'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

async function renderToolRun(
  blocks: NativeChatBlock[]
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)
  })
  return { container, root }
}

describe('NativeChatToolRun', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('marks failed tool runs and exposes summary expansion state', async () => {
    const { container, root } = await renderToolRun([
      { type: 'tool-call', name: 'Read', input: { file_path: 'missing.ts' } },
      { type: 'tool-result', output: 'not found', isError: true }
    ])

    const summaryButton = container.querySelector('button')
    expect(summaryButton?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('Failed')

    await act(async () => {
      summaryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(summaryButton?.getAttribute('aria-expanded')).toBe('true')
    act(() => root.unmount())
  })
})
