export const spinnerVariants = {
  original: `
    @keyframes agent-spinner-rotate { to { transform: rotate(360deg); } }
    .agent-working-spinner { animation-duration: 1s; animation-timing-function: steps(12, end); }
  `,
  long: '',
  // Retain the rejected containment experiment for reproducible ablation.
  contained:
    '.spinner-benchmark-container { content-visibility: auto; overflow-clip-margin: var(--spacing); }'
}

export async function setSpinnerVariant(page, variant) {
  if (!(variant in spinnerVariants)) {
    throw new Error(`Unknown spinner variant: ${variant}`)
  }
  await page.evaluate((css) => {
    for (const ring of document.querySelectorAll('[data-agent-spinner]')) {
      ring.parentElement.classList.add('spinner-benchmark-container')
    }
    let style = document.getElementById('spinner-variant')
    if (!style) {
      style = document.createElement('style')
      style.id = 'spinner-variant'
      document.head.appendChild(style)
    }
    style.textContent = css
  }, spinnerVariants[variant])
}

export async function spinnerCensus(page) {
  return page.evaluate(() => {
    const rings = [...document.querySelectorAll('[data-agent-spinner]')]
    const inViewport = (ring) => {
      // Querying the skipped child would force the rendering this census measures.
      const rect = ring.parentElement.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        return false
      }
      let top = 0
      let bottom = innerHeight
      for (let parent = ring.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
          const bounds = parent.getBoundingClientRect()
          top = Math.max(top, bounds.top)
          bottom = Math.min(bottom, bounds.bottom)
        }
      }
      return rect.bottom > top && rect.top < bottom
    }
    return {
      mounted: rings.length,
      visible: rings.filter(inViewport).length,
      workingSubagentRows: document.querySelectorAll(
        '.worktree-agent-lineage-child-row [data-agent-spinner]'
      ).length,
      documentVisibility: document.visibilityState
    }
  })
}
