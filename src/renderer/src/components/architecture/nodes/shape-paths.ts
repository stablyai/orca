export function baseRectPath(width: number, height: number): string {
  return `M0,0 H${width} V${height} H0 Z`
}

export function rectanglePath(width: number, height: number): string {
  return baseRectPath(width, height)
}

export function personPath(width: number, height: number): string {
  const cx = width / 2
  const neckHalf = 12
  const neckY = -10
  const headR = 16
  const neckRight = cx + neckHalf
  const neckLeft = cx - neckHalf
  return (
    `M0,${height}` +
    ` H${width}` +
    ' V0' +
    ` C${width},${neckY * 0.5} ${neckRight + 8},${neckY} ${neckRight},${neckY}` +
    ` A${headR},${headR} 0 1,0 ${neckLeft},${neckY}` +
    ` C${neckLeft - 8},${neckY} 0,${neckY * 0.5} 0,0` +
    ' Z'
  )
}

export function cylinderParts(width: number, height: number): { body: string; topCap: string } {
  const capRy = 16
  const rx = width / 2
  return {
    body:
      'M0,0' +
      ` V${height}` +
      ` A${rx},${capRy} 0 0,0 ${width},${height}` +
      ' V0' +
      ` A${rx},${capRy} 0 0,0 0,0 Z`,
    topCap: `M0,0 A${rx},${capRy} 0 0,1 ${width},0 A${rx},${capRy} 0 0,1 0,0 Z`
  }
}

export function pipeParts(width: number, height: number): { body: string; rightCap: string } {
  const capRx = 16
  const ry = height / 2
  return {
    body:
      'M0,0' +
      ` H${width}` +
      ` A${capRx},${ry} 0 0,1 ${width},${height}` +
      ' H0' +
      ` A${capRx},${ry} 0 0,1 0,0 Z`,
    rightCap: `M${width},0 A${capRx},${ry} 0 0,1 ${width},${height} A${capRx},${ry} 0 0,1 ${width},0 Z`
  }
}

export function trapezoidPath(width: number, height: number): string {
  const extend = 24
  return `M0,0 H${width} L${width + extend},${height} H${-extend} Z`
}

export function bucketParts(width: number, height: number): { body: string; topCap: string } {
  const capRy = 16
  const extend = 24
  const rx = (width + 2 * extend) / 2
  const bottomRx = width / 2
  return {
    body:
      `M${-extend},0` +
      ` A${rx},${capRy} 0 0,1 ${width + extend},0` +
      ` L${width},${height}` +
      ` A${bottomRx},${capRy} 0 0,1 0,${height}` +
      ' Z',
    topCap:
      `M${-extend},0` +
      ` A${rx},${capRy} 0 0,0 ${width + extend},0` +
      ` A${rx},${capRy} 0 0,0 ${-extend},0 Z`
  }
}

export function hexagonPath(width: number, height: number): string {
  const extend = 24
  return `M0,0 H${width} L${width + extend},${height / 2} L${width},${height} H0 L${-extend},${height / 2} Z`
}
