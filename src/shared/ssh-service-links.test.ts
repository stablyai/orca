import { describe, expect, it } from 'vitest'
import {
  MAX_SSH_SERVICE_LINKS,
  MAX_SSH_SERVICE_LINK_LABEL_LENGTH,
  normalizeSshServiceLink,
  normalizeSshServiceLinks
} from './ssh-service-links'

describe('normalizeSshServiceLinks', () => {
  it('keeps http and https links, trimmed', () => {
    expect(
      normalizeSshServiceLinks([
        { label: '  Grafana  ', url: ' https://build-box.example.ts.net ' },
        { label: 'Metrics', url: 'http://10.0.0.4:9090' }
      ])
    ).toEqual([
      { label: 'Grafana', url: 'https://build-box.example.ts.net' },
      { label: 'Metrics', url: 'http://10.0.0.4:9090' }
    ])
  })

  it.each([
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['ftp://example.com'],
    ['mailto:ops@example.com'],
    // Not a URL at all, and a hostless http(s) form.
    ['grafana.example.com'],
    ['https://'],
    ['data:text/html,<script>alert(1)</script>'],
    ['JAVASCRIPT:alert(1)'],
    ['java\nscript:alert(1)'],
    ['https://grafana@evil.example/'],
    ['https://user:pass@evil.example/'],
    [`https://example.com/${'a'.repeat(2048)}`]
  ])('drops %s', (url) => {
    expect(normalizeSshServiceLinks([{ label: 'Grafana', url }])).toBeUndefined()
  })

  it('drops entries whose label is empty or over the length cap', () => {
    const tooLong = 'x'.repeat(MAX_SSH_SERVICE_LINK_LABEL_LENGTH + 1)

    expect(normalizeSshServiceLinks([{ label: '   ', url: 'https://a.example' }])).toBeUndefined()
    expect(normalizeSshServiceLinks([{ label: tooLong, url: 'https://a.example' }])).toBeUndefined()
    expect(
      normalizeSshServiceLinks([
        { label: 'x'.repeat(MAX_SSH_SERVICE_LINK_LABEL_LENGTH), url: 'https://a.example' }
      ])
    ).toEqual([{ label: 'x'.repeat(MAX_SSH_SERVICE_LINK_LABEL_LENGTH), url: 'https://a.example' }])
  })

  it('caps the list, keeping the first entries', () => {
    const links = Array.from({ length: MAX_SSH_SERVICE_LINKS + 5 }, (_, index) => ({
      label: `service-${index}`,
      url: `https://service-${index}.example`
    }))

    const normalized = normalizeSshServiceLinks(links)

    expect(normalized).toHaveLength(MAX_SSH_SERVICE_LINKS)
    expect(normalized?.at(-1)).toEqual({
      label: `service-${MAX_SSH_SERVICE_LINKS - 1}`,
      url: `https://service-${MAX_SSH_SERVICE_LINKS - 1}.example`
    })
  })

  it('drops unusable entries without discarding the usable ones', () => {
    expect(
      normalizeSshServiceLinks([
        null,
        'https://not-an-object.example',
        { label: '', url: 'https://empty-label.example' },
        { label: 'Grafana', url: 'javascript:alert(1)' },
        { label: 'Grafana', url: 'https://grafana.example' }
      ])
    ).toEqual([{ label: 'Grafana', url: 'https://grafana.example' }])
  })

  it.each<[unknown]>([[undefined], [null], ['https://grafana.example'], [{}], [[]]])(
    'treats %o as no links',
    (value) => {
      expect(normalizeSshServiceLinks(value)).toBeUndefined()
    }
  )
})

describe('normalizeSshServiceLink', () => {
  it('rejects values that are not objects', () => {
    expect(normalizeSshServiceLink('Grafana')).toBeNull()
    expect(normalizeSshServiceLink(undefined)).toBeNull()
  })

  it('rejects an object missing either field', () => {
    expect(normalizeSshServiceLink({ label: 'Grafana' })).toBeNull()
    expect(normalizeSshServiceLink({ url: 'https://grafana.example' })).toBeNull()
  })

  it('keeps an uppercase http(s) scheme, which URL parsing lowercases', () => {
    expect(
      normalizeSshServiceLinks([{ label: 'Grafana', url: 'HTTPS://Example.com/d/x' }])
    ).toEqual([{ label: 'Grafana', url: 'HTTPS://Example.com/d/x' }])
  })

  it('drops a link identical to an earlier one', () => {
    expect(
      normalizeSshServiceLinks([
        { label: 'Grafana', url: 'https://grafana.example' },
        { label: 'Grafana', url: 'https://grafana.example' },
        { label: 'Grafana', url: 'https://grafana.example/d/other' }
      ])
    ).toEqual([
      { label: 'Grafana', url: 'https://grafana.example' },
      { label: 'Grafana', url: 'https://grafana.example/d/other' }
    ])
  })
})
