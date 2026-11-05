// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, it, expect, vi } from 'vitest'
import { TextGenerationAccountRecoverySetting } from './TextGenerationAccountRecoverySetting'
import { useAppStore } from '../../store'

afterEach(cleanup)

it('defaults off and writes the selected host settings through the existing update model', () => {
  useAppStore.setState({ settingsSearchQuery: '' })
  const update = vi.fn(async () => {})
  render(<TextGenerationAccountRecoverySetting remote={false} model={{ settings: {}, update }} />)
  const control = screen.getByRole('switch', {
    name: 'Retry AI-generated text on another account after quota limits'
  })
  expect(control.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(control)
  expect(update).toHaveBeenCalledExactlyOnceWith({
    textGenerationSubscriptionFailoverEnabled: true
  })
})

it('does not offer an unsupported write to an older remote host', () => {
  useAppStore.setState({ settingsSearchQuery: '' })
  const update = vi.fn(async () => {})
  render(<TextGenerationAccountRecoverySetting remote model={{ settings: {}, update }} />)
  const control = screen.getByRole('switch', {
    name: 'Retry AI-generated text on another account after quota limits'
  })
  fireEvent.click(control)
  expect(control.hasAttribute('disabled')).toBe(true)
  expect(update).not.toHaveBeenCalled()
})
