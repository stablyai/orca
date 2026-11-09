import { BuildLogBuffer } from './build-log-model'
import type {
  EnvironmentBuildView,
  EnvironmentStaleness,
  EnvironmentView
} from './cloud-environment-types'

/** Fixed clock so screenshots are stable. */
export const FIXTURE_NOW = Date.UTC(2026, 10, 9, 17, 30)
const MIN = 60_000

export const sampleEnvironment: EnvironmentView = {
  id: 'env_0123456789abcdef',
  name: 'Default',
  repos: [
    { url: 'https://github.com/acme/web.git', defaultBranch: null },
    { url: 'https://github.com/acme/api.git', defaultBranch: 'main' }
  ],
  installScript:
    'corepack enable\npnpm install --frozen-lockfile\nsudo apt-get install -y postgresql-client\npnpm --filter api prisma generate',
  envVarNames: ['NPM_TOKEN', 'DATABASE_URL', 'SENTRY_AUTH_TOKEN'],
  machineSize: 'standard',
  activeBuildId: 'bld_000000000006',
  revision: 4,
  createdBy: 'user_1',
  updatedBy: 'user_1',
  createdAt: FIXTURE_NOW - 3 * 24 * 60 * MIN,
  updatedAt: FIXTURE_NOW - 30 * MIN
}

export function sampleBuild(overrides: Partial<EnvironmentBuildView> = {}): EnvironmentBuildView {
  const createdAt = overrides.createdAt ?? FIXTURE_NOW - 3 * MIN
  return {
    id: 'bld_000000000007',
    number: 7,
    status: 'succeeded',
    active: false,
    createdBy: 'Neil Parker',
    createdAt,
    startedAt: createdAt + 18_000,
    snapshotStartedAt: createdAt + 142_000,
    finishedAt: createdAt + 171_000,
    durationMs: 171_000,
    activatable: true,
    error: null,
    failedStep: null,
    revision: 4,
    machineSize: 'standard',
    repos: [
      {
        url: 'https://github.com/acme/web.git',
        branch: 'main',
        commit: '9f2c1ab7e0d4'
      },
      {
        url: 'https://github.com/acme/api.git',
        branch: 'main',
        commit: '41d0e9cc2b11'
      }
    ],
    diskUsedBytes: 9_100_000_000,
    diskTotalBytes: 32_000_000_000,
    logBytes: 48_000,
    logTruncated: false,
    ...overrides
  }
}

export const sampleHistory: EnvironmentBuildView[] = [
  sampleBuild({
    id: 'bld_000000000008',
    number: 8,
    status: 'running',
    createdAt: FIXTURE_NOW - 95_000,
    startedAt: FIXTURE_NOW - 78_000,
    snapshotStartedAt: null,
    finishedAt: null,
    durationMs: null,
    activatable: false,
    repos: [
      {
        url: 'https://github.com/acme/web.git',
        branch: 'main',
        commit: 'c03b7d1e9a55'
      },
      {
        url: 'https://github.com/acme/api.git',
        branch: 'main',
        commit: '41d0e9cc2b11'
      }
    ]
  }),
  sampleBuild({
    id: 'bld_000000000007',
    number: 7,
    status: 'failed',
    createdBy: 'Priya Shah',
    createdAt: FIXTURE_NOW - 2 * 60 * MIN,
    snapshotStartedAt: null,
    finishedAt: FIXTURE_NOW - 2 * 60 * MIN + 64_000,
    durationMs: 64_000,
    activatable: false,
    error: 'install_failed',
    failedStep: 'install'
  }),
  sampleBuild({
    id: 'bld_000000000006',
    number: 6,
    active: true,
    createdAt: FIXTURE_NOW - 26 * 60 * MIN
  }),
  sampleBuild({
    id: 'bld_000000000005',
    number: 5,
    status: 'canceled',
    createdAt: FIXTURE_NOW - 2 * 24 * 60 * MIN,
    snapshotStartedAt: null,
    finishedAt: FIXTURE_NOW - 2 * 24 * 60 * MIN + 40_000,
    durationMs: 40_000,
    activatable: false,
    error: 'canceled'
  }),
  sampleBuild({
    id: 'bld_000000000001',
    number: 1,
    activatable: false,
    createdAt: FIXTURE_NOW - 9 * 24 * 60 * MIN
  })
]

function syncBuffer(): BuildLogBuffer {
  return new BuildLogBuffer((flush) => flush())
}

type Chunk = [offsetMs: number, data: string, stream?: 'stdout' | 'stderr']

function fill(buffer: BuildLogBuffer, origin: number, chunks: Chunk[]): BuildLogBuffer {
  for (const [offset, data, stream] of chunks) {
    buffer.append(stream ?? 'stdout', data, origin + offset)
  }
  return buffer
}

const CLONE: Chunk[] = [
  [18_200, 'Base image: Ubuntu 26.04.1 LTS, 4 vCPU, package manager: apt-get (with sudo)\n'],
  [18_500, '::orca-step:: clone\n'],
  [18_600, "Cloning into '/home/orca/acme/web'...\n", 'stderr'],
  [21_900, "Cloning into '/home/orca/acme/api'...\n", 'stderr'],
  [24_100, 'acme/web @ 9f2c1ab (main)\nacme/api @ 41d0e9c (main)\n']
]

