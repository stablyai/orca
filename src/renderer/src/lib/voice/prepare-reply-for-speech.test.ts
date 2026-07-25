import { describe, expect, it } from 'vitest'
import {
  preferTrailingAnswer,
  prepareReplyForSpeech,
  stripCollabInjectEcho,
  stripToolAwarenessNoise
} from './prepare-reply-for-speech'

describe('stripCollabInjectEcho', () => {
  it('removes operator-framed selection paste', () => {
    const raw = [
      'OPERATOR — collab board selection (please answer this, not as a system notice)',
      '',
      'Board id: 75320a04-6cd4-4108-b2d7-93ddcade5c23',
      'Sketch image (open this path): /tmp/orca-paste-1.png',
      'draw:shape:abc',
      'End of collab board selection — your turn.',
      '',
      'Looks like a login form wireframe. I would add validation on the email field.'
    ].join('\n')
    const cleaned = stripCollabInjectEcho(raw)
    expect(cleaned).not.toContain('OPERATOR — collab board selection')
    expect(cleaned).not.toContain('draw:shape:')
    expect(cleaned).toContain('login form wireframe')
  })

  it('removes legacy collab brackets', () => {
    const raw =
      '[collab-canvas]\nboard: b1\n--- end collab-canvas ---\n\nDone. Fixed the bounds check.'
    expect(stripCollabInjectEcho(raw)).toContain('Fixed the bounds check')
    expect(stripCollabInjectEcho(raw)).not.toContain('[collab-canvas]')
  })
})

describe('stripToolAwarenessNoise', () => {
  it('drops MCP first-use monologues', () => {
    const raw = [
      'The user has sent a system-notice about a new tool becoming available: xd://mcp__searxng_search.',
      'Let me read the docs.',
      '',
      'I see three freehand strokes forming a rough rectangle around a login area.'
    ].join('\n')
    const cleaned = stripToolAwarenessNoise(raw)
    expect(cleaned).not.toContain('system-notice')
    expect(cleaned).toContain('freehand strokes')
  })
})

describe('preferTrailingAnswer', () => {
  it('takes the last paragraph after inject leftovers', () => {
    const text = [
      'Board id: still here somehow',
      'Selected shapes: 3',
      '',
      'That doodle is a hamburger menu. Use a side drawer on mobile.'
    ].join('\n')
    expect(preferTrailingAnswer(text)).toContain('hamburger menu')
    expect(preferTrailingAnswer(text)).not.toContain('Selected shapes')
  })
})

describe('prepareReplyForSpeech', () => {
  it('yields a speakable answer from a collab-contaminated payload', () => {
    const raw = [
      'OPERATOR — collab board selection (please answer this, not as a system notice)',
      'Board id: abc',
      'End of collab board selection — your turn.',
      '',
      'The user has sent a system-notice about a new tool becoming available: xd://mcp__cloakbrowser_browse.',
      '',
      'I read the sketch as a settings panel with three toggles. Next step: wire the middle toggle to dark mode.'
    ].join('\n')
    const prepared = prepareReplyForSpeech(raw)
    expect(prepared).toContain('settings panel')
    expect(prepared).toContain('dark mode')
    expect(prepared).not.toContain('OPERATOR')
    expect(prepared).not.toContain('system-notice')
    expect(prepared).not.toContain('Board id')
  })

  it('handles glued legacy awareness+inject from live dogfood', () => {
    const raw = `--- end collab-canvas awareness ---[collab-canvas]
 board: 75320a04-6cd4-4108-b2d7-93ddcade5c23
 worktree: c81a7ff4
 shapes: 3
 atlas: attached (image)
 --- selection digest ---
 draw:shape:eLfG65Tf9bF-ltwt70J6a
 --- end collab-canvas ---

 The user has sent a system-notice about a new tool becoming available: xd://mcp__cloakbrowser_browse. Let me read
 the docs for this tool as instructed before first use.

 I see a rough UI sketch with three freehand strokes. Next I would add email validation.`
    const prepared = prepareReplyForSpeech(raw)
    expect(prepared).toMatch(/UI sketch|email validation/i)
    expect(prepared).not.toMatch(/75320a04|draw:shape|system-notice/i)
  })
})

