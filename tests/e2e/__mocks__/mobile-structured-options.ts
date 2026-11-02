import { build } from 'esbuild'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import type { useMobileStructuredAgentOptions } from '../../../mobile/src/session/use-mobile-structured-agent-options'

/** Execute the real phone hook in root-only workers, which do not install Expo. */
export async function loadMobileStructuredOptions(): Promise<
  typeof useMobileStructuredAgentOptions
> {
  const result = await build({
    entryPoints: [resolve('mobile/src/session/use-mobile-structured-agent-options.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    tsconfigRaw: {},
    plugins: [
      {
        name: 'root-unit-phone-platform',
        setup(builder) {
          builder.onResolve({ filter: /^react$/ }, () => ({
            path: resolve('node_modules/react/index.js'),
            external: true
          }))
          builder.onResolve({ filter: /\/random-v4-uuid$/ }, () => ({
            path: 'uuid',
            namespace: 'unit-phone'
          }))
          builder.onLoad({ filter: /^uuid$/, namespace: 'unit-phone' }, () => ({
            resolveDir: process.cwd(),
            contents: `export { createBrowserUuid as randomV4Uuid } from ${JSON.stringify(resolve('src/renderer/src/lib/browser-uuid.ts'))}`
          }))
        }
      }
    ]
  })
  const source = result.outputFiles[0]?.text
  if (!source) {
    throw new Error('Phone hook source was not compiled')
  }
  const dir = await mkdtemp(join(tmpdir(), 'orca-pr32334-phone-options-'))
  const file = join(dir, 'phone-options.cjs')
  try {
    await writeFile(file, source)
    const loaded: { useMobileStructuredAgentOptions: typeof useMobileStructuredAgentOptions } =
      createRequire(resolve('package.json'))(file)
    if (typeof loaded.useMobileStructuredAgentOptions !== 'function') {
      throw new Error('Phone hook export is unavailable')
    }
    return loaded.useMobileStructuredAgentOptions
  } finally {
    await unlink(file)
    await rmdir(dir)
  }
}