const INSTALL_START: Chunk[] = [
  [24_300, '::orca-step:: install\n'],
  [24_400, '+ corepack enable\n', 'stderr'],
  [25_000, '+ pnpm install --frozen-lockfile\n', 'stderr'],
  [27_200, 'Lockfile is up to date, resolution step is skipped\n'],
  [
    28_000,
    'Progress: resolved 1, reused 0, downloaded 0, added 0\rProgress: resolved 1412, reused 0, downloaded 1412, added 1412, done\n'
  ],
  [33_100, '\u001b[33m WARN \u001b[39m deprecated inflight@1.0.6: This module is not supported\n'],
  [
    61_000,
    '\u001b[36mdependencies:\u001b[39m\n\u001b[32m+\u001b[39m next 15.0.3\n\u001b[32m+\u001b[39m react 19.0.0\n\u001b[32m+\u001b[39m prisma 5.22.0\n'
  ],
  [61_500, 'Done in 36.5s\n']
]

export function succeededLog(build: EnvironmentBuildView): BuildLogBuffer {
  return fill(syncBuffer(), build.createdAt, [
    ...CLONE,
    ...INSTALL_START,
    [62_000, '+ sudo apt-get install -y postgresql-client\n', 'stderr'],
    [
      80_000,
      'Setting up postgresql-client-17 (17.2-1) ...\nProcessing triggers for libc-bin ...\n'
    ],
    [81_000, '+ pnpm --filter api prisma generate\n', 'stderr'],
    [92_000, '✔ Generated Prisma Client (v5.22.0) to ./node_modules/@prisma/client in 412ms\n'],
    [140_000, '::orca-step:: record\n'],
    [140_100, 'Recorded 3 runtimes, 1412 packages, 9.1 GB used of 32 GB\n']
  ])
}

export function failedLog(build: EnvironmentBuildView): BuildLogBuffer {
  return fill(syncBuffer(), build.createdAt, [
    ...CLONE,
    ...INSTALL_START,
    [62_000, '+ sudo apt-get install -y postgresql-client\n', 'stderr'],
    [63_000, 'E: Unable to locate package postgresql-client\n', 'stderr'],
    [63_100, '::orca-error:: The install script exited with status 100.\n']
  ])
}

export function buildingLog(build: EnvironmentBuildView): BuildLogBuffer {
  const buffer = fill(syncBuffer(), build.createdAt, [...CLONE, ...INSTALL_START.slice(0, 6)])
  buffer.append(
    'stdout',
    'Downloading @next/swc-linux-x64-gnu@15.0.3: 41.2 MB/41.2 MB',
    build.createdAt + 70_000
  )
  return buffer
}

export function longLog(build: EnvironmentBuildView): BuildLogBuffer {
  const buffer = fill(syncBuffer(), build.createdAt, [
    ...CLONE,
    [24_300, '::orca-step:: install\n']
  ])
  const packages = ['react', 'next', 'typescript', 'eslint', 'vite', 'zod', 'prisma', 'tailwindcss']
  let chunk = ''
  for (let i = 0; i < 20_000; i += 1) {
    chunk += `  \u001b[90m${String(i).padStart(5, '0')}\u001b[39m fetch https://registry.npmjs.org/${packages[i % packages.length]}-${i} 200 ${(i * 7) % 900}ms\n`
    if (i % 1000 === 999) {
      buffer.append('stdout', chunk, build.createdAt + 25_000 + i * 10)
      chunk = ''
    }
  }
  buffer.append(
    'stderr',
    'npm ERR! code ETIMEDOUT while fetching tarball (retrying 1/3)\n',
    build.createdAt + 230_000
  )
  buffer.append('stdout', 'retry succeeded\nDone in 212.0s\n', build.createdAt + 236_000)
  return buffer
}

export const sampleStaleness = {
  deps: {
    checkedAt: FIXTURE_NOW,
    activeBuildId: 'bld_000000000006',
    configChanged: false,
    recommendation: 'deps_changed',
    repos: [
      {
        url: 'https://github.com/acme/web.git',
        branch: 'main',
        builtCommit: '9f2c1ab7e0d4',
        headCommit: 'c03b7d1e9a55',
        aheadBy: 4,
        lockfilesChanged: ['pnpm-lock.yaml'],
        error: null
      }
    ]
  },
  config: {
    checkedAt: FIXTURE_NOW,
    activeBuildId: 'bld_000000000006',
    configChanged: true,
    recommendation: 'config_changed',
    repos: []
  },
  branch: {
    checkedAt: FIXTURE_NOW,
    activeBuildId: 'bld_000000000006',
    configChanged: false,
    recommendation: 'branch_moved',
    repos: [
      {
        url: 'https://github.com/acme/web.git',
        branch: 'main',
        builtCommit: '9f2c1ab7e0d4',
        headCommit: 'c03b7d1e9a55',
        aheadBy: 12,
        lockfilesChanged: [],
        error: null
      }
    ]
  }
} satisfies Record<string, EnvironmentStaleness>
