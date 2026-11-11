// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))

import {
  beginCloudCreateIntent,
  consumeCloudCreateIntent,
  isCloudCreateIntentPending,
  resetCloudCreateIntentsForTest
} from '@/lib/orca-cloud/cloud-create-intent'
import {
  getCloudSetupPageRequest,
  openCloudSetupPage
} from '@/lib/orca-cloud/cloud-setup-page-store'
import { exitCloudSetup } from './CloudSetupPageLayer'
import { useEscapeExitsSetup } from './use-escape-exits-setup'

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  resetCloudCreateIntentsForTest()
})

describe('Escape on the Orca Cloud setup page (RR-b)', () => {
  it('exits setup when the page is visible', () => {
    const onExit = vi.fn()
    renderHook(() => useEscapeExitsSetup(true, onExit))
    pressEscape()
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('leaves Escape to a menu, popover or dialog on top, and does nothing while hidden', () => {
    const onExit = vi.fn()
    const { rerender } = renderHook(({ visible }) => useEscapeExitsSetup(visible, onExit), {
      initialProps: { visible: true }
    })
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    pressEscape()
    menu.remove()
    rerender({ visible: false })
    pressEscape()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('Escape, then the sign-in finishing, never creates: the pending start is cancelled for good', () => {
    const intentId = beginCloudCreateIntent()
    openCloudSetupPage({
      prompt: 'fix the typo',
      repoId: 'repo',
      agent: 'claude',
      availability: 'needs-sign-in',
      cloudOnlyRepo: null,
      composer: {},
      intentId
    })
    const request = getCloudSetupPageRequest()!
    renderHook(() => useEscapeExitsSetup(true, () => exitCloudSetup(request)))
    pressEscape()
    expect(getCloudSetupPageRequest()).toBeNull()
    expect(isCloudCreateIntentPending(intentId)).toBe(false)
    // The sign-in finishes later and the auto-start tries to use the press: it can't.
    expect(consumeCloudCreateIntent(intentId)).toBe(false)
  })
})
