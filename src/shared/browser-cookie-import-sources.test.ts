import { describe, expect, it } from 'vitest'
import { getBrowserCookieImportSourceLabels } from './browser-cookie-import-sources'

describe('getBrowserCookieImportSourceLabels', () => {
  it('includes mac-only sources on darwin', () => {
    expect(getBrowserCookieImportSourceLabels('darwin')).toEqual([
      'Google Chrome',
      'Microsoft Edge',
      'Arc',
      'Brave',
      'Comet',
      'Helium',
      'Vivaldi',
      'Firefox',
      'Safari'
    ])
  })

  it('omits mac-only sources on Windows', () => {
    expect(getBrowserCookieImportSourceLabels('win32')).toEqual([
      'Google Chrome',
      'Microsoft Edge',
      'Brave',
      'Comet',
      'Vivaldi',
      'Firefox'
    ])
  })

  it('omits mac-only and Comet on Linux', () => {
    expect(getBrowserCookieImportSourceLabels('linux')).toEqual([
      'Google Chrome',
      'Microsoft Edge',
      'Brave',
      'Vivaldi',
      'Firefox'
    ])
  })
})
