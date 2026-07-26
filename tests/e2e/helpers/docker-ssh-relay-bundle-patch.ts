import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  execDockerSshRelayTargetCommand,
  shellQuote,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

export type DockerRelayReviveMode = 'typed-lost' | 'typed-mixed' | 'legacy' | 'malformed'

export type DockerRelayProbe = {
  capabilityPath: string
  loadedPath: string
  revivePath: string
  spawnPath: string
}

const RELAY_CAPABILITIES_NEEDLE =
  'this.dispatcher.onRequest("pty.getCapabilities",async()=>({startupIngressVersion:es,agentSessionClaimVersion:np,agentSessionCreateOperationVersion:ip,ptyPersistenceEnvelopeVersion:2,ptyReviveOutcomeVersion:Ji}))'
const RELAY_REVIVE_NEEDLE = 'this.dispatcher.onRequest("pty.revive",e=>this.revive(e))'
const RELAY_SPAWN_NEEDLE = 'this.dispatcher.onRequest("pty.spawn",(e,r)=>this.spawn(e,r))'
const INSTRUMENTATION_MARKER = '__orcaE2eRelayMixedVersionMarker'

export function createDockerRelayProbe(testId: string): DockerRelayProbe {
  const root = `/tmp/orca-e2e-relay-${testId}-${Date.now()}`
  return {
    capabilityPath: `${root}-capability`,
    loadedPath: `${root}-loaded`,
    revivePath: `${root}-revive`,
    spawnPath: `${root}-spawn`
  }
}

export function patchDockerRelayBundle(
  mode: DockerRelayReviveMode,
  probe: DockerRelayProbe
): () => void {
  const originals = ['linux-x64', 'linux-arm64'].map((platform) => {
    const relayPath = path.join(process.cwd(), 'out', 'relay', platform, 'relay.js')
    return { relayPath, source: readFileSync(relayPath, 'utf8') }
  })
  for (const { relayPath, source } of originals) {
    writeFileSync(relayPath, patchDockerRelaySource(source, mode, probe))
  }
  return () => {
    for (const { relayPath, source } of originals) {
      writeFileSync(relayPath, source)
    }
  }
}

export function readDockerRelayProbe(target: DockerSshRelayTarget, filePath: string): string[] {
  const output = execDockerSshRelayTargetCommand(
    target,
    `test -f ${shellQuote(filePath)} && cat ${shellQuote(filePath)} || true`
  )
  return output.split('\n').filter(Boolean)
}

export function clearDockerRelayProbe(target: DockerSshRelayTarget, probe: DockerRelayProbe): void {
  execDockerSshRelayTargetCommand(
    target,
    `rm -f ${[probe.capabilityPath, probe.revivePath, probe.spawnPath].map(shellQuote).join(' ')}`
  )
}

function relayInstrumentation(probe: DockerRelayProbe): string {
  return [
    `const ${INSTRUMENTATION_MARKER}=true`,
    'const __orcaE2eFs=require("node:fs")',
    `const __orcaE2eCapabilityPath=${JSON.stringify(probe.capabilityPath)}`,
    `const __orcaE2eLoadedPath=${JSON.stringify(probe.loadedPath)}`,
    `const __orcaE2eRevivePath=${JSON.stringify(probe.revivePath)}`,
    `const __orcaE2eSpawnPath=${JSON.stringify(probe.spawnPath)}`,
    '__orcaE2eFs.appendFileSync(__orcaE2eLoadedPath,"loaded\\n")',
    'const __orcaE2eRecord=kind=>__orcaE2eFs.appendFileSync(kind.startsWith("capability")?__orcaE2eCapabilityPath:kind.startsWith("revive")?__orcaE2eRevivePath:__orcaE2eSpawnPath,kind+"\\n")',
    'const __orcaE2eLost=state=>{const entries=JSON.parse(state).entries||[];return{outcomeVersion:1,revived:[],lost:entries.map(entry=>{const lost={id:entry.id,kind:"recognized-worker",reason:"worker-replacement-forbidden",pid:entry.pid,cols:entry.cols,rows:entry.rows,cwd:entry.cwd};for(const key of["sourceIncarnationId","paneKey","tabId","attachIdentity","worktreeId","terminalHandle","replayTail","durableLaunch","agentOwners","providerSession","orchestrationTaskId"]){if(entry[key]!==undefined)lost[key]=entry[key]}return lost}),diagnostics:[]}}',
    'const __orcaE2eMixed=state=>{const entries=JSON.parse(state).entries||[];const lost=__orcaE2eLost(state).lost;return{outcomeVersion:1,lost:lost.slice(0,1),revived:entries.slice(1).map(entry=>{const revived={id:entry.id,disposition:"replacement-spawned",incarnationId:`e2e-replacement-${entry.id}`};for(const key of["paneKey","tabId"]){if(entry[key]!==undefined)revived[key]=entry[key]}return revived}),diagnostics:[]}}'
  ].join(';')
}

