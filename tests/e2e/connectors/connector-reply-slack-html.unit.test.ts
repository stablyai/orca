import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { dispatch, type HandlerContext } from '../../../src/cli/dispatch/dispatch'
import { RuntimeClientError } from '../../../src/cli/runtime/connection/types'
import type { ConnectorActionArgs } from '../../../src/shared/connector-action-contract'
import {
  CONNECTOR_REPLY_HTML_PAGE_AS_FILE,
  ConnectorAct,
  ConnectorReply
} from '../../../src/shared/rpc-contract/connectors/connector-params'
import type { ConnectorReplyBody } from '../../../src/main/connector-cloud/connector-replies'
import { slackReplyBody } from '../../../src/main/connector-cloud/connector-slack-text'
import type { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { CONNECTOR_METHODS } from '../../../src/main/runtime/rpc/methods/connectors/connector'

const SESSION = '55555555-5555-4555-8555-555555555555'
const PRIVATE_PATH = ['', 'Users', 'example', 'project', 'file.ts'].join('/')
const FENCE = '```'
const html = (title: string, body: string, eol = '\n') =>
  ['<!doctype html>', `<html><head><title>${title}</title></head><body>${body}</body></html>`].join(
    eol
  )
const fence = (page: string, eol = '\n') => [`${FENCE}html`, page, FENCE].join(eol)
const scriptPage = (key: string, argument: string) =>
  html(
    'Build report',
    [
      `<button onclick="show('${argument}')">Show details</button>`,
      '<output id="details"></output>',
      '<script>',
      `const logs = { '${key}': 'Synthetic details' }`,
      'function show(path) {',
      "  document.getElementById('details').textContent = logs[path] ?? 'No matching report'",
      '}',
      '</script>'
    ].join('\n')
  )

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function slackThread({
  failure,
  legacyHost = false
}: { failure?: 'stage' | 'post'; legacyHost?: boolean } = {}) {
  const bot = { id: 'report-bot', folderWorkspaceId: 'reports' }
  const worktreeId = `folder:${bot.folderWorkspaceId}`
  const host = {
    deps: { store: { getConversation: () => ({ location: { workspaceId: worktreeId } }) } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bot membership only reads this store method.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
  const inline: ConnectorReplyBody[] = []
  const formatted: ConnectorReplyBody[] = []
  const replyOptIns: (true | undefined)[] = []
  const uploads: NonNullable<ConnectorActionArgs['upload']>[] = []
  const bytes: Buffer[] = []
  const posts: ConnectorActionArgs[] = []
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: { enabled: () => true, list: () => [bot] },
    getExternalConversationSeam: () => ({
      replyTarget: () => ({
        key: { source: 'slack', externalId: 'T1:C1:1712.1:UBOT' },
        bot: { kind: 'bot', botId: bot.id },
        worktreeId,
        turnId: 2
      })
    }),
    getConnectorCloud: () => ({
      cloudFeatures: () => new Set(['actions', 'files.direct', 'reply.files']),
      reply: async (body: ConnectorReplyBody) => {
        inline.push(body)
        formatted.push(slackReplyBody(body))
        return { ok: true, value: { status: 'posted' } }
      }
    })
  }
  const rpc = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply dispatcher reads only these runtime seams.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: CONNECTOR_METHODS
  })
  const call = async (method: string, params: unknown) => {
    if (method === 'connector.act') {
      const { args } = ConnectorAct.parse(params)
      if (args.upload) {
        uploads.push(args.upload)
        if (failure === 'stage') {
          throw new RuntimeClientError('connector_unavailable', 'Staging unavailable')
        }
        return {
          result: { ok: true, result: { upload: { url: 'https://example.invalid/upload' } } }
        }
      }
      posts.push(args)
      if (failure === 'post' && posts.length > 1) {
        return { result: { ok: false, refusal: 'post_uncertain', message: 'Post unconfirmed' } }
      }
      return { result: { ok: true, result: { queued: failure === 'post' } } }
    }
    const { pagesAsFiles } = ConnectorReply.parse(params)
    replyOptIns.push(pagesAsFiles)
    if (legacyHost && pagesAsFiles) {
      throw new RuntimeClientError(CONNECTOR_REPLY_HTML_PAGE_AS_FILE, 'Attach the HTML page')
    }
    const response = await rpc.dispatch({ id: 'req', authToken: 'test-token', method, params })
    if (!response.ok) {
      throw new RuntimeClientError(response.error.code, response.error.message)
    }
    return response
  }
  vi.stubGlobal('fetch', async (_url: string, { body }: { body: Blob }) => {
    bytes.push(Buffer.from(await body.arrayBuffer()))
    return new Response()
  })
  vi.stubEnv('ORCA_AGENT_SESSION_ID', SESSION)
  vi.stubEnv('ORCA_PANE_KEY', undefined)
  vi.stubEnv('ORCA_AGENT_PANE', undefined)
  vi.stubEnv('ORCA_CLI_CWD', undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const send = (text: string, flags: [string, string][] = []) =>
    dispatch(['bot', 'reply'], {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this command only uses call.
      client: { call } as unknown as HandlerContext['client'],
      cwd: process.cwd(),
      json: false,
      flags: new Map([['text', text], ...flags])
    })
  return { call, send, replyOptIns, inline, formatted, uploads, bytes, posts }
}

it.each([
  { host: 'current host', legacyHost: false, optIns: [true] },
  { host: 'older host', legacyHost: true, optIns: [true, undefined] }
])(
  'sends the original reply and notes inline when one page would change ($host)',
  async ({ legacyHost, optIns }) => {
    const { send, replyOptIns, uploads, inline, formatted } = slackThread({ legacyHost })
    const clean = fence(html('Overview', '<p>Nothing to shorten.</p>'))
    const report = (path: string) => fence(html(path, `<p>Open ${path}.</p>`))
    const reply = (path: string) => ['Start.', clean, 'Next.', report(path), 'Done.'].join('\n\n')

    await send(reply(PRIVATE_PATH), [['note', `${PRIVATE_PATH}:7:Open ${PRIVATE_PATH}`]])

    expect(uploads).toEqual([])
    expect(replyOptIns).toEqual(optIns)
    expect(inline).toMatchObject([
      {
        text: reply(PRIVATE_PATH),
        review: { comments: [{ path: PRIVATE_PATH, line: 7, body: `Open ${PRIVATE_PATH}` }] }
      }
    ])
    expect(formatted).toMatchObject([
      {
        text: reply('file.ts'),
        review: { comments: [{ path: 'file.ts', line: 7, body: 'Open file.ts' }] }
      }
    ])
  }
)

it('routes an opt-in with a script and its matching handler inline immediately', async () => {
  const { call, inline, formatted } = slackThread()
  const text = fence(scriptPage(PRIVATE_PATH, PRIVATE_PATH))

  await call('connector.reply', { sessionId: SESSION, replyId: 'direct', text, pagesAsFiles: true })

  expect(inline).toMatchObject([{ replyId: 'direct', text }])
  expect(formatted).toMatchObject([{ text: fence(scriptPage('file.ts', PRIVATE_PATH)) }])
})

it('uploads eligible pages with their original bytes and distinct title-based names', async () => {
  const { send, uploads, bytes, posts, inline } = slackThread()
  const first = html(
    'Build notes',
    `<p>Café ☕</p>\r\n<a href="${PRIVATE_PATH}">Source</a><p>&#47;Users&#47;example&#47;file.ts</p>`,
    '\r\n'
  )
  const second = html('Build notes', '<p>東京</p>')
  const firstBytes = Buffer.from(`${first}\r`)
  const secondBytes = Buffer.from(second)

  await send([fence(first, '\r\n'), 'Read both reports.', fence(second)].join('\r\n'))

  expect(uploads).toEqual([
    { name: 'build-notes.html', size: firstBytes.length },
    { name: 'build-notes-2.html', size: secondBytes.length }
  ])
  expect(bytes).toEqual([firstBytes, secondBytes])
  expect(posts).toMatchObject([
    { files: [expect.any(String), expect.any(String)], text: 'Read both reports.\r' }
  ])
  expect(inline).toEqual([])
})

it('uses the original inline reply after a staging failure', async () => {
  const { send, uploads, posts, inline } = slackThread({ failure: 'stage' })
  const text = fence(html('Build notes', '<p>All checks passed.</p>'))

  await send(text)

  expect(uploads).toHaveLength(1)
  expect(posts).toEqual([])
  expect(inline).toMatchObject([{ text }])
})

it('checks an uncertain attachment post using the same id without sending inline', async () => {
  const { send, uploads, posts, inline } = slackThread({ failure: 'post' })
  const text = fence(html('Build notes', '<p>All checks passed.</p>'))

  await expect(send(text)).rejects.toMatchObject({ code: 'post_uncertain' })

  expect(uploads).toHaveLength(1)
  expect(posts).toHaveLength(2)
  expect(posts[0]?.postId).toEqual(expect.any(String))
  expect(posts[1]).toEqual(posts[0])
  expect(inline).toEqual([])
})

it('preserves the bytes of an explicitly selected file', async () => {
  const { send, uploads, bytes, inline } = slackThread()
  const dir = await mkdtemp(join(tmpdir(), 'reply-file-test-'))
  const file = join(dir, 'report.html')
  const document = Buffer.from(scriptPage(PRIVATE_PATH, PRIVATE_PATH))
  try {
    await writeFile(file, document)
    await send('Attached report.', [['file', file]])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  expect(uploads).toEqual([{ name: 'report.html', size: document.length }])
  expect(bytes).toEqual([document])
  expect(inline).toEqual([])
})
