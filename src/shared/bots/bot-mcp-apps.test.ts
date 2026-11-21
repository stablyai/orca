import { describe, expect, it } from 'vitest'
import { botMcpAppHost, botMcpAppUrl, botMcpAppUrlTag } from './bot-mcp-apps'

const gitlab = {
  url: 'https://{host}/api/v4/mcp',
  variable: {
    key: 'host',
    label: 'Address',
    default: 'gitlab.com',
    placeholder: 'gitlab.example.com',
    hint: ''
  }
}

describe('botMcpAppUrl', () => {
  it('fills the blank with the value, or the default when none is given', () => {
    expect(botMcpAppUrl(gitlab, 'git.acme.dev:8443')).toBe('https://git.acme.dev:8443/api/v4/mcp')
    expect(botMcpAppUrl(gitlab, '')).toBe('https://gitlab.com/api/v4/mcp')
    expect(botMcpAppUrl(gitlab)).toBe('https://gitlab.com/api/v4/mcp')
  })

  it('leaves an app without a blank at its one URL', () => {
    expect(botMcpAppUrl({ url: 'https://mcp.sentry.dev/mcp' }, 'x')).toBe(
      'https://mcp.sentry.dev/mcp'
    )
  })
})

describe('botMcpAppHost', () => {
  it('keeps a host with an optional port, normalized', () => {
    expect(botMcpAppHost(' GitLab.Acme.dev ')).toBe('gitlab.acme.dev')
    expect(botMcpAppHost('git.acme.dev:8443')).toBe('git.acme.dev:8443')
    expect(botMcpAppHost('localhost')).toBe('localhost')
    expect(botMcpAppHost('[::1]:8443')).toBe('[::1]:8443')
    expect(botMcpAppHost('gitlab.acme.dev.')).toBe('gitlab.acme.dev.')
    expect(botMcpAppHost('gitlab.bücher.de')).toBe('gitlab.xn--bcher-kva.de')
  })

  it('reads a pasted http(s) URL for its host and port alone', () => {
    expect(botMcpAppHost('https://gitlab.acme.dev/api/v4/mcp')).toBe('gitlab.acme.dev')
    expect(botMcpAppHost('http://gitlab.acme.dev:8080/?x=1')).toBe('gitlab.acme.dev:8080')
    expect(botMcpAppHost('https://[2001:db8::1]:8443/x')).toBe('[2001:db8::1]:8443')
    expect(botMcpAppHost('gitlab.acme.dev/group#top')).toBe('gitlab.acme.dev')
  })

  it('reads empty as no host', () => {
    expect(botMcpAppHost('   ')).toBe('')
  })

  it('refuses userinfo, other schemes, bad IDNA, bad ports and non-hosts', () => {
    for (const input of [
      'https://',
      'user@gitlab.acme.dev',
      'https://user:pw@gitlab.acme.dev',
      'file://gitlab.acme.dev/etc',
      'file:/etc/config',
      'javascript:alert(1)',
      'mailto:admin@gitlab.acme.dev',
      'gitlab.acme.dev:',
      'javascript://gitlab.acme.dev/%0Aalert(1)',
      'ftp://gitlab.acme.dev',
      'xn--a.example',
      'gitlab acme.dev',
      'gitlab.acme.dev:0',
      'gitlab.acme.dev:65536'
    ]) {
      expect(botMcpAppHost(input), input).toBeNull()
    }
  })

  it('keeps a typed port when reading http as https, and drops only an omitted or https default', () => {
    expect(botMcpAppHost('http://git.example:80/group')).toBe('git.example:80')
    expect(botMcpAppHost('http://git.example/group')).toBe('git.example')
    expect(botMcpAppHost('https://git.example:443/group')).toBe('git.example')
    expect(botMcpAppHost('localhost:80')).toBe('localhost:80')
  })

  it('builds the https endpoint from the normalized host', () => {
    expect(botMcpAppUrl(gitlab, botMcpAppHost('HTTP://[::1]:8443/x') ?? '')).toBe(
      'https://[::1]:8443/api/v4/mcp'
    )
  })
})

describe('botMcpAppUrlTag', () => {
  const datadog = {
    url: 'https://mcp.{site}/v1/mcp',
    variable: {
      key: 'site',
      label: 'Site',
      default: 'datadoghq.com',
      choices: [
        { name: 'US1', place: 'US East', value: 'datadoghq.com' },
        { name: 'EU', place: 'Europe', value: 'datadoghq.eu' }
      ]
    }
  }

  it('names a picked site and a typed host, and nothing at the default', () => {
    expect(botMcpAppUrlTag(datadog, 'https://mcp.datadoghq.eu/v1/mcp')).toBe('EU')
    expect(botMcpAppUrlTag(datadog, 'https://mcp.datadoghq.com/v1/mcp')).toBeNull()
    expect(botMcpAppUrlTag(gitlab, 'https://git.acme.dev:8443/api/v4/mcp')).toBe(
      'git.acme.dev:8443'
    )
    expect(botMcpAppUrlTag(gitlab, 'https://gitlab.com/api/v4/mcp')).toBeNull()
  })

  it('names nothing at a default written another way', () => {
    expect(botMcpAppUrlTag(gitlab, 'https://GitLab.com:443/api/v4/mcp')).toBeNull()
  })

  it('names nothing for a URL the template does not make, whole path included', () => {
    expect(botMcpAppUrlTag(datadog, 'https://mcp.example.com/v1/mcp')).toBeNull()
    expect(botMcpAppUrlTag(gitlab, 'https://gitlab.acme.dev/mcp')).toBeNull()
    expect(botMcpAppUrlTag(gitlab, 'https://git.example/group/api/v4/mcp')).toBeNull()
    expect(botMcpAppUrlTag(gitlab, 'https://git.example/x?y=/api/v4/mcp')).toBeNull()
    expect(botMcpAppUrlTag(gitlab, 'https://git.example/#/api/v4/mcp')).toBeNull()
    expect(botMcpAppUrlTag(gitlab, 'http://git.example/api/v4/mcp')).toBeNull()
    expect(botMcpAppUrlTag({ url: 'https://mcp.sentry.dev/mcp' }, 'https://x/mcp')).toBeNull()
  })
})
