// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'

describe('confirmation dialog Fast Refresh boundary', () => {
  it('resolves the hook against the context the provider publishes', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ConfirmationDialogProvider, null, children)
    const { result } = renderHook(() => useConfirmationDialog(), { wrapper })

    expect(typeof result.current).toBe('function')
  })
})
