// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import {
  resetNativeChatAttachmentNotesForTests,
  setNativeChatAttachmentNotes,
  withNativeChatAttachmentNotes
} from './native-chat-attachment-notes'

beforeEach(() => {
  localStorage.clear()
  resetNativeChatAttachmentNotesForTests()
})

it('adds each marked image’s numbered notes after the message text when it is sent', () => {
  setNativeChatAttachmentNotes('agent-session:a', 'img-1', {
    mediaName: 'dashboard.png',
    source: { path: '/tmp/dashboard.png' },
    kind: 'image',
    offset: 0,
    notes: [
      { id: 'n1', number: 1, text: 'Align these cards', mark: { kind: 'pin', x: 0.2, y: 0.3 } },
      {
        id: 'n2',
        number: 2,
        text: 'Too much\nspace here',
        mark: { kind: 'box', x: 0.5, y: 0.5, width: 0.2, height: 0.1 }
      }
    ]
  })

  expect(withNativeChatAttachmentNotes('Please fix.', 'agent-session:a', ['img-1', 'img-2'])).toBe(
    'Please fix.\n\nNotes on dashboard.png (numbered marks in the attached image):\n1. Align these cards\n2. Too much space here'
  )
  // Another chat's message, or one without the marked image, is sent unchanged.
  expect(withNativeChatAttachmentNotes('Hi', 'agent-session:b', ['img-1'])).toBe('Hi')
})
