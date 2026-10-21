import { describe, expect, it, vi } from 'vitest'
import {
  endEmbeddedLanguages,
  formatTokenizedLines,
  tokenizeMonarchDocument,
  tokenTypeAt
} from './monarch-tokenizer-test-harness'
import {
  HTTP_LANGUAGE_ID,
  httpLanguageConfiguration,
  httpMonarchLanguage,
  registerHttpLanguage
} from './register-http'

function tokenizeHttp(source: string) {
  return tokenizeMonarchDocument(HTTP_LANGUAGE_ID, httpMonarchLanguage, source)
}

function createMonacoMock() {
  const languages: { id: string }[] = []
  return {
    languages: {
      getLanguages: vi.fn(() => languages),
      register: vi.fn((entry: { id: string }) => {
        languages.push({ id: entry.id })
      }),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn()
    }
  }
}

describe('registerHttpLanguage', () => {
  it('registers the http language for .http and .rest files once', () => {
    const monaco = createMonacoMock()

    registerHttpLanguage(monaco)
    registerHttpLanguage(monaco)

    expect(monaco.languages.register).toHaveBeenCalledTimes(1)
    expect(monaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: HTTP_LANGUAGE_ID, extensions: ['.http', '.rest'] })
    )
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      HTTP_LANGUAGE_ID,
      httpLanguageConfiguration
    )
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      HTTP_LANGUAGE_ID,
      httpMonarchLanguage
    )
  })
})

describe('http tokenization', () => {
  it('tokenizes REST Client and JetBrains HTTP Client requests', () => {
    const fixture = `@host = https://{{env}}.example.com
import ./login.http

### Create order
# @name createOrder
POST {{host}}/orders HTTP/1.1
    ?expand=items
Content-Type: application/json

{"id": 7, "note": "{{note}}", "paid": false}

> {%
    client.global.set("orderId", response.body.id);
%}

### Upload
< {% request.variables.set("day", "1") %}
PUT {{host}}/files
Authorization: Bearer {{token}}

< ./payload.bin
>> ./response.json`

    expect(formatTokenizedLines(tokenizeHttp(fixture))).toMatchInlineSnapshot(`
      [
        "@host = https://{{env}}.example.com | 0:variable.http@http 5:delimiter.http@http 7:string.http@http 16:variable.http@http 23:string.http@http | embed=none",
        "import ./login.http | 0:keyword.http@http 6:-@http 7:string.http@http | embed=none",
        " |  | embed=none",
        "### Create order | 0:type.http@http | embed=none",
        "# @name createOrder | 0:comment.http@http 2:annotation.http@http 7:comment.http@http | embed=none",
        "POST {{host}}/orders HTTP/1.1 | 0:keyword.http@http 4:-@http 5:variable.http@http 13:string.http@http 20:-@http 21:keyword.http@http | embed=none",
        "    ?expand=items | 0:-@http 4:delimiter.http@http 5:string.http@http | embed=none",
        "Content-Type: application/json | 0:attribute.name.http@http 12:delimiter.http@http 13:attribute.value.http@http | embed=none",
        " |  | embed=none",
        "{"id": 7, "note": "{{note}}", "paid": false} | 0:delimiter.bracket.http@http 1:attribute.name.http@http 5:delimiter.http@http 6:-@http 7:number.http@http 8:delimiter.http@http 9:-@http 10:attribute.name.http@http 16:delimiter.http@http 17:-@http 18:string.http@http 19:variable.http@http 27:string.http@http 28:delimiter.http@http 29:-@http 30:attribute.name.http@http 36:delimiter.http@http 37:-@http 38:keyword.http@http 43:delimiter.bracket.http@http | embed=none",
        " |  | embed=none",
        "> {% | 0:keyword.http@http 1:-@http 2:delimiter.http@http | embed=javascript",
        "    client.global.set("orderId", response.body.id); | 0:-@javascript | embed=javascript",
        "%} | 0:delimiter.http@http | embed=none",
        " |  | embed=none",
        "### Upload | 0:type.http@http | embed=none",
        "< {% request.variables.set("day", "1") %} | 0:keyword.http@http 1:-@http 2:delimiter.http@http 4:-@javascript 39:delimiter.http@http | embed=none",
        "PUT {{host}}/files | 0:keyword.http@http 3:-@http 4:variable.http@http 12:string.http@http | embed=none",
        "Authorization: Bearer {{token}} | 0:attribute.name.http@http 13:delimiter.http@http 14:attribute.value.http@http 22:variable.http@http | embed=none",
        " |  | embed=none",
        "< ./payload.bin | 0:keyword.http@http 1:-@http 2:string.http@http | embed=none",
        ">> ./response.json | 0:keyword.http@http 2:-@http 3:string.http@http | embed=none",
      ]
    `)
  })

  it('recovers from an unterminated {% script at the next request separator', () => {
    const lines = tokenizeHttp(`> {%
    client.log("missing close")
### Next
GET https://example.com`)

    expect(endEmbeddedLanguages(lines)).toEqual(['javascript', 'javascript', null, null])
    expect(tokenTypeAt(lines[3], 0)).toBe('keyword')
  })

  it('ends a variable definition at its line even when it ends in a {{variable}}', () => {
    const lines = tokenizeHttp(`@url = {{base}}/api/{{version}}
GET {{url}}/health`)

    expect(tokenTypeAt(lines[1], 0)).toBe('keyword')
  })

  it('treats a quoted JSON key in the body as a body line, not a header', () => {
    const lines = tokenizeHttp(`POST https://example.com
Accept: application/json
"Accept": "not a header"`)

    expect(tokenTypeAt(lines[1], 16)).toBe('attribute.value')
    expect(tokenTypeAt(lines[2], 12)).toBe('string')
  })
})
