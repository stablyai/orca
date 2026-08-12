declare module 'psl' {
  export type ParsedDomain = {
    input: string
    tld: string | null
    sld: string | null
    domain: string | null
    subdomain: string | null
    listed: boolean
  }

  export type ParseError = {
    input: string
    error: { code: string; message: string }
  }

  export function parse(input: string): ParsedDomain | ParseError
}
