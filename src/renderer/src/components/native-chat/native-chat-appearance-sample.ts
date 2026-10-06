import { translate } from '@/i18n/i18n'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

// The preview never draws from a user's chat.
export function createNativeChatAppearanceSample(language: string): NativeChatMessage[] {
  return [
    {
      id: 'appearance-preview-user',
      role: 'user',
      source: 'transcript',
      timestamp: new Date(2026, 0, 1, 14, 14).getTime(),
      blocks: [
        {
          type: 'text',
          text: translate(
            'settings.appearance.chat.previewSample.question',
            'Why does `pnpm dev` exit right after it starts on Windows?',
            { lng: language }
          )
        }
      ]
    },
    {
      id: 'appearance-preview-explanation',
      role: 'assistant',
      source: 'transcript',
      timestamp: null,
      blocks: [
        {
          type: 'text',
          text: translate(
            'settings.appearance.chat.previewSample.explanation',
            'Use Node instead of **Unix-only** syntax.',
            { lng: language }
          )
        }
      ]
    },
    {
      id: 'appearance-preview-tools',
      role: 'assistant',
      source: 'transcript',
      timestamp: null,
      blocks: [
        {
          type: 'tool-call',
          name: 'Grep',
          input: { pattern: 'NODE_ENV=', path: 'scripts/' },
          state: 'completed'
        },
        {
          type: 'tool-call',
          name: 'Read',
          input: { file_path: 'package.json' },
          state: 'completed'
        }
      ]
    },
    {
      id: 'appearance-preview-answer',
      role: 'assistant',
      source: 'transcript',
      timestamp: null,
      blocks: [
        {
          type: 'text',
          text: [
            '```json',
            '"scripts": {',
            '  "dev": "node --env-file=.env.development scripts/dev.mjs"',
            '}',
            '```',
            '',
            translate(
              'settings.appearance.chat.previewSample.followUp',
              'Then run `pnpm dev` again.',
              { lng: language }
            )
          ].join('\n')
        }
      ]
    }
  ]
}
