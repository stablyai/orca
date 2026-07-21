export function isMissingSelectedDeviceError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')
  )
}

export function getAudioCaptureConstraints(
  inputDeviceId: string | undefined
): MediaStreamConstraints {
  return {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {})
    }
  }
}
