import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

type Outcome<Result> =
  | { state: 'pending' }
  | { state: 'done'; value: Result }
  | { state: 'failed'; error: string }

let nextKey = 0

/** page.evaluate whose outcome is polled: awaiting a preload promise across CDP can be garbage-collected.
 *  `args` cross as JSON; bulk work passes a `timeout` that grows with its size. */
export async function evaluatePolled<Args, Result>(
  page: Page,
  run: (args: Args) => Promise<Result>,
  args: Args,
  options: { timeout?: number } = {}
): Promise<Result> {
  nextKey += 1
  const key = JSON.stringify(`__e2eEvaluatePolled${nextKey}`)
  await page.evaluate(`(() => {
    const run = ${run.toString()};
    globalThis[${key}] = { state: 'pending' };
    Promise.resolve()
      .then(() => run(${JSON.stringify(args)}))
      .then(
        (value) => { globalThis[${key}] = { state: 'done', value }; },
        (error) => { globalThis[${key}] = { state: 'failed', error: String(error) }; }
      );
  })()`)
  const read = () => page.evaluate<Outcome<Result>>(`globalThis[${key}]`)
  await expect
    .poll(async () => (await read()).state, {
      message: 'page work never settled',
      timeout: options.timeout
    })
    .not.toBe('pending')
  const outcome = await read()
  if (outcome.state !== 'done') {
    throw new Error(outcome.state === 'failed' ? outcome.error : 'page work never settled')
  }
  return outcome.value
}
