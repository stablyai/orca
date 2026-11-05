// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationEditorDialogFooter } from './AutomationEditorDialogFooter'

afterEach(cleanup)
describe('automation editor footer without visible projects', () => {
  it.each([true, false])('allows a valid existing edit only (editing=%s)', (isEditing) => {
    const onSave = vi.fn()
    render(
      <AutomationEditorDialogFooter
        isEditing={isEditing}
        isSaving={false}
        canSave
        hasProjects={false}
        onOpenChange={vi.fn()}
        onSave={onSave}
      />
    )
    const button = screen.getByRole('button', { name: isEditing ? 'Save Changes' : 'Create' })
    expect(button.hasAttribute('disabled')).toBe(!isEditing)
    fireEvent.click(button)
    expect(onSave).toHaveBeenCalledTimes(isEditing ? 1 : 0)
  })
})
