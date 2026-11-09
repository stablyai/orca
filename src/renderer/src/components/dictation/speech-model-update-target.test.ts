import { describe, expect, it } from 'vitest'
import type { SpeechModelManifest, SpeechModelState } from '../../../../shared/speech-types'
import { findSpeechModelUpdateTarget } from './speech-model-update-target'

function model(id: string, extra: Partial<SpeechModelManifest> = {}): SpeechModelManifest {
  return {
    id,
    label: id,
    type: 'transducer',
    provider: 'local',
    language: 'en',
    languages: ['en'],
    sampleRate: 16000,
    streaming: false,
    ...extra
  }
}

const catalog = [
  model('parakeet'),
  model('nemotron'),
  model('zipformer-ko', { replacedBy: 'nemotron' }),
  model('gpt', { provider: 'openai' })
]

function target(sttModel: string, states: SpeechModelState[], enabled = true) {
  const found = findSpeechModelUpdateTarget({ enabled, sttModel }, catalog, states)
  return found && { model: found.model.id, retired: found.retired?.id }
}

describe('findSpeechModelUpdateTarget', () => {
  it('offers the update when only the old files of the selected model are on disk', () => {
    const states: SpeechModelState[] = [
      { id: 'parakeet', status: 'not-downloaded', needsUpdate: true }
    ]
    expect(target('parakeet', states)).toEqual({ model: 'parakeet', retired: undefined })
    expect(target('parakeet', states, false)).toBeNull()
  })

  it('offers the replacement when the retired model it replaced is still downloaded', () => {
    const states: SpeechModelState[] = [
      { id: 'nemotron', status: 'not-downloaded' },
      { id: 'zipformer-ko', status: 'ready' }
    ]
    expect(target('nemotron', states)).toEqual({ model: 'nemotron', retired: 'zipformer-ko' })
    expect(
      target('nemotron', [
        { id: 'nemotron', status: 'ready' },
        { id: 'zipformer-ko', status: 'ready' }
      ])
    ).toBeNull()
  })

  it('stays hidden for cloud models and for people who never downloaded one', () => {
    expect(target('gpt', [{ id: 'zipformer-ko', status: 'ready' }])).toBeNull()
    expect(target('nemotron', [{ id: 'nemotron', status: 'not-downloaded' }])).toBeNull()
  })
})
