import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type * as Direct from '../../mobile/src/transport/direct-rpc-client'
import type * as Tunnel from '../../mobile/src/transport/mobile-browser-tunnel-connection'
import type * as Relay from '../../mobile/src/transport/mobile-relay-rpc-session'

const require = createRequire(import.meta.url)

// Compile the real portable clients without Expo's app tsconfig, as the mobile benchmarks do.
const bundle = await build({
  stdin: {
    contents: `
      export { DirectRpcClient } from './mobile/src/transport/direct-rpc-client'
      export { MobileBrowserTunnelConnection } from './mobile/src/transport/mobile-browser-tunnel-connection'
      export { connectMobileRelayRpcSession } from './mobile/src/transport/mobile-relay-rpc-session'
    `,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  tsconfigRaw: {},
  // Resolve declared root dependencies even when a mobile installation is present.
  alias: {
    tweetnacl: require.resolve('tweetnacl'),
    '@noble/hashes': resolve(require.resolve('@noble/hashes/sha256'), '..'),
    zod: require.resolve('zod')
  },
  plugins: [
    {
      name: 'node-secure-random',
      setup(bundler) {
        bundler.onResolve({ filter: /^expo-crypto$/ }, () => ({
          path: 'expo-crypto',
          namespace: 'node-secure-random'
        }))
        bundler.onLoad({ filter: /.*/, namespace: 'node-secure-random' }, () => ({
          contents: "export { randomBytes as getRandomBytes } from 'node:crypto'",
          loader: 'js'
        }))
      }
    }
  ]
})

// Only the native random-number provider is replaced; encryption and transport remain real.
const compiled = { exports: {} }
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(
  compiled,
  compiled.exports,
  createRequire(resolve('package.json'))
)
export const { DirectRpcClient, MobileBrowserTunnelConnection, connectMobileRelayRpcSession } =
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bundle exports exactly these three source modules above.
  compiled.exports as typeof Direct & typeof Tunnel & typeof Relay
