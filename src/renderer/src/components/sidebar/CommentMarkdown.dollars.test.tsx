// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

vi.mock('./CommentMermaidBlock', () => ({ default: () => null }))
afterEach(cleanup)

beforeAll(async () => {
  const view = render(<CommentMarkdown content="$x$" math />)
  await waitFor(() => expect(view.container.querySelector('.katex')).not.toBeNull())
  view.unmount()
})

it.each([false, true])('preserves shell expansions, prices and code (growing=%s)', (growing) => {
  const source = [
    'Set $ORCA_HOME then run echo $PATH; $HOME and $PATH stay literal.',
    'Use $HOME/bin:$PATH or $HOME/${PATH}.',
    'Use $env:PATH;$env:TEMP in PowerShell.',
    'It costs $5 or $10; $5 + tax$ is the cost.',
    'Run `echo $HOME` and `$VAR`.'
  ].join('\n\n')
  const view = render(
    <CommentMarkdown content={source} math growing={growing} variant="document" />
  )
  expect(view.container.querySelector('.katex, .katex-error')).toBeNull()
  expect(Array.from(view.container.querySelectorAll('p'), (node) => node.textContent)).toEqual([
    'Set $ORCA_HOME then run echo $PATH; $HOME and $PATH stay literal.',
    'Use $HOME/bin:$PATH or $HOME/${PATH}.',
    'Use $env:PATH;$env:TEMP in PowerShell.',
    'It costs $5 or $10; $5 + tax$ is the cost.',
    'Run echo $HOME and $VAR.'
  ])
  expect(Array.from(view.container.querySelectorAll('code'), (node) => node.textContent)).toEqual([
    'echo $HOME',
    '$VAR'
  ])

  view.rerender(
    <CommentMarkdown
      content={String.raw`Use $HOME/bin:$PATH and $x^2$ for the $n$th term. Costs $5 + tax, but $y$ is math. Keep $5 + 2$ typed; render $5+2$, \(5 + 2\), and $$5 + 2$$.`}
      math
      growing={growing}
      variant="document"
    />
  )
  expect(
    Array.from(view.container.querySelectorAll('annotation'), (node) => node.textContent)
  ).toEqual(['x^2', 'n', 'y', '5+2', '5 + 2', '5 + 2'])
  expect(view.container.textContent).toContain('Use $HOME/bin:$PATH and ')
  expect(view.container.textContent).toContain('Costs $5 + tax, but ')
  expect(view.container.textContent).toContain('Keep $5 + 2$ typed; render ')
})
