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
  it('keeps a host with an optional port, lowercased', () => {
    expect(botMcpAppHost(' GitLab.Acme.dev ')).toBe('gitlab.acme.dev')
    expect(botMcpAppHost('git.acme.dev:8443')).toBe('git.acme.dev:8443')
    expect(botMcpAppHost('localhost')).toBe('localhost')
  })

  it('drops a pasted scheme and path', () => {
    expect(botMcpAppHost('https://gitlab.acme.dev/api/v4/mcp')).toBe('gitlab.acme.dev')
    expect(botMcpAppHost('http://gitlab.acme.dev:8080/?x=1')).toBe('gitlab.acme.dev:8080')
    expect(botMcpAppHost('gitlab.acme.dev/group#top')).toBe('gitlab.acme.dev')
  })

  it('reads empty as no host', () => {
    expect(botMcpAppHost('   ')).toBe('')
  })

  it('refuses what is not a host name', () => {
    for (const input of [
      'https://',
      'user@gitlab.acme.dev',
      'gitlab acme.dev',
      'gitlab..acme.dev',
      '-gitlab.acme.dev',
      'gitlab.acme.dev:0',
      'gitlab.acme.dev:65536',
      'gitlab.acme.dev:',
      'git_lab.acme.dev'
    ]) {
      expect(botMcpAppHost(input), input).toBeNull()
    }
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

  it('names nothing for a URL the template does not match', () => {
    expect(botMcpAppUrlTag(datadog, 'https://mcp.example.com/v1/mcp')).toBeNull()
    expect(botMcpAppUrlTag(gitlab, 'https://gitlab.acme.dev/mcp')).toBeNull()
    expect(botMcpAppUrlTag({ url: 'https://mcp.sentry.dev/mcp' }, 'https://x/mcp')).toBeNull()
  })
})
