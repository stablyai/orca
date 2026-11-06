import { describe, expect, it } from 'vitest'
import { decodeSvgBase64, readSvgIntrinsicSize } from './svg-document'

describe('readSvgIntrinsicSize', () => {
  it.each([
    ['<svg viewBox="0 0 1200 240">', { width: 1200, height: 240 }],
    ['<svg width="100%" height="100%" viewBox="0 0 1200 240">', { width: 1200, height: 240 }],
    ['<svg width="24" height="24" viewBox="0 0 48 48">', { width: 24, height: 24 }],
    ["<svg width='1in' height='72pt'>", { width: 96, height: 96 }],
    ['<svg width="600" viewBox="0,0,1200,240">', { width: 600, height: 120 }],
    [
      '<?xml version="1.0"?>\n<svg\n  xmlns="http://www.w3.org/2000/svg"\n  viewBox="0 0 10 20"\n>',
      { width: 10, height: 20 }
    ]
  ])('sizes %s', (markup, size) => {
    expect(readSvgIntrinsicSize(markup)).toEqual(size)
  })

  it('leaves an SVG with no usable size to the browser', () => {
    expect(readSvgIntrinsicSize('<svg width="10em" height="5em">')).toBeNull()
    expect(readSvgIntrinsicSize('not svg')).toBeNull()
  })
})

describe('decodeSvgBase64', () => {
  it('keeps a byte order mark and refuses bytes that are not UTF-8 text', () => {
    expect(decodeSvgBase64(Buffer.from('﻿<svg/>').toString('base64'))).toBe('﻿<svg/>')
    expect(decodeSvgBase64(Buffer.from([0x1f, 0x8b, 0x08, 0xff]).toString('base64'))).toBeNull()
  })
})
