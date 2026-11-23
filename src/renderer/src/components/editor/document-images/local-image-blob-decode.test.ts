import { afterEach, expect, it } from 'vitest'
import { base64ToBlobInSlices, decodedBase64Length } from './local-image-blob-decode'
import {
  cacheLocalImageBlob,
  localImageBlobFits,
  resetLocalImageCacheState
} from './local-image-src-cache'
import { pinLocalImageCacheKey } from './local-image-cache-pinning'

afterEach(() => resetLocalImageCacheState())

const MIB = 1024 * 1024

it('decodes the same bytes across slice boundaries and line breaks', async () => {
  // "Hello, gallery!" with a line break mid-payload and slices that split base64 quads.
  const blob = await base64ToBlobInSlices('SGVsbG8s\nIGdhbGxlcnkh', 'image/png', undefined, 6)
  expect(await blob?.text()).toBe('Hello, gallery!')
  expect(blob?.type).toBe('image/png')
})

it('stops at the next slice once the read is superseded, building no Blob', async () => {
  const blob = await base64ToBlobInSlices('SGVsbG8sIGdhbGxlcnkh', 'image/png', () => true, 8)
  expect(blob).toBeNull()
})

it('measures a payload without decoding it', () => {
  expect(decodedBase64Length('SGVsbG8sIGdhbGxlcnkh')).toBe(15)
  expect(decodedBase64Length('QQ==')).toBe(1)
})

it('refuses only an image that pinned images leave no room for', () => {
  cacheLocalImageBlob('shown', 'blob:shown', 100 * MIB)
  pinLocalImageCacheKey('shown')
  expect(localImageBlobFits('next', 40 * MIB)).toBe(false)
  expect(localImageBlobFits('next', 20 * MIB)).toBe(true)
  expect(localImageBlobFits('other', 129 * MIB)).toBe(false)
})
