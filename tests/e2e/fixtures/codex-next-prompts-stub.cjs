const { appendFileSync, existsSync, watch } = require('node:fs')
const { dirname } = require('node:path')
const { createInterface } = require('node:readline')

const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.160.1\n')
  process.exit(0)
}
if (!args.includes('app-server')) {
  process.stdout.write('Logged in using ChatGPT\n')
  process.exit(0)
}
const threadId = 'next-prompts-test-thread'
let turns = 0
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const notify = (method, params) => write({ method, params })
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (!request.method || request.id === undefined) {
    return
  }
  appendFileSync(process.env.ORCA_NEXT_PROMPTS_TEST_LOG, `${JSON.stringify(request)}\n`)
  let result = {}
  switch (request.method) {
    case 'config/read':
      result = { config: {} }
      break
    case 'account/read':
      result = {
        account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'plus' },
        requiresOpenaiAuth: false
      }
      break
    case 'model/list':
      result = {
        data: [
          {
            id: 'test-model',
            model: 'test-model',
            displayName: 'Test model',
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
            isDefault: true
          }
        ],
        nextCursor: null
      }
      break
    case 'skills/list':
      result = { data: [] }
      break
    case 'thread/start':
    case 'thread/resume':
      result = { thread: { id: threadId, turns: [] }, model: 'test-model' }
      break
    case 'turn/start': {
      const turnId = `turn-${++turns}`
      result = { turn: { id: turnId, status: 'inProgress', items: [] } }
      write({ id: request.id, result })
      setTimeout(() => {
        const text = `The read-only review is complete.${turns > 1 ? '\n\n```orca-next-prompts\n["Review the changes for regressions"]\n```' : ''}`
        notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } })
        const item = { type: 'agentMessage', id: `answer-${turns}`, text }
        notify('item/started', { threadId, turnId, item: { ...item, text: '' } })
        const finish = () => {
          notify('item/completed', { threadId, turnId, item })
          notify('turn/completed', {
            threadId,
            turn: { id: turnId, status: 'completed', items: [item] }
          })
        }
        if (turns > 1) {
          // 等渲染验收明确释放后再闭合尾块，避免按固定延时碰运气。
          const release = `${process.env.ORCA_NEXT_PROMPTS_TEST_LOG}.continue`
          const gate = watch(dirname(release), () => {
            if (existsSync(release)) {
              gate.close()
              notify('item/agentMessage/delta', {
                threadId,
                turnId,
                itemId: item.id,
                delta: '\n```'
              })
              finish()
            }
          })
          notify('item/agentMessage/delta', {
            threadId,
            turnId,
            itemId: item.id,
            delta: text.slice(0, -4)
          })
        } else {
          notify('item/agentMessage/delta', { threadId, turnId, itemId: item.id, delta: text })
          finish()
        }
      }, 80)
      return
    }
  }
  write({ id: request.id, result })
})
