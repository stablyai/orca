import { fileURLToPath } from 'node:url'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'

// The native V8 boundary is exercised with reused whitespace chunks, not a 512 MB allocation.
it('delivers a legacy response beyond the V8 string limit and the following paginated reply', async () => {
  const result = await runProcess({
    program: 'node',
    args: [
      '--import',
      'tsx',
      fileURLToPath(new URL('./testing/ndjson-v8-limit-child.fixture.ts', import.meta.url))
    ],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 15_000,
    maxOutputBytes: 4096
  })
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    records: [
      {
        id: 7,
        result: {
          thread: {
            id: 'legacy',
            ['__proto__']: { safe: true },
            turns: [
              {
                id: 'turn-1',
                items: [{ type: 'imageGeneration', id: 'image-1', result: 'YQ==' }]
              }
            ]
          }
        }
      },
      { id: 8, result: { data: [], nextCursor: null } },
      { id: 9, result: 'still connected' }
    ],
    rejected: ['invalid-json']
  })
}, 20_000)
