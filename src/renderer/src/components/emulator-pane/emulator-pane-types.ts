export type SimulatorDeviceRow = {
  name: string
  udid: string
  state: string
  runtime?: string
  isAvailable?: boolean
}

export type EmulatorStreamInfo = {
  deviceUdid?: string
  device?: string
  displayName?: string
  streamUrl?: string
  url?: string
  wsUrl?: string
  state?: string
}

export type EmulatorPaneSession = {
  attached: boolean
  info?: EmulatorStreamInfo
}

export function deviceLabel(
  device: SimulatorDeviceRow | EmulatorStreamInfo | string | undefined
): string {
  if (!device) {
    return 'Mobile Emulator'
  }
  if (typeof device === 'string') {
    return device.length > 20 && device.includes('-') ? 'Mobile Emulator' : device
  }
  if ('displayName' in device && device.displayName) {
    return device.displayName
  }
  if ('name' in device && device.name) {
    return device.name
  }
  if ('device' in device && device.device && !device.device.includes('-')) {
    return device.device
  }
  return 'Mobile Emulator'
}

/** Resolve the MJPEG endpoint serve-sim exposes for the live phone preview. */
export function simulatorPreviewStreamUrl(info?: EmulatorStreamInfo): string | undefined {
  if (!info) {
    return undefined
  }
  if (info.streamUrl) {
    return info.streamUrl
  }
  if (info.url) {
    const base = info.url.replace(/\/$/, '')
    return `${base}/stream.mjpeg`
  }
  return undefined
}

export function pickDefaultDevice(devices: SimulatorDeviceRow[]): SimulatorDeviceRow | null {
  const available = devices.filter((d) => d.isAvailable !== false)
  const booted = available.filter((d) => d.state === 'Booted')
  const bootedIphone = booted.find((d) => /iPhone/i.test(d.name || ''))
  return (
    bootedIphone ||
    booted[0] ||
    available.find((d) => /iPhone/i.test(d.name || '')) ||
    available[0] ||
    devices[0] ||
    null
  )
}

export const isMacOs = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
