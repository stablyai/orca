import { expect, it } from 'vitest'
import { redactSecretLike } from './crash-report-redaction'

it('redacts env-style secret assignments whose key word has a prefix', () => {
  expect(
    redactSecretLike(
      'NOTION_TOKEN=ntn_abc123 MY_API_KEY=k1 DB_PASSWORD=p AWS_SECRET_ACCESS_KEY=s private_key: pk access-key=ak'
    )
  ).toBe(
    'NOTION_TOKEN=[redacted] MY_API_KEY=[redacted] DB_PASSWORD=[redacted] AWS_SECRET_ACCESS_KEY=[redacted] private_key=[redacted] access-key=[redacted]'
  )
})

it('leaves prose and non-secret assignments alone', () => {
  const text =
    'max_tokens=4096 used; MY_TOKEN_COUNT is 3; sort_key=name; mytoken=abc; the secret is out'
  expect(redactSecretLike(text)).toBe(text)
})
