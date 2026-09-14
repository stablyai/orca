const { randomBytes } = require('node:crypto')
const { writeSync } = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const EVIDENCE_PREFIX = 'ORCA_NODE_PTY_CAPABILITY_EVIDENCE='
const EXPECTED_ROLES = new Set([
  'target-shell',
  'target-launcher-exited',
  'target-grandchild',
  'canary-shell'
])
const ONE_SHOT_MODES = new Set(['--exercise', '--exit-contract-fixture'])

function isOneShotMode(mode) {
  return ONE_SHOT_MODES.has(mode)
}

function stage(name) {
  writeSync(2, `[windows-pty-native-capability-smoke] stage=${name}\n`)
}

function writeStream(stream, value = '') {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => (error ? reject(error) : resolve()))
  })
}

async function exitOneShot(code, exit = process.exit) {
  await Promise.all([writeStream(process.stdout), writeStream(process.stderr)])
  exit(code)
}

function fixtureObservation(fixtureToken, role, channel, extra = {}) {
  return { pid: process.pid, fixtureToken, role, channel, ...extra }
}

function connectFixture(channel, fixtureToken, role, extra = {}) {
  const socket = net.createConnection(channel)
  socket.once('connect', () => {
    socket.write(`${JSON.stringify(fixtureObservation(fixtureToken, role, channel, extra))}\n`)
  })
  socket.on('error', (error) => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
  return socket
}

function reportFixtureObservation(channel, fixtureToken, role, extra = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(channel)
    socket.once('connect', () => {
      socket.end(`${JSON.stringify(fixtureObservation(fixtureToken, role, channel, extra))}\n`)
    })
    socket.once('error', reject)
    socket.once('close', resolve)
  })
}

function buildGrandchildLaunch(channel, fixtureToken) {
  return {
    program: path.join(process.env.SystemRoot, 'System32', 'wscript.exe'),
    args: [
      path.join(__dirname, 'real-orca-detached-launcher.vbs'),
      process.execPath,
      __filename,
      '--grandchild-member',
      channel,
      fixtureToken,
      'target-grandchild'
    ]
  }
}

function startGrandchildAfterLauncherExit(channel, fixtureToken, resourcesDir) {
  const { spawnProcess } = require(
    path.join(resourcesDir, 'app.asar.unpacked', 'out', 'shared', 'child-process', 'run-process.js')
  )
  const launch = buildGrandchildLaunch(channel, fixtureToken)
  const child = spawnProcess({
    ...launch,
    env: process.env
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', () => {})
  }
  child.stdin?.end()
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`grandchild launcher exited ${code}`))
        return
      }
      reportFixtureObservation(channel, fixtureToken, 'target-launcher-exited', {
        pid: child.pid
      }).then(() => resolve(child.pid), reject)
    })
  })
}

async function runPtyShell(channel, fixtureToken, role, resourcesDir) {
  const socket = connectFixture(channel, fixtureToken, `${role}-shell`)
  try {
    if (role === 'target') {
      await startGrandchildAfterLauncherExit(channel, fixtureToken, resourcesDir)
    }
  } catch (error) {
    socket.destroy()
    throw error
  }
}

function createFixtureServer(channel, fixtureToken) {
  const pending = new Map()
  const observations = new Map()
  const sockets = new Map()
  const closures = new Map()
  const acceptedSockets = new Set()
  let serverClosed = false

  function closureFor(role) {
    const existing = closures.get(role)
    if (existing) {
      return existing
    }
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    const closure = { promise, resolve }
    closures.set(role, closure)
    return closure
  }

  function waitForRole(role) {
    const existing = observations.get(role)
    if (existing) {
      return Promise.resolve(existing)
    }
    return new Promise((resolve) => pending.set(role, resolve))
  }

  const server = net.createServer((socket) => {
    let input = ''
    acceptedSockets.add(socket)
    socket.once('close', () => acceptedSockets.delete(socket))
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      input += String(chunk)
      const newline = input.indexOf('\n')
      if (newline === -1) {
        return
      }
      const observation = JSON.parse(input.slice(0, newline))
      if (
        observation.fixtureToken !== fixtureToken ||
        observation.channel !== channel ||
        !EXPECTED_ROLES.has(observation.role)
      ) {
        throw new Error('fixture observation did not match its unique token, channel, and role')
      }
      observations.set(observation.role, observation)
      sockets.set(observation.role, socket)
      pending.get(observation.role)?.(observation)
      pending.delete(observation.role)
      socket.once('close', () => {
        closureFor(observation.role).resolve({
          fixtureToken,
          channel,
          role: observation.role
        })
      })
    })
  })

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(channel, resolve)
  })
  const close = () => {
    if (serverClosed) {
      return Promise.resolve()
    }
    serverClosed = true
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  return {
    listening,
    waitForRole,
    waitForClose: (role) => closureFor(role).promise,
    sockets,
    destroySockets: () => {
      for (const socket of acceptedSockets) {
        socket.destroy()
      }
      server.closeAllConnections?.()
      server.unref()
    },
    close
  }
}

