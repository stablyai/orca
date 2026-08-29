const POWERSHELL_NAMES = new Set(['powershell.exe', 'pwsh.exe'])

export function decodePowerShellCommand(commandLine = '') {
  const encoded = commandLine.match(/(?:^|\s)-(?:EncodedCommand|enc)\s+([^\s"]+)/i)?.[1]
  if (!encoded) {
    return commandLine
  }
  try {
    return Buffer.from(encoded, 'base64').toString('utf16le')
  } catch {
    return commandLine
  }
}

export function classifyProcessStart(event) {
  const name = String(event.name ?? '').toLowerCase()
  const command = decodePowerShellCommand(event.commandLine ?? '')
  if (!POWERSHELL_NAMES.has(name)) {
    if (/conpty_console_list_agent\.js/i.test(command)) {
      return 'console-attachment-probe'
    }
    if (name === 'typeperf.exe') {
      return 'memory-typeperf-fallback'
    }
    if (name === 'netstat' || name === 'netstat.exe') {
      return 'port-scan-netstat'
    }
    return 'other'
  }
  if (/PageFileUsage|KernelModeTime[\s\S]*UserModeTime/i.test(command)) {
    return 'memory-collector'
  }
  if (/Get-NetTCPConnection/i.test(command)) {
    return 'port-scan'
  }
  if (/status\s*=\s*'query_failed'/i.test(command)) {
    return 'daemon-incarnation'
  }
  if (/ToUnixTimeMilliseconds|CreationDate[\s\S]*missing/i.test(command)) {
    return 'hook-owner-identity'
  }
  if (/CreationDate[\s\S]*(CommandLine|cmd)/i.test(command)) {
    return 'daemon-identity'
  }
  if (/Win32_Process[\s\S]*ParentProcessId[\s\S]*ConvertTo-Json/i.test(command)) {
    return 'process-table-cim-fallback'
  }
  return 'unknown-powershell'
}

export function cadenceSummary(events) {
  if (events.length < 2) {
    return { count: events.length, intervalsMs: [] }
  }
  const times = events.map((event) => Date.parse(event.timestamp)).sort((a, b) => a - b)
  const intervalsMs = times.slice(1).map((time, index) => time - times[index])
  const sorted = [...intervalsMs].sort((a, b) => a - b)
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
  return {
    count: events.length,
    intervalsMs,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95)
  }
}
