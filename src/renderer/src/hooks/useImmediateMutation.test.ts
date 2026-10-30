// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { taskProviderErrorMessage } from '@/lib/task-provider-error-copy'
import { useImmediateMutation } from './useImmediateMutation'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

it('reverts a failed edit and delivers its coded error in the UI language', async () => {
  i18n.addResourceBundle('es', 'translation', es)
  await i18n.changeLanguage('es')
  const { result } = renderHook(() => useImmediateMutation())
  const onRevert = vi.fn()
  const onError = vi.fn()
  await act(async () => {
    await result.current.run('status', {
      mutate: async () => ({ ok: false, error: 'Host detail', errorCode: 'linear.updateFailed' }),
      formatError: taskProviderErrorMessage,
      onRevert,
      onError
    })
  })
  expect(onRevert).toHaveBeenCalledOnce()
  expect(onError).toHaveBeenCalledWith(es.taskProviders.errors.linear.updateFailed)
  expect(result.current.isPending('status')).toBe(false)
})
