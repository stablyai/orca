import { describe, expect, it } from 'vitest'
import type { SpeechModelManifest } from '../../../../../shared/speech-types'
import { voiceSpeechModelRows } from './voice-speech-model-rows'

const model = (
  id: string,
  languages: string[],
  extra: Partial<SpeechModelManifest> = {}
): SpeechModelManifest => ({
  id,
  label: id,
  type: 'transducer',
  provider: 'local',
  language: 'multilingual',
  languages,
  sampleRate: 16000,
  streaming: false,
  ...extra
})

describe('voiceSpeechModelRows', () => {
  it('puts models without the language last and lists retired models only while on disk', () => {
    const catalog = [
      model('english-only', ['en']),
      model('retired-on-disk', ['ko'], { replacedBy: 'korean' }),
      model('korean', ['en', 'ko']),
      model('retired-gone', ['ko'], { replacedBy: 'korean' }),
      model('cloud', ['ko'], { provider: 'openai' })
    ]
    const rows = voiceSpeechModelRows(
      catalog,
      [{ id: 'retired-on-disk', status: 'ready' }],
      'local',
      'ko'
    )
    expect(rows.map((row) => row.manifest.id)).toEqual([
      'korean',
      'english-only',
      'retired-on-disk'
    ])
  })
})
