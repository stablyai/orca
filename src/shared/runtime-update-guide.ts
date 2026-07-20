// Why: pure, dependency-free update-guide matrix for the remote server update
// advisor. Consumes already-validated (or absent) server metadata plus the
// compat verdict and produces structured, copyable guidance. No Electron / Node
// / React imports so the renderer UI unit and the mobile mirror can both render
// it. Command text lives in ./runtime-update-guide-templates.

import { describeRuntimeCompatBlock, type RuntimeCompatVerdict } from './protocol-compat'
import type { RuntimeInstallKind, RuntimeRestartKind } from './runtime-types'
import {
  appImageAssetName,
  APT_INSTALL_COMMAND,
  buildAppImageSwapCommand,
  buildDetectedLine,
  buildPackageDownloadAndInstallCommand,
  buildSystemdRestartCommand,
  DEFAULT_INSTALL_PATH,
  DEFAULT_SERVE_PORT,
  DEFAULT_SERVICE_NAME,
  DNF_INSTALL_COMMAND,
  MAC_HOMEBREW_UPGRADE_COMMAND,
  ORCA_HEADLESS_DOC_URL,
  ORCA_RELEASES_PAGE_URL,
  ORCA_REPO_README_URL,
  ORCA_WINDOWS_SETUP_URL,
  type RuntimeUpdateGuideArch
} from './runtime-update-guide-templates'

// Fields are assumed pre-validated by the separate updateInfo validation module;
// this module treats any of them as optionally-present and falls back to the
// documented defaults. The port comes from the client's own paired endpoint.
export type RuntimeUpdateGuideInput = {
  verdict: RuntimeCompatVerdict
  hostPlatform?: NodeJS.Platform | string
  installKind?: RuntimeInstallKind
  restartKind?: RuntimeRestartKind
  hostArch?: RuntimeUpdateGuideArch
  serviceName?: string
  installPath?: string
  currentVersion?: string
  latestVersion?: string
  updateAvailable?: boolean
  docsUrl?: string
  port?: number
  // Exact asset URL for the detected package install kind, supplied by release
  // metadata. Only then may a versioned filename be rendered into a command.
  assetUrl?: string
}

export type RuntimeUpdateGuideStep =
  | { kind: 'prose'; text: string }
  | { kind: 'command'; text: string }

export type RuntimeUpdateGuideLink = { label: string; url: string }

export type RuntimeUpdateGuide =
  | {
      direction: 'client-too-old'
      localUpdate: true
      title: string
      message: string
    }
  | {
      direction: 'server-too-old'
      title: string
      primary: string
      protocol: { running: number; required?: number }
      serverVersion?: string
      latestVersion?: string
      updateAvailable?: boolean
      detectedLine: string | null
      steps: RuntimeUpdateGuideStep[]
      links: RuntimeUpdateGuideLink[]
    }

// Returns null when the verdict is not a block: the advisor has nothing to show.
export function buildRuntimeUpdateGuide(input: RuntimeUpdateGuideInput): RuntimeUpdateGuide | null {
  const { verdict } = input
  if (verdict.kind === 'ok') {
    return null
  }

  // client-too-old routes to the local updater and must never emit server
  // commands; reuse the existing block message verbatim.
  if (verdict.reason === 'client-too-old') {
    return {
      direction: 'client-too-old',
      localUpdate: true,
      title: 'Update this Orca client',
      message: describeRuntimeCompatBlock(verdict)
    }
  }

  return {
    direction: 'server-too-old',
    title: 'Server update required',
    primary: 'This Orca server needs an update before this client can use it.',
    protocol: {
      running: verdict.serverProtocolVersion,
      required: verdict.requiredServerProtocolVersion
    },
    serverVersion: input.currentVersion,
    latestVersion: input.latestVersion,
    updateAvailable: input.updateAvailable,
    detectedLine: buildDetectedLine(input.installKind, input.restartKind),
    steps: buildServerSteps(input),
    links: buildLinks(input)
  }
}

