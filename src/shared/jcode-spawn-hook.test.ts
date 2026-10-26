import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseJcodeSpawnRequest } from './jcode-spawn-hook'

function capturedRequest() {
  return {
    paneKey: 'tab_a:11111111-1111-4111-8111-111111111111',
    paneSecret: randomBytes(32).toString('hex'),
    worktreeId: 'test-worktree',
    kind: 'swarm-agent',
    command:
      "'/home/user/.local/bin/jcode' '--fresh-spawn' '--provider' 'claude' '--resume' 'session_piglet_1792604760697_211acdce5650ace5'",
    sessionId: 'session_piglet_1792604760697_211acdce5650ace5',
    coordinatorSessionId: 'session_pawprint_1792604760602_81cf383ab5bbf2d4',
    title: '🐽 jcode/castle Piglet',
    cwd: '/tmp/test-cwd',
    runtimeDir: '/tmp/test-runtime'
  }
}

describe('parseJcodeSpawnRequest', () => {
  it('accepts captured piglet fields without changing text', () => {
    const request = capturedRequest()
    expect(JSON.stringify(parseJcodeSpawnRequest(request)) === JSON.stringify(request)).toBe(true)
  })

  it('ignores obsolete fields from older installed scripts', () => {
    const request = capturedRequest()
    expect(
      JSON.stringify(
        parseJcodeSpawnRequest({
          ...request,
          tabId: 'old-tab',
          launchToken: randomBytes(32).toString('hex')
        })
      ) === JSON.stringify(request)
    ).toBe(true)
  })

  it('passes future spawn kinds through', () => {
    expect(parseJcodeSpawnRequest({ ...capturedRequest(), kind: 'future-kind' })?.kind).toBe(
      'future-kind'
    )
  })

  it.each([
    ['paneKey', 'capture-test2'],
    ['paneKey', `${'a'.repeat(200)}:11111111-1111-4111-8111-111111111111`],
    ['paneSecret', undefined],
    ['paneSecret', ''],
    ['paneSecret', 'x'.repeat(129)],
    ['sessionId', '../../etc/passwd'],
    ['sessionId', ' session_x'],
    ['sessionId', 'session_x\n'],
    ['coordinatorSessionId', ' session_x'],
    ['coordinatorSessionId', 'session_x\n'],
    ['sessionId', 'x'.repeat(201)],
    ['command', ''],
    ['command', 'x'.repeat(16385)],
    ['kind', ''],
    ['kind', 'x'.repeat(201)],
    ['title', 'x'.repeat(513)],
    ['cwd', 'x'.repeat(4097)],
    ['runtimeDir', 'x'.repeat(4097)],
    ['worktreeId', 'x'.repeat(201)],
    ['coordinatorSessionId', 'x'.repeat(201)],
    ['title', 42]
  ])('rejects negative control %s (case %#)', (field, value) => {
    expect(parseJcodeSpawnRequest({ ...capturedRequest(), [field]: value }) === null).toBe(true)
  })

  it.each([null, [], 'body', 42])('rejects a non-record body (case %#)', (body) => {
    expect(parseJcodeSpawnRequest(body)).toBeNull()
  })

  it('normalizes empty optional fields to undefined', () => {
    const parsed = parseJcodeSpawnRequest({
      ...capturedRequest(),
      worktreeId: '',
      coordinatorSessionId: '',
      title: '',
      cwd: '',
      runtimeDir: ''
    })
    expect(parsed !== null).toBe(true)
    expect([
      parsed?.worktreeId,
      parsed?.coordinatorSessionId,
      parsed?.title,
      parsed?.cwd,
      parsed?.runtimeDir
    ]).toEqual(Array(5).fill(undefined))
  })

  it('accepts omitted optional fields and exact field caps', () => {
    const request = capturedRequest()
    expect(
      parseJcodeSpawnRequest({
        paneKey: request.paneKey,
        paneSecret: randomBytes(64).toString('hex'),
        sessionId: request.sessionId,
        kind: 'x'.repeat(200),
        command: 'x'.repeat(16384),
        title: 'x'.repeat(512),
        cwd: 'x'.repeat(4096),
        runtimeDir: 'x'.repeat(4096)
      }) !== null
    ).toBe(true)
  })
})
