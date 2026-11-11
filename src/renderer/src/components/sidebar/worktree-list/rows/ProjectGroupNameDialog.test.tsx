// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'

afterEach(cleanup)

function Harness({
  names,
  onSubmit
}: {
  names: Record<string, string>
  onSubmit: (name: string) => Promise<void>
}): React.JSX.Element {
  const [target, setTarget] = useState<string | null>(null)
  return (
    <>
      <button onClick={() => setTarget('A')}>openA</button>
      <button onClick={() => setTarget('B')}>openB</button>
      <ProjectGroupNameDialog
        open={target !== null}
        title="Rename"
        description="desc"
        initialName={target ? names[target] : ''}
        confirmLabel="Save"
        onOpenChange={(open) => {
          if (!open) {
            setTarget(null)
          }
        }}
        onSubmit={onSubmit}
      />
    </>
  )
}

it.each([
  ['distinct names', { A: 'alpha', B: 'beta' }],
  ['same names', { A: 'same', B: 'same' }]
])('stale save does not close a newer dialog (%s)', async (_label, names) => {
  const pendingSave = Promise.withResolvers<void>()
  const submits: string[] = []
  const onSubmit = (name: string): Promise<void> => {
    submits.push(name)
    return pendingSave.promise
  }
  render(<Harness names={names} onSubmit={onSubmit} />)
  fireEvent.click(screen.getByText('openA'))
  const inputA = screen.getByRole('textbox')
  fireEvent.change(inputA, { target: { value: 'renamed-A' } })
  fireEvent.submit(inputA.closest('form')!)
  expect(submits).toEqual(['renamed-A'])
  fireEvent.click(screen.getByText('Cancel'))
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(screen.getByText('openB'))
  const inputB = screen.getByRole('textbox')
  fireEvent.change(inputB, { target: { value: 'draft-B' } })
  await act(async () => {
    pendingSave.resolve()
  })
  expect(screen.queryByDisplayValue('draft-B')).not.toBeNull()
  expect(screen.getByText('Save').closest('button')?.disabled).toBe(false)
})

it('successful save closes its own dialog', async () => {
  render(<Harness names={{ A: 'alpha', B: 'beta' }} onSubmit={async () => {}} />)
  fireEvent.click(screen.getByText('openA'))
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'x' } })
  await act(async () => {
    fireEvent.submit(input.closest('form')!)
  })
  expect(screen.queryByRole('textbox')).toBeNull()
})
