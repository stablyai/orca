export type NativePowerPointPreviewResult =
  | { status: 'rendered'; contentBase64: string }
  | { status: 'unavailable'; reason: string }

export type NativePowerPointPreviewRequest = {
  contentBase64: string
  requestToken: string
}

export type NativePowerPointPreviewCancelRequest = {
  requestToken: string
}