function buildServerSteps(input: RuntimeUpdateGuideInput): RuntimeUpdateGuideStep[] {
  switch (input.installKind) {
    case 'linux-appimage':
      return buildAppImageSteps(input)
    case 'linux-deb':
      return buildPackageSteps(input, APT_INSTALL_COMMAND, '<downloaded-file>.deb')
    case 'linux-rpm':
      return buildPackageSteps(input, DNF_INSTALL_COMMAND, '<downloaded-file>.rpm')
    case 'mac-app':
    case 'mac-homebrew':
      return buildMacSteps(input)
    case 'windows-installer':
      return buildWindowsSteps()
    case 'source':
      return buildSourceSteps()
    default:
      return buildUnknownSteps(input)
  }
}

function buildAppImageSteps(input: RuntimeUpdateGuideInput): RuntimeUpdateGuideStep[] {
  const installPath = input.installPath ?? DEFAULT_INSTALL_PATH
  const steps: RuntimeUpdateGuideStep[] = [
    { kind: 'prose', text: 'On the server, download the new AppImage and swap it into place:' },
    { kind: 'command', text: buildAppImageSwapCommand(installPath, input.hostArch) }
  ]
  // Arch unknown: show the x64 command but name the arm64 asset instead of guessing.
  if (!input.hostArch) {
    steps.push({
      kind: 'prose',
      text: 'On an arm64 server, use the orca-linux-arm64.AppImage asset instead of orca-linux.AppImage.'
    })
  }
  steps.push(...buildAppImageRestartSteps(input, installPath))
  return steps
}

function buildAppImageRestartSteps(
  input: RuntimeUpdateGuideInput,
  installPath: string
): RuntimeUpdateGuideStep[] {
  const serviceName = input.serviceName ?? DEFAULT_SERVICE_NAME
  const port = input.port ?? DEFAULT_SERVE_PORT
  if (input.restartKind === 'systemd') {
    return [
      { kind: 'prose', text: 'Then restart the service:' },
      { kind: 'command', text: buildSystemdRestartCommand(serviceName) }
    ]
  }
  if (input.restartKind === 'foreground-serve') {
    return [{ kind: 'prose', text: foregroundRestartProse(installPath, port) }]
  }
  // desktop or unknown restart shape: cover both briefly.
  return [{ kind: 'prose', text: ambiguousRestartProse(serviceName, installPath, port) }]
}

// The example is framed as incomplete on purpose: the advisor cannot know the
// original command line, so it must not present an invented one as complete.
function foregroundRestartProse(installPath: string, port: number): string {
  return `Stop the running \`orca serve\` (Ctrl+C) and re-run your usual serve command plus any flags you normally pass (such as \`--pairing-address\`). For example: \`LIBGL_ALWAYS_SOFTWARE=1 ${installPath} serve --port ${port}\`. This example is incomplete — the advisor cannot know your original command line.`
}

function ambiguousRestartProse(serviceName: string, installPath: string, port: number): string {
  return `Then restart the server. If it runs as a systemd service, use \`sudo systemctl restart ${serviceName}\`. If you started it in a terminal, stop the running \`orca serve\` (Ctrl+C) and re-run your usual serve command, for example \`LIBGL_ALWAYS_SOFTWARE=1 ${installPath} serve --port ${port}\` plus any flags you normally pass.`
}

function buildPackageSteps(
  input: RuntimeUpdateGuideInput,
  installCommand: string,
  genericFile: string
): RuntimeUpdateGuideStep[] {
  const steps: RuntimeUpdateGuideStep[] = []
  if (input.assetUrl) {
    steps.push({ kind: 'prose', text: 'On the server, download and install the new package:' })
    steps.push({
      kind: 'command',
      text: buildPackageDownloadAndInstallCommand(input.assetUrl, installCommand)
    })
  } else {
    // Exact versioned filenames must come from release metadata; without an
    // asset URL the advisor links the releases page and uses a placeholder.
    steps.push({
      kind: 'prose',
      text: 'Download the latest package for your architecture from the releases page, then install the file you downloaded:'
    })
    steps.push({ kind: 'command', text: `${installCommand} ./${genericFile}` })
  }
  steps.push(...buildServiceRestartSteps(input))
  return steps
}

