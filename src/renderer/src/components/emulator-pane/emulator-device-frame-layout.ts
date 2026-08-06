export type DeviceFrameKind = 'phone' | 'tablet'

export type StreamSize = {
  width: number
  height: number
}

export type EmulatorDeviceVisualOrientation = 'portrait' | 'landscape'

export type PaneSize = {
  width: number
  height: number
}

export type DeviceFrameLayout = {
  kind: DeviceFrameKind
  width: number
  height: number
  shellWidth: number
  shellHeight: number
  hardwareOutset: number
  bezel: number
  outerRadius: number
  innerRadius: number
  sideButtonThickness: number
}

export type VisualStreamGeometry = {
  aspectRatio: number
  size: StreamSize | null
  streamRotation: -90 | 0 | 90
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))
const FIT_MARGIN_PX = 0.5

export function resolveDeviceFrameKind(
  deviceName: string | undefined,
  screenAspectRatio: number
): DeviceFrameKind {
  if (deviceName && /ipad/i.test(deviceName)) {
    return 'tablet'
  }
  if (deviceName && /iphone/i.test(deviceName)) {
    return 'phone'
  }
  return screenAspectRatio > 0.62 && screenAspectRatio < 1.62 ? 'tablet' : 'phone'
}

export function resolveVisualScreenAspectRatio(
  streamSize: StreamSize | null,
  visualOrientation: EmulatorDeviceVisualOrientation
): number {
  return resolveVisualStreamGeometry(streamSize, visualOrientation).aspectRatio
}

export function resolveVisualStreamGeometry(
  streamSize: StreamSize | null,
  visualOrientation: EmulatorDeviceVisualOrientation
): VisualStreamGeometry {
  // Why: serve-sim can keep the same canvas dimensions after rotate; the pane's
  // physical frame and input rect still need to follow the successful request.
  const width = streamSize?.width ?? 9
  const height = streamSize?.height ?? 19
  const shortSide = Math.min(width, height)
  const longSide = Math.max(width, height)
  const visualSize =
    visualOrientation === 'landscape'
      ? { width: longSide, height: shortSide }
      : { width: shortSide, height: longSide }
  const streamIsLandscape = streamSize ? streamSize.width > streamSize.height : false
  const visualIsLandscape = visualOrientation === 'landscape'
  const streamRotation =
    streamSize && streamIsLandscape !== visualIsLandscape ? (visualIsLandscape ? 90 : -90) : 0
  return {
    aspectRatio: visualSize.width / visualSize.height,
    size: streamSize ? visualSize : null,
    streamRotation
  }
}

function fitScreenToPane(paneSize: PaneSize | null, aspectRatio: number): PaneSize | null {
  if (!paneSize || paneSize.width <= 0 || paneSize.height <= 0 || aspectRatio <= 0) {
    return null
  }

  const paneAspectRatio = paneSize.width / paneSize.height
  if (paneAspectRatio > aspectRatio) {
    return {
      width: Math.max(1, paneSize.height * aspectRatio),
      height: paneSize.height
    }
  }

  return {
    width: paneSize.width,
    height: Math.max(1, paneSize.width / aspectRatio)
  }
}

function measureChrome(screenSize: PaneSize, kind: DeviceFrameKind) {
  const shortSide = Math.min(screenSize.width, screenSize.height)
  const bezel = kind === 'phone' ? clamp(shortSide * 0.021, 7, 15) : clamp(shortSide * 0.026, 8, 22)
  const hardwareOutset = kind === 'phone' ? clamp(shortSide * 0.012, 3, 7) : 0
  const sideButtonThickness = kind === 'phone' ? clamp(shortSide * 0.01, 3, 6) : 0

  return {
    bezel,
    hardwareOutset,
    sideButtonThickness
  }
}

export function fitDeviceFrameToPane(
  paneSize: PaneSize | null,
  screenAspectRatio: number,
  kind: DeviceFrameKind
): DeviceFrameLayout | null {
  if (!paneSize || paneSize.width <= 0 || paneSize.height <= 0 || screenAspectRatio <= 0) {
    return null
  }

  let screenSize = fitScreenToPane(paneSize, screenAspectRatio)
  for (let index = 0; index < 4; index += 1) {
    if (!screenSize) {
      return null
    }
    const chrome = measureChrome(screenSize, kind)
    // Why: fractional aspect-ratio math can overshoot the pane by a sub-pixel,
    // which shows up as clipped hardware in split panes.
    const availableWidth = Math.max(
      1,
      paneSize.width - chrome.hardwareOutset * 2 - chrome.bezel * 2 - FIT_MARGIN_PX
    )
    const availableHeight = Math.max(1, paneSize.height - chrome.bezel * 2 - FIT_MARGIN_PX)
    screenSize = fitScreenToPane(
      {
        width: availableWidth,
        height: availableHeight
      },
      screenAspectRatio
    )
  }

  if (!screenSize) {
    return null
  }

  const { bezel, hardwareOutset, sideButtonThickness } = measureChrome(screenSize, kind)
  const shellWidth = screenSize.width + bezel * 2
  const shellHeight = screenSize.height + bezel * 2
  const shortSide = Math.min(screenSize.width, screenSize.height)
  const outerRadius =
    kind === 'phone' ? clamp(shortSide * 0.135, 44, 92) : clamp(shortSide * 0.065, 24, 56)
  const innerRadius =
    kind === 'phone' ? clamp(outerRadius - bezel, 34, 82) : clamp(outerRadius - bezel * 0.7, 18, 48)

  return {
    kind,
    width: shellWidth + hardwareOutset * 2,
    height: shellHeight,
    shellWidth,
    shellHeight,
    hardwareOutset,
    bezel,
    outerRadius,
    innerRadius,
    sideButtonThickness
  }
}
