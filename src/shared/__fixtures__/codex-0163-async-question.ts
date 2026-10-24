import type { NativeChatMessage } from '../native-chat-types'

// Codex 0.163.0, captured 2026-10-23; verbatim public-safe call/result records.
export const recordedCodexAsyncRaw = String.raw`{"timestamp":"2026-10-23T23:53:36.761Z","ordinal":24,"type":"response_item","payload":{"type":"function_call","status":"completed","id":"fc_067d7e5a09f157b4016adbf3804b70819ba88658ac07e59954","name":"request_user_input_async","arguments":"{\"questions\":[{\"title\":\"Which should I summarize?\",\"options\":[\"Summarize the prior acknowledgement\",\"Summarize this request\"]}]}","call_id":"call_7e8623c60ca34bd98a8cb62c29d47eb9","internal_chat_message_metadata_passthrough":{"turn_id":"01a16b2e-3aa2-7b21-bc76-7ae510ff0eb0","create_time":1792799616.301736}},"metadata":{"client_authored":false,"user_input_order":3}}
{"timestamp":"2026-10-23T23:53:37.022Z","ordinal":27,"type":"response_item","payload":{"type":"function_call_output","id":"fco_01a16b2f-2ffe-7392-b3e1-0ece1eae753c","call_id":"call_7e8623c60ca34bd98a8cb62c29d47eb9","output":"{\"accepted\":true}","internal_chat_message_metadata_passthrough":{"turn_id":"01a16b2e-3aa2-7b21-bc76-7ae510ff0eb0","create_time":1792799617.022864}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}}`

export const recordedCodexAsyncMessages: NativeChatMessage[] = [
  {
    id: 'fc_067d7e5a09f157b4016adbf3804b70819ba88658ac07e59954',
    role: 'assistant',
    blocks: [
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        input:
          '{"questions":[{"title":"Which should I summarize?","options":["Summarize the prior acknowledgement","Summarize this request"]}]}',
        callId: 'call_7e8623c60ca34bd98a8cb62c29d47eb9'
      }
    ],
    timestamp: 1792799616761,
    source: 'transcript'
  },
  {
    id: 'fco_01a16b2f-2ffe-7392-b3e1-0ece1eae753c',
    role: 'tool',
    blocks: [
      {
        type: 'tool-result',
        output: '{"accepted":true}',
        callId: 'call_7e8623c60ca34bd98a8cb62c29d47eb9'
      }
    ],
    timestamp: 1792799617022,
    source: 'transcript'
  }
]