function buildServiceRestartSteps(input: RuntimeUpdateGuideInput): RuntimeUpdateGuideStep[] {
  const serviceName = input.serviceName ?? DEFAULT_SERVICE_NAME
  if (input.restartKind === 'systemd') {
    return [
      { kind: 'prose', text: 'Then restart the service:' },
      { kind: 'command', text: buildSystemdRestartCommand(serviceName) }
    ]
  }
  return [
    {
      kind: 'prose',
      text: `If the server runs as a systemd service, restart it with \`sudo systemctl restart ${serviceName}\`.`
    }
  ]
}

function buildMacSteps(input: RuntimeUpdateGuideInput): RuntimeUpdateGuideStep[] {
  const arch = input.hostArch ?? '<arch>'
  return [
    {
      kind: 'prose',
      text: `Open Orca on that Mac and use the in-app update flow, or download the latest orca-macos-${arch}.dmg from the releases page and replace the app.`
    },
    {
      kind: 'prose',
      text: 'If Orca was installed with Homebrew, update the cask instead — plain `brew upgrade` skips auto-updating casks, so `--greedy` is required:'
    },
    { kind: 'command', text: MAC_HOMEBREW_UPGRADE_COMMAND },
    { kind: 'prose', text: 'Restart the paired server after the app updates.' }
  ]
}

function buildWindowsSteps(): RuntimeUpdateGuideStep[] {
  return [
    {
      kind: 'prose',
      text: `Open Orca on that Windows machine and use the in-app update flow, or download and run ${ORCA_WINDOWS_SETUP_URL}.`
    },
    { kind: 'prose', text: 'Restart Orca (or the `orca serve` process) after installation.' }
  ]
}

function buildSourceSteps(): RuntimeUpdateGuideStep[] {
  return [
    {
      kind: 'prose',
      text: 'On the server, pull the latest changes and rebuild Orca, then restart it. See the repository README for build steps.'
    }
  ]
}

function buildUnknownSteps(input: RuntimeUpdateGuideInput): RuntimeUpdateGuideStep[] {
  const steps: RuntimeUpdateGuideStep[] = []
  const platformLabel = describePlatform(input.hostPlatform)
  if (platformLabel) {
    const version = input.currentVersion ? ` (version ${input.currentVersion})` : ''
    steps.push({ kind: 'prose', text: `The server is running on ${platformLabel}${version}.` })
  }
  // Platform-generic hint when only the OS is known.
  if (input.hostPlatform === 'linux') {
    steps.push({
      kind: 'prose',
      text: `Most headless Linux servers run the ${appImageAssetName(
        input.hostArch
      )} AppImage — download it from the releases page and swap it into place.`
    })
  }
  steps.push({
    kind: 'prose',
    text: 'Update Orca on the server machine, restart the server, and click "Check again".'
  })
  return steps
}

function describePlatform(platform: string | undefined): string | null {
  switch (platform) {
    case 'linux':
      return 'Linux'
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    default:
      return null
  }
}

function buildLinks(input: RuntimeUpdateGuideInput): RuntimeUpdateGuideLink[] {
  const links: RuntimeUpdateGuideLink[] = [
    { label: 'Orca releases', url: ORCA_RELEASES_PAGE_URL },
    { label: 'Headless Linux server guide', url: ORCA_HEADLESS_DOC_URL }
  ]
  if (input.installKind === 'source') {
    links.push({ label: 'Orca repository README', url: ORCA_REPO_README_URL })
  }
  // Server-provided docs URL is only present here after client-side validation.
  if (input.docsUrl) {
    links.push({ label: 'Server-provided update docs', url: input.docsUrl })
  }
  return links
}
