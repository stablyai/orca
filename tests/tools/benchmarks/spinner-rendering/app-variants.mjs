export const spinnerVariants = {
  original: `
    @keyframes agent-spinner-rotate { to { transform: rotate(360deg); } }
    .agent-working-spinner { animation-duration: 1s; animation-timing-function: steps(12, end); }
  `,
  long: '',
  // Keeps scrolled-out rings animating, as before offscreen pausing.
  unpaused: `
    .agent-working-spinner[data-animation-offscreen] {
      animation: agent-spinner-rotate 86400s steps(1036800, end) infinite;
    }
  `,
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
      let left = 0
      let right = innerWidth
      const clips = /(auto|scroll|hidden|clip)/
      for (let parent = ring.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const bounds = parent.getBoundingClientRect()
        if (clips.test(style.overflowY)) {
          top = Math.max(top, bounds.top)
          bottom = Math.min(bottom, bounds.bottom)
        }
        if (clips.test(style.overflowX)) {
          left = Math.max(left, bounds.left)
          right = Math.min(right, bounds.right)
        }
      }
      // A clip collapsed to zero size hides everything, even a wrapper that straddles its edge.
      if (left >= right || top >= bottom) {
        return false
      }
      return rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right
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
