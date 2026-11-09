// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SetupScriptCodeBlock } from './SetupScriptCodeBlock'

afterEach(cleanup)

function script(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `echo step-${index + 1}`).join('\n')
}

it('collapses a long script and toggles it open and closed', () => {
  render(<SetupScriptCodeBlock heading="Setup script" script={script(40)} />)
  const code = screen.getByLabelText('Setup script')
  expect(code).toHaveTextContent('echo step-40')

  const toggle = screen.getByRole('button', { name: 'Show 35 more lines' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(toggle).toHaveAttribute('aria-controls', code.id)

  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')

  code.scrollTop = 200
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(code.scrollTop).toBe(0)
})

it('shows a short script in full with no toggle', () => {
  render(<SetupScriptCodeBlock heading="Setup script" script={script(5)} />)
  expect(screen.getByLabelText('Setup script')).toHaveTextContent('echo step-5')
  expect(screen.queryByRole('button')).toBeNull()
})
