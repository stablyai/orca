import { describe, expect, it } from 'vitest'
import { isFullDiskAccessReady, isFullDiskAccessSetupVisible } from './FullDiskAccessSetupPrompt'

describe('FullDiskAccessSetupPrompt state helpers', () => {
  it('hides the setup prompt before status is known or when unsupported', () => {
    expect(isFullDiskAccessSetupVisible(undefined)).toBe(false)
    expect(isFullDiskAccessSetupVisible('unsupported')).toBe(false)
  })

  it('shows the setup prompt for macOS statuses users can act on', () => {
    expect(isFullDiskAccessSetupVisible('unknown')).toBe(true)
    expect(isFullDiskAccessSetupVisible('denied')).toBe(true)
    expect(isFullDiskAccessSetupVisible('granted')).toBe(true)
  })

  it('treats granted and entitled statuses as ready', () => {
    expect(isFullDiskAccessReady('granted')).toBe(true)
    expect(isFullDiskAccessReady('ready')).toBe(true)
    expect(isFullDiskAccessReady('unknown')).toBe(false)
  })
})
