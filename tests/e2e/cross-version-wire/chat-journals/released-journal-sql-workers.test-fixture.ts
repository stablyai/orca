import { build } from 'esbuild'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, vi } from 'vitest'

// Releases whose chat journal runs SQL in worker threads; their test opener spawns these bundles.
const JOURNAL = 'src/main/native-chat/agent-session-journal'
const SQL_WORKER_FIXTURE = `${JOURNAL}/journal-sql-worker-bundle.test-fixture.ts`
const WORKER_ENTRY = 'journal-sql-worker-entry'
const READER_ENTRY = 'journal-sql-reader-entry'

const bundles = new Map<string, Promise<string>>()
const bundleRoots: string[] = []
afterAll(() => {
  for (const root of bundleRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** The release's own SQL workers, bundled once per checkout. */
function bundleReleasedSqlWorkers(checkoutRoot: string): Promise<string> {
  let bundled = bundles.get(checkoutRoot)
  if (!bundled) {
    const outdir = mkdtempSync(join(tmpdir(), 'orca-released-journal-sql-worker-'))
    bundleRoots.push(outdir)
    bundled = build({
      entryPoints: [WORKER_ENTRY, READER_ENTRY].map((entry) =>
        join(checkoutRoot, JOURNAL, `${entry}.ts`)
      ),
      outdir,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    }).then(() => outdir)
    bundles.set(checkoutRoot, bundled)
  }
  return bundled
}

/**
 * Point a SQL-backed release's worker-bundle fixture at that release's own bundles; returns whether
 * the release keeps its chats in SQL. Call before importing any of the release's journal modules.
 */
export async function provideReleasedSqlWorkers(checkoutRoot: string): Promise<boolean> {
  const fixture = join(checkoutRoot, SQL_WORKER_FIXTURE)
  if (!existsSync(fixture)) {
    return false
  }
  // Why: the fixture bundles in a module-scope beforeAll, which a mid-test import never runs, so
  // its paths would be bare file names that `new Worker` refuses.
  const workers = await bundleReleasedSqlWorkers(checkoutRoot)
  vi.doMock(fixture, () => ({
    journalSqlWorkerPath: () => join(workers, `${WORKER_ENTRY}.js`),
    journalSqlReaderPath: () => join(workers, `${READER_ENTRY}.js`)
  }))
  return true
}
