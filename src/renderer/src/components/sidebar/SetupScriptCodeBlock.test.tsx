// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SetupScriptCodeBlock } from './SetupScriptCodeBlock'
import { SetupScriptPromptBody } from './SetupScriptPromptCardViews'

afterEach(cleanup)

function script(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `echo step-${index + 1}`).join('\n')
}

it('collapses a long script and toggles it open and closed', () => {
  render(<SetupScriptCodeBlock heading="Setup script" script={script(40)} />)
  const code = screen.getByLabelText('Setup script')
  expect(code).toHaveTextContent('echo step-40')
  expect(code).toHaveAttribute('data-collapsed', 'true')

  const toggle = screen.getByRole('button', { name: 'Show 35 more lines' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(toggle).toHaveAttribute('aria-controls', code.id)

  fireEvent.click(toggle)
  expect(code).toHaveAttribute('data-collapsed', 'false')
  expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')

  fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(code).toHaveAttribute('data-collapsed', 'true')
})

it('shows a short script in full with no toggle', () => {
  render(<SetupScriptCodeBlock heading="Setup script" script={script(5)} />)
  expect(screen.getByLabelText('Setup script')).toHaveAttribute('data-collapsed', 'false')
  expect(screen.queryByRole('button')).toBeNull()
})

it('wraps the source file in the prompt body', () => {
  const { container } = render(
    <SetupScriptPromptBody
      isInspectionError={false}
      sharedSetupIgnored={false}
      isPackageManagerSuggestion={false}
      candidateSource=".conductor/settings.toml"
    />
  )
  expect(container.querySelector('code')).toHaveTextContent('.conductor/settings.toml')
})
