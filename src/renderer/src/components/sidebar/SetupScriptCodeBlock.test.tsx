// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SetupScriptCodeBlock } from './SetupScriptCodeBlock'
import { SetupScriptReviewDialog } from './SetupScriptReviewDialog'

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

it('enables Save in the review dialog only after a long script is expanded', () => {
  const onSave = vi.fn()
  render(
    <SetupScriptReviewDialog
      open
      onOpenChange={() => {}}
      repoDisplayName="acme-web"
      setup={script(40)}
      archive="echo bye"
      skippedFields={['postStartCommand']}
      provenance=".devcontainer/devcontainer.json"
      isSaving={false}
      onSave={onSave}
    />
  )
  const save = screen.getByRole('button', { name: 'Save local setup' })
  expect(save).toBeDisabled()

  fireEvent.click(screen.getByRole('button', { name: 'Show 35 more lines' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(save).toBeEnabled()
  fireEvent.click(save)
  expect(onSave).toHaveBeenCalledTimes(1)
})
