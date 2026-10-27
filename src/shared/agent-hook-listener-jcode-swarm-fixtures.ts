// Selected Jcode 0.99.0 payloads only; tests label mutations as negative controls.

export const tigressHooks = [
  {
    cwd: '/tmp/jcapt-cwd',
    event: 'session_start',
    model: 'claude-opus-5-5',
    session_id: 'session_tigress_1792603131095_636843aadc1b740b',
    source: 'create'
  },
  {
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '206',
    event: 'post_tool',
    output_bytes: '54',
    session_id: 'session_tigress_1792603131095_636843aadc1b740b',
    status: 'ok',
    tool_call_id: 'toolu_01MTzF23AooBwhxhQUGNXSEm',
    tool_input: '{"command":"rtk ls","intent":"List the working directory contents as requested"}',
    tool_name: 'bash',
    touched_paths: ''
  },
  {
    cwd: '/tmp/jcapt-cwd',
    event: 'session_start',
    model: 'claude-opus-5-5',
    session_id: 'session_retriever_1792603161400_81ad62e08be2201b',
    source: 'create'
  },
  {
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '37',
    event: 'post_tool',
    output_bytes: '67',
    session_id: 'session_tigress_1792603131095_636843aadc1b740b',
    status: 'ok',
    tool_call_id: 'debug-1792603161350',
    tool_input:
      '{"action":"spawn","effort":"low","label":"cap-worker","model":"claude-haiku-5-5","prompt":"Reply with exactly the text worker-ok. Do not use any tools.","spawn_mode":"inline"}',
    tool_name: 'swarm',
    touched_paths: ''
  },
  {
    cwd: '/tmp/jcapt-cwd',
    event: 'turn_start',
    model: 'claude-haiku-5-5',
    session_id: 'session_retriever_1792603161400_81ad62e08be2201b',
    source: 'chat'
  },
  {
    cache_read_tokens: '43043',
    cache_write_tokens: '0',
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '7029',
    event: 'turn_end',
    input_tokens: '588',
    last_assistant_text: 'worker-ok',
    model: 'claude-haiku-5-5',
    output_tokens: '486',
    prompt_tokens: '43631',
    session_id: 'session_retriever_1792603161400_81ad62e08be2201b',
    status: 'ok'
  }
] as const

export const dolphinHooks = [
  {
    cwd: '/tmp/jcapt-cwd',
    event: 'session_start',
    model: 'claude-opus-5-5',
    session_id: 'session_dolphin_1792604653239_b7163b5db66f91d4',
    source: 'create'
  },
  {
    cwd: '/tmp/jcapt-cwd',
    event: 'session_start',
    model: 'claude-opus-5-5',
    session_id: 'session_octopus_1792604664841_9f9f4e72970e146f',
    source: 'create'
  },
  {
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '20',
    event: 'post_tool',
    output_bytes: '65',
    session_id: 'session_dolphin_1792604653239_b7163b5db66f91d4',
    status: 'ok',
    tool_call_id: 'debug-1792604664805',
    tool_input:
      '{"action":"spawn","effort":"low","intent":"capture worker lifecycle","label":"lifecycle-w","model":"claude-oauth:claude-haiku-5-5","prompt":"Reply with exactly: w4-ok"}',
    tool_name: 'swarm',
    touched_paths: ''
  },
  {
    cwd: '/tmp/jcapt-cwd',
    event: 'turn_start',
    model: 'claude-haiku-5-5',
    session_id: 'session_octopus_1792604664841_9f9f4e72970e146f',
    source: 'chat'
  },
  {
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '0',
    event: 'post_tool',
    output_bytes: '106',
    session_id: 'session_octopus_1792604664841_9f9f4e72970e146f',
    status: 'ok',
    tool_call_id: 'toolu_012hjqp6LC4SHgFKCDLQfnyx',
    tool_input:
      '{"action":"report","intent":"Submit required swarm completion report","message":"w4 lane complete. Replied with requested sentinel.","status":"completed","validation":"None run. No code changed; task was a single reply."}',
    tool_name: 'swarm',
    touched_paths: ''
  },
  {
    cache_read_tokens: '86086',
    cache_write_tokens: '809',
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '6509',
    event: 'turn_end',
    input_tokens: '721',
    last_assistant_text: 'w4-ok',
    model: 'claude-haiku-5-5',
    output_tokens: '367',
    prompt_tokens: '87616',
    session_id: 'session_octopus_1792604664841_9f9f4e72970e146f',
    status: 'ok'
  },
  {
    cwd: '/tmp/jcapt-cwd',
    event: 'session_end',
    model: 'claude-haiku-5-5',
    session_id: 'session_octopus_1792604664841_9f9f4e72970e146f',
    source: 'close'
  },
  {
    cwd: '/tmp/jcapt-cwd',
    duration_ms: '6',
    event: 'post_tool',
    output_bytes: '61',
    session_id: 'session_dolphin_1792604653239_b7163b5db66f91d4',
    status: 'ok',
    tool_call_id: 'debug-1792604686963',
    tool_input:
      '{"action":"stop","intent":"stop worker","target_session":"session_octopus_1792604664841_9f9f4e72970e146f"}',
    tool_name: 'swarm',
    touched_paths: ''
  },
  {
    cwd: '/tmp/jcapt-cwd',
    event: 'session_end',
    model: 'claude-opus-5-5',
    session_id: 'session_dolphin_1792604653239_b7163b5db66f91d4',
    source: 'close'
  }
] as const

export const rootMetadata = {
  id: 'session_tigress_1792603131095_636843aadc1b740b',
  parent_id: null,
  short_name: 'tigress',
  title: 'Run ls in the cwd with the bash tool, then reply with the single\u2026',
  model: 'claude-haiku-5-5',
  status: 'Active'
} as const

export const workerMetadata = {
  id: 'session_retriever_1792603161400_81ad62e08be2201b',
  parent_id: 'session_tigress_1792603131095_636843aadc1b740b',
  short_name: 'retriever',
  title: 'Reply with exactly the text worker-ok. Do not use any tools.',
  model: 'claude-haiku-5-5',
  status: 'Active'
} as const
