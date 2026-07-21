export type DictationRecoveryAudioChunk = {
  samples: Float32Array
  sampleRate: number
  sessionId: string
}

export function getRecoverableDictationText(insertedText: string, partialText: string): string {
  return [insertedText.trim(), partialText.trim()].filter(Boolean).join(' ')
}

export function encodeRecoveryAudioWav(chunks: DictationRecoveryAudioChunk[]): Uint8Array {
  const sampleRate = chunks[0]?.sampleRate ?? 16_000
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.samples.length, 0)
  const dataBytes = sampleCount * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  let offset = 0

  const writeString = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset, value.charCodeAt(index))
      offset += 1
    }
  }

  writeString('RIFF')
  view.setUint32(offset, 36 + dataBytes, true)
  offset += 4
  writeString('WAVE')
  writeString('fmt ')
  view.setUint32(offset, 16, true)
  offset += 4
  view.setUint16(offset, 1, true)
  offset += 2
  view.setUint16(offset, 1, true)
  offset += 2
  view.setUint32(offset, sampleRate, true)
  offset += 4
  view.setUint32(offset, sampleRate * 2, true)
  offset += 4
  view.setUint16(offset, 2, true)
  offset += 2
  view.setUint16(offset, 16, true)
  offset += 2
  writeString('data')
  view.setUint32(offset, dataBytes, true)
  offset += 4

  for (const chunk of chunks) {
    for (const sample of chunk.samples) {
      const clamped = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      offset += 2
    }
  }

  return new Uint8Array(buffer)
}
