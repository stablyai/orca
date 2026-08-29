// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import * as contextModule from '@/components/confirmation-dialog-context'
import * as providerModule from '@/components/confirmation-dialog'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'

// react-refresh ships no types; take the one binding this needs.
const { isLikelyComponentType } = createRequire(import.meta.url)('react-refresh/runtime') as {
  isLikelyComponentType: (value: unknown) => boolean
}

describe('confirmation dialog Fast Refresh boundary', () => {
  it('exports nothing from the provider module that invalidates the refresh boundary', () => {
    expect(Object.keys(providerModule)).toEqual(['ConfirmationDialogProvider'])
    expect(isLikelyComponentType(providerModule.ConfirmationDialogProvider)).toBe(true)
  })

  it('keeps the context and hook in a component-free module', () => {
    const components = Object.entries(contextModule)
      .filter(([, value]) => isLikelyComponentType(value))
      .map(([name]) => name)

    expect(components).toEqual([])
    expect(typeof contextModule.useConfirmationDialog).toBe('function')
  })

  it('resolves the hook against the context the provider publishes', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ConfirmationDialogProvider, null, children)
    const { result } = renderHook(() => useConfirmationDialog(), { wrapper })

    expect(typeof result.current).toBe('function')
  })
})
