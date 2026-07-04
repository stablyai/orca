// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

beforeAll(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})

async function renderCard(element: ReactElement): Promise<{
  container: HTMLDivElement
  root: Root
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  return { container, root }
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(text)
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${text}`)
  }
  return button
}

describe('native chat interactive cards', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('renders approval as a pending composer section and sends literal option values', async () => {
    const onChoose = vi.fn()
    const { container, root } = await renderCard(
      <NativeChatApprovalCard
        approval={{
          title: 'Allow Edit?',
          detail: 'src/App.tsx',
          options: [
            { label: 'Allow', send: '1' },
            { label: 'Deny', send: '\x1b' }
          ]
        }}
        onChoose={onChoose}
      />
    )

    expect(container.textContent).toContain('Pending approval')
    expect(container.textContent).toContain('src/App.tsx')

    await act(async () => {
      buttonWithText(container, 'Deny').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onChoose).toHaveBeenCalledWith('\x1b')
    expect(buttonWithText(container, 'Allow').disabled).toBe(true)
    expect(buttonWithText(container, 'Deny').disabled).toBe(true)
    act(() => root.unmount())
  })

  it('re-enables approval controls when a new keyed approval replaces a response', async () => {
    const onChoose = vi.fn()
    const firstApproval = {
      title: 'Allow Edit?',
      detail: 'src/App.tsx',
      options: [
        { label: 'Allow', send: '1' },
        { label: 'Deny', send: '\x1b' }
      ]
    }
    const secondApproval = {
      title: 'Allow Shell?',
      detail: 'pnpm test',
      options: [
        { label: 'Allow', send: '1' },
        { label: 'Deny', send: '\x1b' }
      ]
    }
    const { container, root } = await renderCard(
      <NativeChatApprovalCard key="approval:first" approval={firstApproval} onChoose={onChoose} />
    )

    await act(async () => {
      buttonWithText(container, 'Deny').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(buttonWithText(container, 'Allow').disabled).toBe(true)

    await act(async () => {
      root.render(
        <NativeChatApprovalCard
          key="approval:second"
          approval={secondApproval}
          onChoose={onChoose}
        />
      )
    })

    expect(container.textContent).toContain('Allow Shell?')
    expect(buttonWithText(container, 'Allow').disabled).toBe(false)
    act(() => root.unmount())
  })

  it('keeps multi-step question answers formatted in question order', async () => {
    const onAnswer = vi.fn()
    const { container, root } = await renderCard(
      <NativeChatQuestionCard
        prompt={{
          questions: [
            { question: 'First?', options: [{ label: 'Alpha' }], multiSelect: false },
            { question: 'Second?', options: [{ label: 'Beta' }], multiSelect: false }
          ]
        }}
        onAnswer={onAnswer}
        onCancel={vi.fn()}
      />
    )

    await act(async () => {
      buttonWithText(container, 'Alpha').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonWithText(container, 'Next').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonWithText(container, 'Beta').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonWithText(container, 'Send answer').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })

    expect(container.textContent).toContain('Pending question')
    expect(onAnswer).toHaveBeenCalledWith('Alpha\nBeta')
    expect(buttonWithText(container, 'Send answer').disabled).toBe(true)
    act(() => root.unmount())
  })

  it('routes Other answers through the panel-local textarea only', async () => {
    const onAnswer = vi.fn()
    const { container, root } = await renderCard(
      <NativeChatQuestionCard
        prompt={{
          questions: [{ question: 'Custom?', options: [], multiSelect: false }]
        }}
        onAnswer={onAnswer}
        onCancel={vi.fn()}
      />
    )

    expect(buttonWithText(container, 'Send answer').disabled).toBe(true)

    await act(async () => {
      buttonWithText(container, 'Other…').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const textarea = container.querySelector('textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error('Missing Other answer textarea')
    }

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Typed custom answer'
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      buttonWithText(container, 'Send answer').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })

    expect(onAnswer).toHaveBeenCalledWith('Typed custom answer')
    expect(textarea.disabled).toBe(true)
    act(() => root.unmount())
  })
})
