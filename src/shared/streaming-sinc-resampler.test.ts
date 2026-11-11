import { describe, expect, it } from 'vitest'
import { StreamingSincResampler } from './streaming-sinc-resampler'

function tone(frequency: number, sampleRate: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, index) =>
    Math.sin((2 * Math.PI * frequency * index) / sampleRate)
  )
}

function amplitudeAt(samples: Float32Array, frequency: number, sampleRate: number): number {
  let real = 0
  let imaginary = 0
  for (let index = 0; index < samples.length; index += 1) {
    const phase = (2 * Math.PI * frequency * index) / sampleRate
    real += samples[index] * Math.cos(phase)
    imaginary += samples[index] * Math.sin(phase)
  }
  return (2 * Math.hypot(real, imaginary)) / samples.length
}

function resampleInBlocks(input: Float32Array, inputRate: number, blockSize: number): Float32Array {
  const resampler = new StreamingSincResampler(inputRate, 16000)
  const output: number[] = []
  for (let offset = 0; offset < input.length; offset += blockSize) {
    output.push(...resampler.process(input.subarray(offset, offset + blockSize)))
  }
  return Float32Array.from(output)
}

describe('StreamingSincResampler', () => {
  it.each([48000, 44100])('keeps speech and filters what would alias from %i Hz', (rate) => {
    // Skip the filter's start-up so only steady-state output is measured.
    const speech = resampleInBlocks(tone(1000, rate, rate), rate, 128).subarray(1000, 15000)
    const aboveNyquist = resampleInBlocks(tone(10000, rate, rate), rate, 128).subarray(1000, 15000)

    expect(amplitudeAt(speech, 1000, 16000)).toBeCloseTo(1, 2)
    // A 10 kHz tone folds onto 6 kHz at 16 kHz; plain decimation leaves it at full amplitude.
    expect(amplitudeAt(aboveNyquist, 6000, 16000)).toBeLessThan(0.001)
  })
})
