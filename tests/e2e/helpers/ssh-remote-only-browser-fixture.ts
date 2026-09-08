import {
  execDockerSshRelayTargetCommand,
  execDockerSshRelayTargetControlCommand,
  shellQuote,
  writeDockerSshRelayTargetFile,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

/**
 * An HTTP fixture that exists only inside the SSH container, on a hostname only the
 * container resolves and an address only the container can reach.
 *
 * Why: a client-hosted browser page proves it egresses through the SSH execution host by
 * rendering this origin at all. The viewing desktop cannot resolve `remote-only.internal`
 * and cannot reach the container's loopback, so a rendered marker is only reachable through
 * the tunnel -- no proxy bookkeeping has to be trusted.
 */
export const SSH_REMOTE_ONLY_HOST = 'remote-only.internal'
export const SSH_REMOTE_ONLY_PORT = 18_080
export const SSH_REMOTE_ONLY_ORIGIN = `http://${SSH_REMOTE_ONLY_HOST}:${SSH_REMOTE_ONLY_PORT}`
export const SSH_REMOTE_ONLY_COOKIE_NAME = 'sta4150ssh'
export const SSH_REMOTE_ONLY_COOKIE_VALUE = 'survivor'

const SERVER_PATH = '/tmp/sta-4150-ssh-browser-fixture.js'
const REQUEST_LOG_PATH = '/tmp/sta-4150-ssh-browser-requests.log'

export type SshRemoteOnlyRequest = { path: string; cookie: string | null }

const SERVER_SOURCE = [
  'const http = require("node:http")',
  'const fs = require("node:fs")',
  `const log = ${JSON.stringify(REQUEST_LOG_PATH)}`,
  'http',
  '  .createServer((request, response) => {',
  '    const url = new URL(request.url || "/", "http://fixture.invalid")',
  '    const cookie = request.headers.cookie || null',
  '    fs.appendFileSync(log, JSON.stringify({ path: url.pathname, cookie }) + "\\n")',
  '    const isLogin = url.pathname === "/login"',
  '    const marker = isLogin ? "login-marker" : "cookie:" + (cookie || "none")',
  '    const headers = {',
  '      "cache-control": "no-store",',
  '      "content-type": "text/html; charset=utf-8"',
  '    }',
  '    if (isLogin) {',
  `      headers["set-cookie"] = ${JSON.stringify(
    `${SSH_REMOTE_ONLY_COOKIE_NAME}=${SSH_REMOTE_ONLY_COOKIE_VALUE}; Max-Age=3600; Path=/; SameSite=Lax`
  )}`,
  '    }',
  '    response.writeHead(200, headers)',
  '    response.end(',
  '      "<!doctype html><html><head><title>" +',
  '        marker +',
  '        "</title></head><body><h1 id=\\"marker\\">" +',
  '        marker +',
  '        "</h1></body></html>"',
  '    )',
  '  })',
  `  .listen(${SSH_REMOTE_ONLY_PORT}, "127.0.0.1")`
].join('\n')

/** Publishes the remote-only origin inside the container and waits for it to accept sockets. */
export function startSshRemoteOnlyBrowserFixture(target: DockerSshRelayTarget): void {
  execDockerSshRelayTargetCommand(
    target,
    `grep -q ${shellQuote(SSH_REMOTE_ONLY_HOST)} /etc/hosts || printf '127.0.0.1 %s\\n' ${shellQuote(
      SSH_REMOTE_ONLY_HOST
    )} >> /etc/hosts`
  )
  writeDockerSshRelayTargetFile(target, SERVER_PATH, SERVER_SOURCE)
  execDockerSshRelayTargetCommand(
    target,
    `rm -f ${shellQuote(REQUEST_LOG_PATH)}; nohup node ${shellQuote(
      SERVER_PATH
    )} >/tmp/sta-4150-ssh-browser-fixture.log 2>&1 </dev/null &`
  )
  const waitForServer = [
    'const net = require("node:net")',
    'const deadline = Date.now() + 15000',
    'const probe = () => {',
    `  const socket = net.connect(${SSH_REMOTE_ONLY_PORT}, "127.0.0.1")`,
    '  socket.once("connect", () => { socket.destroy(); process.exit(0) })',
    '  socket.once("error", () => {',
    '    socket.destroy()',
    '    if (Date.now() >= deadline) { process.exit(1) }',
    '    setTimeout(probe, 50)',
    '  })',
    '}',
    'probe()'
  ].join('\n')
  writeDockerSshRelayTargetFile(target, '/tmp/sta-4150-ssh-browser-wait.js', waitForServer)
  execDockerSshRelayTargetCommand(target, 'node /tmp/sta-4150-ssh-browser-wait.js')
}

/** Every request the remote-only origin served, in order, with the `Cookie` header it saw. */
export function readSshRemoteOnlyRequests(target: DockerSshRelayTarget): SshRemoteOnlyRequest[] {
  const contents = execDockerSshRelayTargetControlCommand(
    target,
    `cat ${shellQuote(REQUEST_LOG_PATH)} 2>/dev/null || true`
  )
  return contents
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SshRemoteOnlyRequest)
}

/**
 * Kills the container's established SSH sessions without touching the listener, so the
 * transport really dies and the same target can be reconnected.
 *
 * `pgrep -f '^sshd: '` matches only accepted-connection processes: the daemon's own command
 * line is `/usr/sbin/sshd -D -e`, and the shell running this command starts with `bash`.
 */
export function killSshRelayTargetTransport(target: DockerSshRelayTarget): number {
  const killed = execDockerSshRelayTargetControlCommand(
    target,
    "pids=$(pgrep -f '^sshd: ' || true); for pid in $pids; do kill -9 $pid || true; done; printf '%s' \"$(printf '%s\\n' $pids | grep -c . || true)\""
  )
  return Number(killed.trim() || '0')
}
