import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { slackThreadRefOfLink, slackThreadUrl } from './slack-mirror-state'

// #47789: a bot handed a Slack thread's link couldn't post there, since `slack post` reads that link
// form as nothing. The cloud's slack-thread-link-refs.test.ts reads the same corpus, so the ref built
// here is one it reads as that very thread.
const Thread = z.object({
  link: z.string(),
  ref: z.string(),
  workspaceId: z.string(),
  containerId: z.string(),
  threadId: z.string()
})
const corpus = z
  .object({ threads: z.array(Thread).min(1) })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../../../cloud/packages/connector-contract/src/test-fixtures/slack-thread-link-refs.json',
          import.meta.url
        ),
        'utf8'
      )
    )
  )

it('reads each Slack thread link Orca writes as the ref of that thread', () => {
  for (const thread of corpus.threads) {
    expect(slackThreadUrl(`${thread.workspaceId}:${thread.containerId}:${thread.threadId}`)).toBe(
      thread.link
    )
    expect(slackThreadRefOfLink(thread.link)).toBe(thread.ref)
  }
  // Links `slack post` already reads, and a thread link naming another channel, get no ref.
  expect(
    [
      'https://app.slack.com/client/T0123ABCD/D0456EFGH',
      'https://acme.slack.com/archives/C0456EFGH/p1795415167287389',
      'https://app.slack.com/client/T0123ABCD/C0456EFGH/thread/C0999-1795415167.287389'
    ].map(slackThreadRefOfLink)
  ).toEqual([null, null, null])
})
