import type { OffscreenPageDatalist } from '../../../../../shared/offscreen-page-protocol'

// Electron's AutofillPopupView colors (ui::kColorResultsTable*, kColorUnfocusedBorder), sampled
// from its own rendering.
const PALETTES = {
  light: {
    border: '#dadce0',
    background: '#fff',
    selected: '#f2f2f2',
    text: '#000',
    dimmed: '#646464'
  },
  dark: {
    border: '#3c4043',
    background: '#282828',
    selected: '#323232',
    text: '#fff',
    dimmed: '#999'
  }
} as const

// Why per platform: the popup uses gfx::FontList's default, the platform UI font.
const FONT = navigator.userAgent.includes('Windows')
  ? { family: '"Segoe UI", system-ui, sans-serif', size: 12 }
  : { family: 'system-ui, sans-serif', size: 13 }

export const OFFSCREEN_PAGE_DATALIST_STYLE = `
  .datalist { position: absolute; box-sizing: border-box; border: 1px solid; overflow: hidden;
    pointer-events: none; transform-origin: 0 0; font-family: ${FONT.family}; }
  .datalist-row { display: flex; align-items: center; justify-content: space-between;
    box-sizing: border-box; height: 24px; padding: 0 8px; white-space: pre; }
  .datalist-value { font-size: ${FONT.size}px; font-weight: 700; }
  .datalist-label { font-size: ${FONT.size - 1}px; margin-left: 15px; }`

/**
 * Draws the page's datalist popup where the page put it. The popup itself stays live but
 * invisible inside the page and takes the pointer and keys there, so this is only its picture.
 */
export function renderOffscreenPageDatalist(
  popup: HTMLElement,
  datalist: OffscreenPageDatalist | null
): void {
  popup.hidden = datalist === null
  if (!datalist) {
    popup.replaceChildren()
    return
  }
  const colors = PALETTES[datalist.dark ? 'dark' : 'light']
  const { rect, scale } = datalist
  // Why scale a DIP-sized box: the native popup ignores page and UI zoom, as rows here must.
  Object.assign(popup.style, {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width / scale}px`,
    height: `${rect.height / scale}px`,
    transform: `scale(${scale})`,
    borderColor: colors.border,
    background: colors.background
  })
  popup.replaceChildren(
    ...datalist.items.map((item, index) => {
      const row = document.createElement('div')
      row.className = 'datalist-row'
      row.style.background = index === datalist.selected ? colors.selected : 'transparent'
      const value = document.createElement('span')
      value.className = 'datalist-value'
      value.style.color = colors.text
      value.textContent = item.value
      row.append(value)
      if (item.label) {
        const label = document.createElement('span')
        label.className = 'datalist-label'
        label.style.color = colors.dimmed
        label.textContent = item.label
        row.append(label)
      }
      return row
    })
  )
}