function terminalHandle(pty) {
  return `pty-job:${pty._pty}:${pty.pid}`
}

function exitEvent(pty) {
  const handle = terminalHandle(pty)
  return new Promise((resolve) =>
    pty.onExit((event) => resolve({ terminalHandle: handle, ...event }))
  )
}

function waitForBarrier(promise, label, timeoutMs = 30_000) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

async function exercise(resourcesDir, fixtureExecutable) {
  const nodePtyDir = path.join(resourcesDir, 'node_modules', 'node-pty')
  stage('addon-load:start')
  const nodePty = require(nodePtyDir)
  const { module: native } = require(path.join(nodePtyDir, 'lib', 'utils.js')).loadNativeModule(
    'conpty'
  )
  stage('addon-load:done')
  const patchedExports = ['assignCurrentProcessToJob', 'listJobProcessIds', 'terminateJob']
  for (const name of patchedExports) {
    if (typeof native[name] !== 'function') {
      throw new Error(`packaged node-pty is missing ${name}`)
    }
  }
  stage('host-job-assign:start')
  const hostJobAssigned = native.assignCurrentProcessToJob()
  stage('host-job-assign:done')
  if (!hostJobAssigned) {
    throw new Error('packaged probe could not establish host job ownership')
  }

  const fixtureToken = randomBytes(32).toString('hex')
  const channel = `\\\\.\\pipe\\orca-pty-native-capability-${fixtureToken}`
  const fixtures = createFixtureServer(channel, fixtureToken)
  stage('fixture-listen:start')
  await waitForBarrier(fixtures.listening, 'fixture server listen')
  stage('fixture-listen:done')
  const options = {
    name: 'xterm-256color',
    cols: 80,
    rows: 30,
    cwd: process.cwd(),
    env: process.env,
    useConptyDll: true
  }
  const created = []
  const closed = new Set()
  const exitPromises = []
  let completed = false

  try {
    stage('target-spawn:start')
    const target = nodePty.spawn(
      fixtureExecutable,
      [__filename, '--pty-shell', channel, fixtureToken, 'target', resourcesDir],
      options
    )
    stage('target-spawn:done')
    created.push(target)
    const targetExited = exitEvent(target)
    exitPromises.push(targetExited)
    stage('canary-spawn:start')
    const canary = nodePty.spawn(
      fixtureExecutable,
      [__filename, '--pty-shell', channel, fixtureToken, 'canary', resourcesDir],
      options
    )
    stage('canary-spawn:done')
    created.push(canary)
    const canaryHandle = terminalHandle(canary)
    const canaryExited = exitEvent(canary)
    exitPromises.push(canaryExited)

    stage('fixture-readiness:start')
    const [shell, launcherExited, grandchild, canaryProcess] = await Promise.all([
      waitForBarrier(fixtures.waitForRole('target-shell'), 'target shell readiness'),
      waitForBarrier(fixtures.waitForRole('target-launcher-exited'), 'grandchild launcher exit'),
      waitForBarrier(fixtures.waitForRole('target-grandchild'), 'target grandchild readiness'),
      waitForBarrier(fixtures.waitForRole('canary-shell'), 'canary shell readiness')
    ])
    stage('fixture-readiness:done')
    stage('target-job-list:start')
    const targetJobProcessIds = native.listJobProcessIds(target._pty, target.pid)
    stage('target-job-list:done')
    const targetHandle = terminalHandle(target)
    stage('target-job-terminate:start')
    const targetTerminated = native.terminateJob(target._pty, target.pid)
    stage('target-job-terminate:done')
    if (!targetTerminated) {
      throw new Error('exact target job termination was refused')
    }
    closed.add(target)
    stage('target-exit-barriers:start')
    const [targetExit, targetShellClosed, targetGrandchildClosed] = await Promise.all([
      waitForBarrier(targetExited, 'target PTY exit'),
      waitForBarrier(fixtures.waitForClose('target-shell'), 'target shell connection close'),
      waitForBarrier(
        fixtures.waitForClose('target-grandchild'),
        'target grandchild connection close'
      )
    ])
    stage('target-exit-barriers:done')

    stage('canary-job-list:start')
    const canaryJobProcessIdsAfterTargetClose = native.listJobProcessIds(canary._pty, canary.pid)
    stage('canary-job-list:done')
    const canarySocket = fixtures.sockets.get('canary-shell')
    const connectedAfterTargetClose = Boolean(canarySocket && !canarySocket.destroyed)
    stage('canary-job-terminate:start')
    const canaryTerminated = native.terminateJob(canary._pty, canary.pid)
    stage('canary-job-terminate:done')
    if (!canaryTerminated) {
      throw new Error('exact canary job termination was refused')
    }
    closed.add(canary)
    stage('canary-exit-barriers:start')
    const [canaryExit, canaryClosed] = await Promise.all([
      waitForBarrier(canaryExited, 'canary PTY exit'),
      waitForBarrier(fixtures.waitForClose('canary-shell'), 'canary shell connection close')
    ])
    stage('canary-exit-barriers:done')

    const evidence = {
      patchedExports,
      fixtureToken,
      channel,
      target: {
        terminalHandle: targetHandle,
        shell,
        launcherExited,
        grandchild,
        jobProcessIds: targetJobProcessIds
      },
      canary: {
        terminalHandle: canaryHandle,
        process: canaryProcess,
        connectedAfterTargetClose,
        jobProcessIdsAfterTargetClose: canaryJobProcessIdsAfterTargetClose,
        exit: canaryExit,
        socketClosed: canaryClosed
      },
      close: {
        method: 'terminate-job',
        requestedHandle: targetHandle,
        completedHandle: targetHandle,
        targetExit,
        targetShellClosed,
        targetGrandchildClosed
      }
    }
    stage('fixture-close:start')
    await waitForBarrier(fixtures.close(), 'fixture server close')
    stage('fixture-close:done')
    await writeStream(process.stdout, `${EVIDENCE_PREFIX}${JSON.stringify(evidence)}\n`)
    stage('evidence:flushed')
    completed = true
  } catch (error) {
    process.stderr.write(`[windows-pty-native-capability-smoke] ${error.message}\n`)
    throw error
  } finally {
    for (const pty of created) {
      if (!closed.has(pty)) {
        stage('cleanup-job-terminate:start')
        native.terminateJob(pty._pty, pty.pid)
        stage('cleanup-job-terminate:done')
      }
    }
    if (!completed) {
      await Promise.allSettled(
        exitPromises.map((exit) => waitForBarrier(exit, 'cleanup PTY exit', 5_000))
      )
      fixtures.destroySockets()
      try {
        await waitForBarrier(fixtures.close(), 'fixture server cleanup', 5_000)
      } catch (error) {
        process.stderr.write(`[windows-pty-native-capability-smoke] ${error.message}\n`)
      }
    } else {
      await fixtures.close()
    }
  }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === '--pty-shell') {
    await runPtyShell(args[0], args[1], args[2], args[3])
    return
  }
  if (mode === '--grandchild-member') {
    connectFixture(args[0], args[1], args[2])
    return
  }
  if (mode === '--exercise') {
    if (!args[1]) {
      throw new Error('exercise mode requires a fixture Node executable')
    }
    await exercise(args[0], args[1])
    return
  }
  if (mode === '--exit-contract-fixture') {
    process.stdout.write('ORCA_ONE_SHOT_EVIDENCE=flushed\n')
    setInterval(() => {}, 60_000)
    return
  }
  throw new Error(`unknown packaged node-pty capability probe mode: ${mode}`)
}

module.exports = {
  buildGrandchildLaunch,
  createFixtureServer,
  isOneShotMode,
  reportFixtureObservation
}

if (require.main === module) {
  const mode = process.argv[2]
  main().then(
    () => (isOneShotMode(mode) ? exitOneShot(0) : undefined),
    async (error) => {
      await writeStream(process.stderr, `${error.stack || error.message}\n`)
      if (isOneShotMode(mode)) {
        await exitOneShot(1)
      } else {
        process.exitCode = 1
      }
    }
  )
}
