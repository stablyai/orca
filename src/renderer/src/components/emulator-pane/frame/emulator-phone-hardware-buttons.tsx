import type { DeviceFrameLayout } from './emulator-device-frame-layout'

export function PhoneHardwareButtons({ layout }: { layout: DeviceFrameLayout }) {
  const buttonInset = layout.hardwareOutset - layout.sideButtonThickness
  const sideButtonThickness = `${layout.sideButtonThickness}px`
  const actionHeight = `${Math.max(18, Math.min(34, layout.shellHeight * 0.04))}px`
  const volumeHeight = `${Math.max(34, Math.min(64, layout.shellHeight * 0.08))}px`
  const powerHeight = `${Math.max(42, Math.min(76, layout.shellHeight * 0.095))}px`
  const leftStyle = {
    left: `${buttonInset}px`,
    width: sideButtonThickness
  }
  const rightStyle = {
    right: `${buttonInset}px`,
    width: sideButtonThickness
  }

  return (
    <>
      <div
        aria-hidden="true"
        className="absolute rounded-l-sm bg-black/80"
        style={{
          ...leftStyle,
          top: `${layout.shellHeight * 0.16}px`,
          height: actionHeight
        }}
      />
      <div
        aria-hidden="true"
        className="absolute rounded-l-sm bg-black/80"
        style={{
          ...leftStyle,
          top: `${layout.shellHeight * 0.24}px`,
          height: volumeHeight
        }}
      />
      <div
        aria-hidden="true"
        className="absolute rounded-l-sm bg-black/80"
        style={{
          ...leftStyle,
          top: `${layout.shellHeight * 0.33}px`,
          height: volumeHeight
        }}
      />
      <div
        aria-hidden="true"
        className="absolute rounded-r-sm bg-black/80"
        style={{
          ...rightStyle,
          top: `${layout.shellHeight * 0.24}px`,
          height: powerHeight
        }}
      />
    </>
  )
}
