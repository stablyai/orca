import { PNG } from 'pngjs'

function colorKey(red, green, blue) {
  return `${red >> 3},${green >> 3},${blue >> 3}`
}

export function analyzeTerminalFrame(buffer, geometry, viewport, terminalSnapshot) {
  const png = PNG.sync.read(buffer)
  const scaleX = png.width / viewport.width
  const scaleY = png.height / viewport.height
  const metrics = []

  for (const pane of geometry) {
    const bounds = pane.bounds
    const x0 = Math.max(0, Math.floor(bounds.x * scaleX))
    const y0 = Math.max(0, Math.floor(bounds.y * scaleY))
    const x1 = Math.min(png.width, Math.ceil((bounds.x + bounds.width) * scaleX))
    const y1 = Math.min(png.height, Math.ceil((bounds.y + bounds.height) * scaleY))
    if (x0 >= x1 || y0 >= y1) {
      throw new Error(`Terminal pane ${pane.index} falls outside the captured screenshot`)
    }
    const histogram = new Map()
    for (let y = y0; y < y1; y += 4) {
      for (let x = x0; x < x1; x += 4) {
        const offset = (y * png.width + x) * 4
        const key = colorKey(png.data[offset], png.data[offset + 1], png.data[offset + 2])
        histogram.set(key, (histogram.get(key) ?? 0) + 1)
      }
    }
    const backgroundEntry = [...histogram.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!backgroundEntry) {
      throw new Error(`Terminal pane ${pane.index} has no pixels available for analysis`)
    }
    const background = backgroundEntry[0]
    const [br, bg, bb] = background.split(',').map((part) => Number(part) * 8 + 4)
    let different = 0
    let sampled = 0
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const offset = (y * png.width + x) * 4
        const distance =
          Math.abs(png.data[offset] - br) +
          Math.abs(png.data[offset + 1] - bg) +
          Math.abs(png.data[offset + 2] - bb)
        if (distance > 54) {
          different++
        }
        sampled++
      }
    }
    const terminalPane = terminalSnapshot.panes[pane.index]
    const missingCells = []
    let textCells = 0
    if (terminalPane?.textCells) {
      for (let row = 0; row < terminalPane.textCells.length; row++) {
        for (const [column, chars] of terminalPane.textCells[row]) {
          const cellX0 = Math.max(x0, Math.floor((bounds.x + column * pane.cell.width) * scaleX))
          const cellY0 = Math.max(y0, Math.floor((bounds.y + row * pane.cell.height) * scaleY))
          const cellX1 = Math.min(
            x1,
            Math.ceil((bounds.x + (column + 1) * pane.cell.width) * scaleX)
          )
          const cellY1 = Math.min(y1, Math.ceil((bounds.y + (row + 1) * pane.cell.height) * scaleY))
          let maxDistance = 0
          const insetX = Math.max(1, Math.floor((cellX1 - cellX0) * 0.1))
          const insetY = Math.max(1, Math.floor((cellY1 - cellY0) * 0.1))
          for (let y = cellY0 + insetY; y < cellY1 - insetY; y++) {
            for (let x = cellX0 + insetX; x < cellX1 - insetX; x++) {
              const offset = (y * png.width + x) * 4
              const distance =
                Math.abs(png.data[offset] - br) +
                Math.abs(png.data[offset + 1] - bg) +
                Math.abs(png.data[offset + 2] - bb)
              maxDistance = Math.max(maxDistance, distance)
            }
          }
          textCells++
          if (maxDistance < 36) {
            missingCells.push(`${row}:${column}:${chars}`)
          }
        }
      }
    }
    metrics.push({
      pane: pane.index,
      background,
      nonBackgroundRatio: sampled ? different / sampled : 0,
      textCells,
      missing: missingCells.length,
      missPct: textCells ? (100 * missingCells.length) / textCells : 0,
      missingCells
    })
  }
  return metrics
}

export function findPersistentCellDivergences(attempts) {
  const suspects = []
  for (const attempt of attempts) {
    const baseline = new Map(attempt.baselinePanes.map((pane) => [pane.pane, pane.missPct]))
    const histories = new Map()
    const reported = new Set()
    for (const frame of attempt.frames) {
      for (const pane of frame.panes) {
        const baselineMissPct = baseline.get(pane.pane) ?? pane.missPct
        if (pane.textCells < 40 || pane.missPct < Math.max(8, baselineMissPct + 6)) {
          histories.delete(pane.pane)
          continue
        }
        const coordinates = new Set(
          pane.missingCells.map((cell) => cell.split(':').slice(0, 2).join(':'))
        )
        const history = histories.get(pane.pane) ?? []
        history.push({ file: frame.file, coordinates, pane })
        while (history.length > 3) {
          history.shift()
        }
        histories.set(pane.pane, history)
        if (history.length < 3 || reported.has(pane.pane)) {
          continue
        }
        let persistent = true
        for (let index = 1; index < history.length; index++) {
          const before = history[index - 1].coordinates
          const after = history[index].coordinates
          let intersection = 0
          for (const coordinate of after) {
            if (before.has(coordinate)) {
              intersection++
            }
          }
          const union = before.size + after.size - intersection
          if (!union || intersection / union < 0.5) {
            persistent = false
            break
          }
        }
        if (persistent) {
          reported.add(pane.pane)
          suspects.push({
            attempt: attempt.attempt,
            file: frame.file,
            pane: pane.pane,
            baselineMissPct,
            observedMissPct: pane.missPct,
            textCells: pane.textCells,
            missing: pane.missing,
            persistentFrames: history.map((entry) => entry.file)
          })
        }
      }
    }
  }
  return suspects
}
