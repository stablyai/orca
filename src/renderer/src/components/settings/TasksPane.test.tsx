// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TasksPane } from './TasksPane'
import { getDefaultSettings } from '../../../../shared/constants'

describe('TasksPane Linear launch template', () => {
  it('persists an edited template on blur', () => {
    const updateSettings = vi.fn()
    render(<TasksPane settings={getDefaultSettings('/home/test')} updateSettings={updateSettings} />)

    const textarea = screen.getByRole('textbox', {
      name: /launch prompt template/i
    })
    fireEvent.change(textarea, { target: { value: 'Do {{identifier}}' } })
    fireEvent.blur(textarea)

    expect(updateSettings).toHaveBeenCalledWith({ linearLaunchPromptTemplate: 'Do {{identifier}}' })
  })
})
