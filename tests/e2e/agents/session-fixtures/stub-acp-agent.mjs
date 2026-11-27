// A minimal ACP agent on stdio for e2e: it answers every prompt with what it heard.
import { createInterface } from 'node:readline'

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined || method === undefined) {
    return
  }
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  } else if (method === 'session/new') {
    send({ id, result: { sessionId: 'stub-session', configOptions: [] } })
  } else if (method === 'session/set_config_option') {
    send({ id, result: { configOptions: [] } })
  } else if (method === 'session/prompt') {
    const text = params.prompt.map((block) => block.text ?? '').join('')
    send({
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `stub agent heard: ${text}` }
        }
      }
    })
    send({ id, result: { stopReason: 'end_turn' } })
  } else {
    send({ id, error: { code: -32601, message: `method not found: ${method}` } })
  }
})
