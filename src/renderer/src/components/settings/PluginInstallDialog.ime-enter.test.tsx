// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import type { PluginHostInstallSource } from '../../../../preload/api-types'
import { PluginInstallDialog } from './PluginInstallDialog'

function renderDialog(
  onInstall: (source: PluginHostInstallSource) => Promise<void>
): HTMLInputElement {
  render(<PluginInstallDialog open onOpenChange={() => {}} onInstall={onInstall} />)
  const input = screen.getByLabelText('Plugin folder path') as HTMLInputElement
  fireEvent.change(input, { target: { value: '/plugins/한글' } })
  return input
}

afterEach(cleanup)

describe('PluginInstallDialog IME implicit submit', () => {
  it('does not install a plugin on the recorded Korean Enter redispatch', () => {
    const onInstall = vi
      .fn<(source: PluginHostInstallSource) => Promise<void>>()
      .mockResolvedValue()
    const input = renderDialog(onInstall)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onInstall).not.toHaveBeenCalled()
  })

  it('installs a plugin exactly once on an ordinary Enter', () => {
    const onInstall = vi
      .fn<(source: PluginHostInstallSource) => Promise<void>>()
      .mockResolvedValue()
    const input = renderDialog(onInstall)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onInstall).toHaveBeenCalledOnce()
    expect(onInstall).toHaveBeenCalledWith({ kind: 'local-path', path: '/plugins/한글' })
  })
})
