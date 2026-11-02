import { runProcess } from '@orca/process-host'

type GitResult = { stdout: string; stderr: string }

export class GitBinaryTestFixture {
  private container = ''
  private readonly image = process.env.ORCA_GIT_COMPAT_IMAGE
  private readonly binary = process.env.ORCA_GIT_COMPAT_BINARY ?? 'git'
  readonly executionRoot: string

  constructor(
    private readonly root: string,
    containerRoot = root
  ) {
    this.executionRoot = this.image ? containerRoot : root
  }

  async start(): Promise<void> {
    if (!this.image) {
      return
    }
    const dockerUser =
      typeof process.getuid === 'function' && typeof process.getgid === 'function'
        ? ['--user', `${process.getuid()}:${process.getgid()}`]
        : []
    // Container creation dwarfs Git execution; keep the same isolated image alive for the suite.
    const result = await this.run('docker', [
      'run',
      '--detach',
      '--rm',
      '--network=none',
      ...dockerUser,
      '-v',
      `${this.root}:${this.executionRoot}`,
      '--entrypoint',
      '/bin/sleep',
      this.image,
      'infinity'
    ])
    this.container = result.stdout.trim()
  }

  exec(
    args: string[],
    cwd = this.executionRoot,
    env: NodeJS.ProcessEnv = {},
    stdin?: string
  ): Promise<GitResult> {
    const isolatedEnv = {
      HOME: this.executionRoot,
      XDG_CONFIG_HOME: this.executionRoot,
      GIT_CONFIG_NOSYSTEM: '1',
      ...env
    }
    if (!this.image) {
      return this.run(this.binary, args, cwd, { ...process.env, ...isolatedEnv }, stdin)
    }
    if (!this.container) {
      throw new Error('Git compatibility container has not started')
    }
    return this.run(
      'docker',
      [
        'exec',
        ...(stdin === undefined ? [] : ['-i']),
        ...Object.entries(isolatedEnv).flatMap(([key, value]) =>
          value === undefined ? [] : ['--env', `${key}=${value}`]
        ),
        '-w',
        cwd,
        this.container,
        'git',
        '-c',
        `safe.directory=${cwd}`,
        ...args
      ],
      undefined,
      undefined,
      stdin
    )
  }

  async stop(): Promise<void> {
    if (this.container) {
      await this.run('docker', ['rm', '--force', this.container])
      this.container = ''
    }
  }

  private async run(
    program: string,
    args: string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv,
    stdin?: string
  ): Promise<GitResult> {
    const result = await runProcess({
      program,
      args,
      cwd,
      env,
      input: stdin,
      maxOutputBytes: 2 * 1024 * 1024
    })
    if (result.code !== 0) {
      throw Object.assign(new Error(`${program} ${args.join(' ')}: ${result.stderr}`), {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      })
    }
    return result
  }
}