function patchDockerRelaySource(
  original: string,
  mode: DockerRelayReviveMode,
  probe: DockerRelayProbe
): string {
  if (original.includes(INSTRUMENTATION_MARKER)) {
    throw new Error('Docker relay bundle already has an E2E mixed-version patch')
  }
  const replacements: [string, string][] = [
    [
      RELAY_SPAWN_NEEDLE,
      'this.dispatcher.onRequest("pty.spawn",(e,r)=>(__orcaE2eRecord("spawn"),this.spawn(e,r)))'
    ],
    [RELAY_REVIVE_NEEDLE, reviveHandler(mode)],
    [RELAY_CAPABILITIES_NEEDLE, capabilityHandler(mode)]
  ]
  let patched = original
  for (const [needle, replacement] of replacements) {
    if (!patched.includes(needle)) {
      throw new Error(`Docker relay bundle is missing E2E seam: ${needle.slice(0, 64)}`)
    }
    patched = patched.replace(needle, replacement)
  }
  const newline = patched.indexOf('\n')
  if (!patched.startsWith('#!') || newline === -1) {
    throw new Error('Docker relay bundle lost its executable shebang')
  }
  return `${patched.slice(0, newline + 1)}${relayInstrumentation(probe)};\n${patched.slice(newline + 1)}`
}

function capabilityHandler(mode: DockerRelayReviveMode): string {
  if (mode === 'legacy') {
    return 'this.dispatcher.onRequest("pty.getCapabilities",async()=>{__orcaE2eRecord("capability:legacy");return{startupIngressVersion:es,agentSessionClaimVersion:np,agentSessionCreateOperationVersion:ip}})'
  }
  return 'this.dispatcher.onRequest("pty.getCapabilities",async()=>{__orcaE2eRecord("capability:typed");return{startupIngressVersion:es,agentSessionClaimVersion:np,agentSessionCreateOperationVersion:ip,ptyPersistenceEnvelopeVersion:2,ptyReviveOutcomeVersion:Ji}})'
}

function reviveHandler(mode: DockerRelayReviveMode): string {
  if (mode === 'typed-lost') {
    return 'this.dispatcher.onRequest("pty.revive",e=>{__orcaE2eRecord(`revive:${e.formatVersion===2?"typed":"legacy"}`);return e.formatVersion===2?__orcaE2eLost(e.state):this.revive(e)})'
  }
  if (mode === 'typed-mixed') {
    return 'this.dispatcher.onRequest("pty.revive",e=>{__orcaE2eRecord(`revive:${e.formatVersion===2?"typed":"legacy"}`);return e.formatVersion===2?__orcaE2eMixed(e.state):this.revive(e)})'
  }
  if (mode === 'malformed') {
    return 'this.dispatcher.onRequest("pty.revive",e=>{__orcaE2eRecord(`revive:${e.formatVersion===2?"typed":"legacy"}`);return e.formatVersion===2?{outcomeVersion:1,revived:"invalid",lost:[],diagnostics:[]}:this.revive(e)})'
  }
  return 'this.dispatcher.onRequest("pty.revive",e=>{__orcaE2eRecord(`revive:${e.formatVersion===2?"typed":"legacy"}`);return this.revive(e)})'
}
