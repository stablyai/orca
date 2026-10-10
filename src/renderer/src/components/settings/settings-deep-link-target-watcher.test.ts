// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchForSettingsDeepLinkTarget } from './settings-deep-link-target-watcher'

function flushMutations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('watchForSettingsDeepLinkTarget', () => {
  it('reports the target once the async rows render', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const onTargetPresent = vi.fn()
    watchForSettingsDeepLinkTarget({
      root: container,
      isTargetPresent: () => container.querySelector('[data-settings-section="env-1"]') !== null,
      onTargetPresent
    })

    const row = document.createElement('div')
    row.dataset.settingsSection = 'env-1'
    container.append(row)
    await flushMutations()

    expect(onTargetPresent).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting while unrelated rows render', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const onTargetPresent = vi.fn()
    watchForSettingsDeepLinkTarget({
      root: container,
      isTargetPresent: () => container.querySelector('[data-settings-section="env-1"]') !== null,
      onTargetPresent
    })

    const other = document.createElement('div')
    other.dataset.settingsSection = 'env-2'
    container.append(other)
    await flushMutations()
    expect(onTargetPresent).not.toHaveBeenCalled()

    const row = document.createElement('div')
    row.dataset.settingsSection = 'env-1'
    container.append(row)
    await flushMutations()
    expect(onTargetPresent).toHaveBeenCalledTimes(1)
  })

  it('reports at most once even as more rows arrive', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const onTargetPresent = vi.fn()
    watchForSettingsDeepLinkTarget({
      root: container,
      isTargetPresent: () => container.querySelector('[data-settings-section="env-1"]') !== null,
      onTargetPresent
    })

    const row = document.createElement('div')
    row.dataset.settingsSection = 'env-1'
    container.append(row)
    await flushMutations()
    container.append(document.createElement('div'))
    await flushMutations()

    expect(onTargetPresent).toHaveBeenCalledTimes(1)
  })

  it('stops reporting after cancel', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const onTargetPresent = vi.fn()
    const watch = watchForSettingsDeepLinkTarget({
      root: container,
      isTargetPresent: () => true,
      onTargetPresent
    })
    watch.cancel()

    container.append(document.createElement('div'))
    await flushMutations()

    expect(onTargetPresent).not.toHaveBeenCalled()
  })

  it('falls back to the document body when the pane has no scroll container yet', async () => {
    const onTargetPresent = vi.fn()
    watchForSettingsDeepLinkTarget({
      root: null,
      isTargetPresent: () => document.querySelector('[data-settings-section="env-1"]') !== null,
      onTargetPresent
    })

    const row = document.createElement('div')
    row.dataset.settingsSection = 'env-1'
    document.body.append(row)
    await flushMutations()

    expect(onTargetPresent).toHaveBeenCalledTimes(1)
  })
})
