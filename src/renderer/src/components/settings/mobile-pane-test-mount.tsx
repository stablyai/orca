import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PairedMobileDevice } from '../mobile/paired-mobile-devices'
import { MobilePane } from './MobilePane'

// Why not RTL render: these tests unmount mid-flight to prove a late resolve
// cannot toast after unmount, which needs a root handle RTL does not expose.
const mountedRoots: Root[] = []

export function pairedDevice(deviceId: string): PairedMobileDevice {
  return {
    deviceId,
    name: deviceId,
    pairedAt: 1,
    lastSeenAt: 2
  }
}

export async function renderMobilePane(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<MobilePane />)
  })
}

export async function unmountMobilePaneRoots(): Promise<void> {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount()
    }
  })
}
