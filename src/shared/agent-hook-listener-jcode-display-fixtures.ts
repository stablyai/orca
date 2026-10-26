import { makePaneKey } from './stable-pane-id'

// Selected Jcode 0.99.0 capture2 fields; pane keys use test-local identities.
export const displayRootId = 'session_pawprint_1792604760602_81cf383ab5bbf2d4'
export const displayWorkerId = 'session_piglet_1792604760697_211acdce5650ace5'
export const throwawayId = 'session_bonehound_1792604760755_aecccf6c235843ea'
export const childPane = makePaneKey('tab-child', '22222222-2222-4222-8222-222222222222')
export const movedPane = makePaneKey('tab-moved', '33333333-3333-4333-8333-333333333333')

export const pawprintStart = {
  event: 'session_start',
  model: 'claude-opus-5-5',
  session_id: displayRootId,
  source: 'create'
} as const
export const pigletStart = {
  event: 'session_start',
  model: 'claude-haiku-5-5',
  session_id: displayWorkerId,
  source: 'resume'
} as const
export const pigletTurn = {
  event: 'turn_start',
  model: 'claude-haiku-5-5',
  session_id: displayWorkerId,
  source: 'chat'
} as const
export const pigletLateTool = {
  event: 'post_tool',
  session_id: displayWorkerId,
  tool_name: 'bash',
  status: 'ok',
  duration_ms: '30003',
  tool_input: '{"command":"sleep 30","intent":"Run requested 30 second sleep"}'
} as const
export const bonehoundHooks = [
  { event: 'session_start', session_id: throwawayId, source: 'create' },
  { event: 'session_end', session_id: throwawayId, source: 'close' }
] as const
export const displayMetadata = [
  { id: displayRootId, parent_id: null, model: 'claude-opus-5-5', status: 'Active' },
  { id: displayWorkerId, parent_id: null, model: 'claude-haiku-5-5', status: 'Active' }
] as const
