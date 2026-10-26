// Selected Jcode 0.99.0 captured payloads; local paths replaced with neutral paths.

export const skunkId = 'session_skunk_1792604312924_a75443e0fd91bbda'

// Synthetic metadata from documented Skunk root identity; no session JSON was captured.
export const skunkMetadata = {
  id: skunkId,
  parent_id: null,
  short_name: 'skunk',
  status: 'Active'
} as const

export const skunkHooks = {
  sessionStart: {
    cwd: '/tmp/jcapt-cwd',
    event: 'session_start',
    model: 'claude-opus-5-5',
    session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
    source: 'create'
  },
  turnStartA: {
    cwd: '/tmp/jcapt-cwd',
    event: 'turn_start',
    model: 'claude-opus-5-5',
    session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
    source: 'chat'
  },
  postToolWrite: {
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '4',
    event: 'post_tool',
    output_bytes: '141',
    session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
    status: 'ok',
    tool_call_id: 'toolu_01TZBbR67P4rUjBmfNMGPpQa',
    tool_input:
      '{"content":"one","file_path":"edit-me.txt","intent":"Create edit-me.txt with text one"}',
    tool_name: 'write',
    touched_paths: '/tmp/jcapt-cwd/edit-me.txt'
  },
  turnEndA: {
    cache_read_tokens: '85906',
    cache_write_tokens: '589',
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '12632',
    event: 'turn_end',
    input_tokens: '616',
    last_assistant_text:
      'I created `edit-me.txt` containing exactly `one`, with no trailing newline.',
    model: 'claude-opus-5-5',
    output_tokens: '138',
    prompt_tokens: '87111',
    session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
    status: 'ok'
  },
  turnStartB: {
    cwd: '/tmp/jcapt-cwd',
    event: 'turn_start',
    model: 'claude-opus-5-5',
    session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
    source: 'chat'
  },
  postToolEdit: {
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '7',
    event: 'post_tool',
    output_bytes: '242',
    session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
    status: 'ok',
    tool_call_id: 'toolu_01Aq9vx9AuxozZMjnkqFF2V3',
    tool_input:
      '{"file_path":"edit-me.txt","intent":"Replace one with two","new_string":"two","old_string":"one"}',
    tool_name: 'edit',
    touched_paths: '/tmp/jcapt-cwd/edit-me.txt'
  },
  turnEndB: {
    cache_read_tokens: '87247',
    cache_write_tokens: '344',
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '4731',
    event: 'turn_end',
    input_tokens: '236',
    last_assistant_text: 'done',
    model: 'claude-opus-5-5',
    output_tokens: '131',
    prompt_tokens: '87827',
    session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
    status: 'ok'
  },
  turnStartC: {
    cwd: '/tmp/jcapt-cwd',
    event: 'turn_start',
    model: 'claude-opus-5-5',
    session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
    source: 'chat'
  }
} as const

export const usageA = {
  inputTokens: 616,
  outputTokens: 138,
  cacheReadTokens: 85906,
  cacheWriteTokens: 589,
  durationMs: 12632
} as const

export const usageB = {
  inputTokens: 236,
  outputTokens: 131,
  cacheReadTokens: 87247,
  cacheWriteTokens: 344,
  durationMs: 4731
} as const
