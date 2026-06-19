export type MobilePageStage = 'intro' | 'paired' | 'flow'

export type MobilePageDeviceRefreshState = {
  stage: MobilePageStage | null
  deviceCountAtPairStart: number | null
  nextDeviceCount: number
}

export function shouldShowPairedAfterDeviceRefresh({
  stage,
  deviceCountAtPairStart,
  nextDeviceCount
}: MobilePageDeviceRefreshState): boolean {
  return (
    stage === 'flow' && deviceCountAtPairStart !== null && nextDeviceCount > deviceCountAtPairStart
  )
}
