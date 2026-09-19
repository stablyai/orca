import { useAppStore } from '@/store'

// Why: the Settings sidebar registry and the Settings page must agree on whether
// the Plane section is visible; sharing this selector keeps the nav entry and
// the rendered section from drifting.
export function usePlaneProviderConnected(): boolean {
  return useAppStore((state) => state.planeStatus.connected)
}
