import React, { memo, useMemo } from 'react'

/** Shared by the Resource Manager and Ports popovers so both draw the same trend line. */

type SparklineProps = {
  samples: number[]
  width?: number
  height?: number
}

function SparklineImpl({ samples, width = 48, height = 14 }: SparklineProps): React.JSX.Element {
  const points = useMemo(() => {
    const safe = Array.isArray(samples) ? samples : []
    if (safe.length < 2) {
      const midY = (height / 2).toFixed(1)
      return `0,${midY} ${width},${midY}`
    }

    let min = safe[0]
    let max = safe[0]
    for (const v of safe) {
      if (v < min) {
        min = v
      }
      if (v > max) {
        max = v
      }
    }
    const range = max - min || 1
    const stepX = width / (safe.length - 1)

    const out: string[] = []
    for (let i = 0; i < safe.length; i++) {
      const x = (i * stepX).toFixed(1)
      const y = (height - ((safe[i] - min) / range) * height).toFixed(1)
      out.push(`${x},${y}`)
    }
    return out.join(' ')
  }, [samples, width, height])

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-muted-foreground/70"
      />
    </svg>
  )
}

export const Sparkline = memo(SparklineImpl, (a, b) => {
  if (a.width !== b.width || a.height !== b.height) {
    return false
  }
  const sa = Array.isArray(a.samples) ? a.samples : []
  const sb = Array.isArray(b.samples) ? b.samples : []
  if (sa === sb) {
    return true
  }
  if (sa.length !== sb.length) {
    return false
  }
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) {
      return false
    }
  }
  return true
})
