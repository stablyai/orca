import { describe, expect, it } from 'vitest'
import { applyXlsxColorTint, readRgbChannels, resolveXlsxColor } from './xlsx-color'
import { parseXlsxThemePalette } from './xlsx-theme-palette'

const OFFICE_THEME_XML = `<a:theme><a:themeElements><a:clrScheme name="Office">
  <a:dk1><a:srgbClr val="000000"/></a:dk1>
  <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
  <a:dk2><a:srgbClr val="44546A"/></a:dk2>
  <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
  <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
  <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
  <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
  <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
  <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
  <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
  <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
  <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme></a:themeElements></a:theme>`

const OFFICE_PALETTE = parseXlsxThemePalette(OFFICE_THEME_XML)

describe('resolveXlsxColor', () => {
  it('drops the alpha byte of an ARGB value', () => {
    expect(resolveXlsxColor({ rgb: 'FFFFFF00' }, [])).toBe('#ffff00')
    expect(resolveXlsxColor({ rgb: 'FF1F4E78' }, [])).toBe('#1f4e78')
  })

  it('accepts a six-digit value and a leading hash', () => {
    expect(resolveXlsxColor({ rgb: 'FFFF00' }, [])).toBe('#ffff00')
    expect(resolveXlsxColor({ rgb: '#FFFF00' }, [])).toBe('#ffff00')
  })

  it('resolves a theme index against the palette', () => {
    expect(resolveXlsxColor({ theme: '4' }, OFFICE_PALETTE)).toBe('#4472c4')
    expect(resolveXlsxColor({ theme: '9' }, OFFICE_PALETTE)).toBe('#70ad47')
  })

  it('resolves theme 0 and 1 to the swapped background/text pair', () => {
    // Why: theme="1" is the default body text and must be black, not white. The
    // clrScheme lists dk1 first, so a naive document-order palette inverts both.
    expect(resolveXlsxColor({ theme: '0' }, OFFICE_PALETTE)).toBe('#ffffff')
    expect(resolveXlsxColor({ theme: '1' }, OFFICE_PALETTE)).toBe('#000000')
    expect(resolveXlsxColor({ theme: '2' }, OFFICE_PALETTE)).toBe('#e7e6e6')
    expect(resolveXlsxColor({ theme: '3' }, OFFICE_PALETTE)).toBe('#44546a')
  })

  it('returns null for a themed colour with no theme part available', () => {
    expect(resolveXlsxColor({ theme: '1' }, [])).toBeNull()
    expect(resolveXlsxColor({ theme: '99' }, OFFICE_PALETTE)).toBeNull()
  })

  it('resolves an indexed colour from the legacy palette', () => {
    expect(resolveXlsxColor({ indexed: '2' }, [])).toBe('#ff0000')
    expect(resolveXlsxColor({ indexed: '13' }, [])).toBe('#ffff00')
  })

  it('treats the system indexed colours as automatic', () => {
    // Why: 64 and 65 mean "system foreground/background". Resolving them to black
    // or white would override the app theme with the OS default.
    expect(resolveXlsxColor({ indexed: '64' }, [])).toBeNull()
    expect(resolveXlsxColor({ indexed: '65' }, [])).toBeNull()
    expect(resolveXlsxColor({ indexed: '999' }, [])).toBeNull()
  })

  it('returns null when no colour attribute is present or the value is junk', () => {
    expect(resolveXlsxColor({}, OFFICE_PALETTE)).toBeNull()
    expect(resolveXlsxColor({ rgb: 'nothex' }, [])).toBeNull()
    expect(resolveXlsxColor({ rgb: 'FFF' }, [])).toBeNull()
  })

  it('applies a tint on top of the resolved colour', () => {
    const untinted = resolveXlsxColor({ theme: '3' }, OFFICE_PALETTE)
    const lightened = resolveXlsxColor({ theme: '3', tint: '0.6' }, OFFICE_PALETTE)

    expect(lightened).not.toBe(untinted)
    expect(readRgbChannels(lightened!)!.red).toBeGreaterThan(readRgbChannels(untinted!)!.red)
  })

  it('ignores a tint of zero or an unparseable tint', () => {
    expect(resolveXlsxColor({ rgb: 'FF4472C4', tint: '0' }, [])).toBe('#4472c4')
    expect(resolveXlsxColor({ rgb: 'FF4472C4', tint: 'none' }, [])).toBe('#4472c4')
  })
})

describe('applyXlsxColorTint', () => {
  it('moves a colour toward white for a positive tint', () => {
    expect(applyXlsxColorTint('#000000', 1)).toBe('#ffffff')
    // 0x80 is 128/255 = 0.50196, so a half tint lands on 0xc0, not 0xbf.
    expect(applyXlsxColorTint('#808080', 0.5)).toBe('#c0c0c0')
  })

  it('moves a colour toward black for a negative tint', () => {
    expect(applyXlsxColorTint('#ffffff', -1)).toBe('#000000')
    expect(applyXlsxColorTint('#808080', -0.5)).toBe('#404040')
  })

  it('leaves the colour unchanged for a zero tint', () => {
    expect(applyXlsxColorTint('#4472c4', 0)).toBe('#4472c4')
  })

  it('preserves the hue while changing luminance', () => {
    const tinted = applyXlsxColorTint('#4472c4', 0.4)
    const channels = readRgbChannels(tinted)!

    expect(channels.blue).toBeGreaterThan(channels.green)
    expect(channels.green).toBeGreaterThan(channels.red)
  })

  it('clamps a tint outside the legal range instead of overflowing', () => {
    expect(applyXlsxColorTint('#4472c4', 5)).toBe('#ffffff')
    expect(applyXlsxColorTint('#4472c4', -5)).toBe('#000000')
  })

  it('returns the input unchanged when it is not a colour', () => {
    expect(applyXlsxColorTint('not-a-color', 0.5)).toBe('not-a-color')
  })
})

describe('parseXlsxThemePalette', () => {
  it('returns an empty palette for a missing or unreadable theme part', () => {
    expect(parseXlsxThemePalette('')).toEqual([])
    expect(parseXlsxThemePalette('<a:theme/>')).toEqual([])
  })

  it('reads a system colour slot through its lastClr', () => {
    const palette = parseXlsxThemePalette(
      '<a:clrScheme><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1></a:clrScheme>'
    )

    expect(palette[0]).toBe('FFFFFF')
    expect(palette[1]).toBe('000000')
  })
})
