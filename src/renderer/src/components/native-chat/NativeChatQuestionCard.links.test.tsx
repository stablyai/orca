// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import {
  NativeChatFileLinkExistenceContext,
  type NativeChatFileLinkExistence
} from './native-chat-file-link-existence'
import { routeNativeChatHref } from '../../../../shared/native-chat/native-chat-href-routing'

vi.mock('./native-chat-visual-markdown-extension', () => ({
  useNativeChatVisualMarkdownExtension: () => undefined
}))
afterEach(cleanup)

const check = (link: { pathText: string }) => link.pathText === '/tmp/question-mock.html'
const snapshot = { check, peek: check }
const existence: NativeChatFileLinkExistence = {
  watch: () => ({ subscribe: () => () => {}, getSnapshot: () => snapshot }),
  recheck: () => {}
}

it('opens bare host-confirmed paths and web links without answering or dismissing the question', () => {
  const onAnswer = vi.fn()
  const onCancel = vi.fn()
  const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>, _href: string | undefined) =>
    event.preventDefault()
  )
  render(
    <NativeChatFileLinkExistenceContext.Provider value={existence}>
      <NativeChatQuestionCard
        prompt={{
          questions: [
            {
              question:
                'See /tmp/question-mock.html and /tmp/missing.html.\nReview [the PR](https://example.com/pr) or https://example.com/details. Which surface?',
              multiSelect: false,
              options: [{ label: 'Agent row' }, { label: 'Toast' }]
            }
          ]
        }}
        onAnswer={onAnswer}
        onCancel={onCancel}
        onLinkClick={onLinkClick}
        allowFileUriLinks
      />
    </NativeChatFileLinkExistenceContext.Provider>
  )
  const file = screen.getByRole('link', { name: '/tmp/question-mock.html' })
  expect(routeNativeChatHref(file.getAttribute('href') ?? undefined)).toMatchObject({
    kind: 'file',
    pathText: '/tmp/question-mock.html'
  })
  expect(screen.queryByRole('link', { name: '/tmp/missing.html' })).toBeNull()
  for (const link of [
    file,
    screen.getByRole('link', { name: 'the PR' }),
    screen.getByRole('link', { name: 'https://example.com/details' })
  ]) {
    fireEvent.click(link)
    expect(onLinkClick).toHaveBeenLastCalledWith(expect.anything(), link.getAttribute('href'))
  }
  expect(onAnswer).not.toHaveBeenCalled()
  expect(onCancel).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '1 Agent row' })).toBeTruthy()
})

it('routes explicit file links and preserves a multiline question without enabling unsafe URLs', () => {
  const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>, _href: string | undefined) =>
    event.preventDefault()
  )
  const { container } = render(
    <NativeChatQuestionCard
      prompt={{
        questions: [
          {
            question:
              'Review [the mock](file:///tmp/question%20mock.html).\nThen choose:\n\n[unsafe](javascript:alert%281%29)',
            multiSelect: false,
            options: [{ label: 'Continue' }]
          }
        ]
      }}
      onAnswer={vi.fn()}
      onCancel={vi.fn()}
      onLinkClick={onLinkClick}
      allowFileUriLinks
    />
  )
  const file = screen.getByRole('link', { name: 'the mock' })
  fireEvent.click(file)
  expect(routeNativeChatHref(onLinkClick.mock.calls[0]?.[1])).toMatchObject({
    kind: 'file',
    pathText: '/tmp/question mock.html'
  })
  expect(
    container.querySelector('[data-testid="native-chat-question-card-title"] br')
  ).not.toBeNull()
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
})
