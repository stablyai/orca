import { describe, expect, it } from 'vitest'
import {
  buildPacedTypingMeasurement,
  parseKeyArrivalSidecar,
  type KeyArrivalRecord
} from './paced-terminal-typing'

function validMeasurementArgs(): Parameters<typeof buildPacedTypingMeasurement>[0] {
  return {
    keyCount: 2,
    plannedAtBySeq: new Map([
      [1, 1_000],
      [2, 1_020]
    ]),
    sentAtBySeq: new Map([
      [1, 1_003],
      [2, 1_026]
    ]),
    arrivals: new Map<number, KeyArrivalRecord>([
      [1, { seq: 1, atMs: 1_010, char: 'a' }],
      [2, { seq: 2, atMs: 1_035, char: 'b' }]
    ]),
    echoSeenAt: new Map([
      [1, 1_014],
      [2, 1_041]
    ]),
    maxTimerDriftMs: 7
  }
}

describe('parseKeyArrivalSidecar', () => {
  it('parses character-attributed arrival records', () => {
    const arrivals = parseKeyArrivalSidecar(
      '{"seq":1,"atMs":1010,"char":"a"}\n{"seq":2,"atMs":1035,"char":"b"}\n'
    )

    expect([...arrivals]).toEqual([
      [1, { seq: 1, atMs: 1_010, char: 'a' }],
      [2, { seq: 2, atMs: 1_035, char: 'b' }]
    ])
  })

  it('ignores only a torn final write', () => {
    const arrivals = parseKeyArrivalSidecar('{"seq":1,"atMs":1010,"char":"a"}\n{"seq":2,"atMs"')

    expect([...arrivals.keys()]).toEqual([1])
    expect(() => parseKeyArrivalSidecar('{bad}\n{"seq":1')).toThrow(
      'Invalid typing arrival sidecar line 1'
    )
  })

  it.each([
    ['missing character', '{"seq":1,"atMs":1010}\n'],
    ['noninteger sequence', '{"seq":1.5,"atMs":1010,"char":"a"}\n'],
    ['non-finite timestamp', '{"seq":1,"atMs":"1010","char":"a"}\n'],
    ['empty character', '{"seq":1,"atMs":1010,"char":""}\n']
  ])('rejects a %s', (_label, raw) => {
    expect(() => parseKeyArrivalSidecar(raw)).toThrow('Invalid typing arrival record on line 1')
  })

  it('rejects duplicate sequence attribution', () => {
    expect(() =>
      parseKeyArrivalSidecar('{"seq":1,"atMs":1010,"char":"a"}\n{"seq":1,"atMs":1011,"char":"b"}\n')
    ).toThrow('Duplicate typing arrival sequence 1')
  })
})

describe('buildPacedTypingMeasurement', () => {
  it('reports schedule delay and both arrival phases', () => {
    const measurement = buildPacedTypingMeasurement(validMeasurementArgs())

    expect(measurement).toMatchObject({
      dispatchModel: 'absolute-targets-serialized-cdp',
      echoObservation: 'xterm-buffer-poll',
      keyCount: 2,
      dispatchDelayMs: { count: 2, max: 6 },
      plannedToPtyArrivalMs: { count: 2, max: 15 },
      plannedToBufferEchoMs: { count: 2, max: 21 },
      totalMs: { count: 2, max: 15 },
      inputHalfMs: { count: 2, max: 9 },
      echoHalfMs: { count: 2, max: 6 },
      maxTimerDriftMs: 7
    })
    expect(measurement.samples).toEqual([
      {
        seq: 1,
        expectedChar: 'a',
        receivedChar: 'a',
        plannedAt: 1_000,
        sentAt: 1_003,
        ptyArrivedAt: 1_010,
        echoSeenAt: 1_014,
        dispatchDelayMs: 3,
        plannedToPtyArrivalMs: 10,
        plannedToBufferEchoMs: 14
      },
      {
        seq: 2,
        expectedChar: 'b',
        receivedChar: 'b',
        plannedAt: 1_020,
        sentAt: 1_026,
        ptyArrivedAt: 1_035,
        echoSeenAt: 1_041,
        dispatchDelayMs: 6,
        plannedToPtyArrivalMs: 15,
        plannedToBufferEchoMs: 21
      }
    ])
  })

  it('rejects missing and unexpected sequences', () => {
    const missing = validMeasurementArgs()
    missing.arrivals = new Map([[1, { seq: 1, atMs: 1_010, char: 'a' }]])
    expect(() => buildPacedTypingMeasurement(missing)).toThrow(
      'PTY arrival sequence mismatch: missing [2], unexpected []'
    )

    const unexpected = validMeasurementArgs()
    unexpected.echoSeenAt = new Map([...unexpected.echoSeenAt, [3, 1_050]])
    expect(() => buildPacedTypingMeasurement(unexpected)).toThrow(
      'buffer echo sequence mismatch: missing [], unexpected [3]'
    )
  })

  it('rejects a received character attributed to the wrong sequence', () => {
    const args = validMeasurementArgs()
    args.arrivals = new Map([
      [1, { seq: 1, atMs: 1_010, char: 'a' }],
      [2, { seq: 2, atMs: 1_035, char: 'x' }]
    ])

    expect(() => buildPacedTypingMeasurement(args)).toThrow(
      'Typing sample 2 received "x", expected "b"'
    )
  })

  it('rejects invalid clock ordering and non-finite timestamps', () => {
    const reversed = validMeasurementArgs()
    reversed.echoSeenAt = new Map([
      [1, 1_009],
      [2, 1_041]
    ])
    expect(() => buildPacedTypingMeasurement(reversed)).toThrow(
      'Typing sample 1 has invalid clock order'
    )

    const nonFinite = validMeasurementArgs()
    nonFinite.sentAtBySeq = new Map([
      [1, Number.NaN],
      [2, 1_026]
    ])
    expect(() => buildPacedTypingMeasurement(nonFinite)).toThrow(
      'Typing sample 1 has a non-finite timestamp'
    )
  })
})
