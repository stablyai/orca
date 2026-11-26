import { describe, expect, it } from 'vitest'
import { redactLocalPaths } from './slack-local-paths'

describe('redactLocalPaths', () => {
  it('turns a local image embed into its words', () => {
    expect(
      redactLocalPaths('Here:\n![side by side](~/.orca/reports/bot-share/side.png)\nDone.')
    ).toBe('Here:\nside by side\nDone.')
  })

  it('names the file when a local image has no words', () => {
    expect(redactLocalPaths('![](/Users/ada/shots/before.png)')).toBe('before.png')
  })

  it('keeps remote images and links whole, scrubbing only their words', () => {
    const text = '![chart](https://example.com/c.png) and [PR](https://github.com/o/r/pull/1)'
    expect(redactLocalPaths(text)).toBe(text)
    expect(redactLocalPaths('[/Users/ada/r.html](https://share.example/a/1)')).toBe(
      '[r.html](https://share.example/a/1)'
    )
    expect(redactLocalPaths('<https://share.example/a/1|/Users/ada/r.html>')).toBe(
      '<https://share.example/a/1|r.html>'
    )
  })

  it('keeps a remote URL whole, parentheses and all, beside a real local path', () => {
    const url = 'https://docs.example.com/view/(draft)/Users/ada/report.html'
    expect(redactLocalPaths(`${url} and /Users/ada/a.md`)).toBe(`${url} and a.md`)
    expect(redactLocalPaths(`[report](${url}) and /Users/ada/a.md`)).toBe(
      `[report](${url}) and a.md`
    )
    const nested = 'https://docs.example.com/view/((draft))/Users/ada/report.html'
    expect(redactLocalPaths(`[report](${nested}) and /Users/ada/a.md`)).toBe(
      `[report](${nested}) and a.md`
    )
    expect(redactLocalPaths('[  important  ](https://x.dev/a)')).toBe(
      '[  important  ](https://x.dev/a)'
    )
    expect(redactLocalPaths('![  chart  ](https://x.dev/a.png)')).toBe(
      '![  chart  ](https://x.dev/a.png)'
    )
  })

  it('keeps only the words of a local link, markdown or Slack', () => {
    expect(redactLocalPaths('See [the report](/Users/ada/r/report.html).')).toBe('See the report.')
    expect(redactLocalPaths('[/Users/ada/r.html](/Users/ada/r.html)')).toBe('r.html')
    expect(redactLocalPaths('See <file:///Users/ada/r/report.html|the report>.')).toBe(
      'See the report.'
    )
    expect(redactLocalPaths('See <file:///tmp/r/report.html>.')).toBe('See report.html.')
    expect(redactLocalPaths('[deck](</Users/ada/My Docs/deck.pdf>)')).toBe('deck')
  })

  it.each([
    ['FILE:///Users/ada/private/report.html', 'report.html'],
    ['[report](FiLe:///Users/ada/private/report.html)', 'report'],
    ['![chart](FILE:///tmp/private/chart.png)', 'chart'],
    ['<fIlE:///tmp/private/report.html|report>', 'report']
  ])('redacts file schemes regardless of case %#', (input, expected) => {
    expect(redactLocalPaths(input)).toBe(expected)
  })

  it.each([
    [
      '[report](https://example.com/r "Saved at /Users/ada/private/report.html")',
      '[report](https://example.com/r "Saved at report.html")'
    ],
    [
      "![chart](https://example.com/Users/ada/chart.png 'Saved at FILE:///tmp/private/chart.png') /tmp/next.md",
      "![chart](https://example.com/Users/ada/chart.png 'Saved at chart.png') next.md"
    ],
    [
      '[/Users/ada/report.html](https://example.com/r (Saved at /home/ada/private/report.html))',
      '[report.html](https://example.com/r (Saved at report.html))'
    ]
  ])(
    'redacts private paths in remote reference titles while keeping their destinations %#',
    (input, expected) => {
      expect(redactLocalPaths(input)).toBe(expected)
    }
  )

  it.each([
    [
      String.raw`[x](https://example.test/a "at /tmp/a\"b.md")[y](/tmp/b.md)`,
      String.raw`[x](https://example.test/a "at a\"b.md")y`
    ],
    [
      String.raw`[x](https://example.test/a 'at /tmp/a\'b.md')[y](/tmp/b.md)`,
      String.raw`[x](https://example.test/a 'at a\'b.md')y`
    ],
    [
      String.raw`[x](https://example.test/a (at /tmp/a\)b.md))[y](/tmp/b.md)`,
      String.raw`[x](https://example.test/a (at a\)b.md))y`
    ],
    [
      String.raw`![x](https://example.test/a "at /tmp/a\"b.md")[y](/tmp/b.md)`,
      String.raw`![x](https://example.test/a "at a\"b.md")y`
    ],
    [
      String.raw`![x](https://example.test/a 'at /tmp/a\'b.md')[y](/tmp/b.md)`,
      String.raw`![x](https://example.test/a 'at a\'b.md')y`
    ],
    [
      String.raw`![x](https://example.test/a (at /tmp/a\)b.md))[y](/tmp/b.md)`,
      String.raw`![x](https://example.test/a (at a\)b.md))y`
    ],
    [
      String.raw`[x](https://example.test/a "at /tmp/a\\")[y](/tmp/b.md)`,
      String.raw`[x](https://example.test/a "at a\\")y`
    ],
    [
      String.raw`[x](https://example.test/a 'at /tmp/a\\')[y](/tmp/b.md)`,
      String.raw`[x](https://example.test/a 'at a\\')y`
    ],
    [
      String.raw`[x](https://example.test/a (at /tmp/a\\))[y](/tmp/b.md)`,
      String.raw`[x](https://example.test/a (at a\\))y`
    ]
  ])('keeps title delimiter escapes when shortening local paths %#', (input, expected) => {
    expect(redactLocalPaths(input)).toBe(expected)
  })

  it('preserves bracketed remote URL targets beside a local report path', () => {
    expect(redactLocalPaths('https://[2001:db8::1]/Users/ada/report.html /Users/ada/a.md')).toBe(
      'https://[2001:db8::1]/Users/ada/report.html a.md'
    )
    expect(redactLocalPaths('https://x.dev/?p=[/Users/ada/report.html] /Users/ada/a.md')).toBe(
      'https://x.dev/?p=[/Users/ada/report.html] a.md'
    )
    expect(
      redactLocalPaths('[remote](https://[2001:db8::1]/Users/ada/report.html) /Users/ada/a.md')
    ).toBe('[remote](https://[2001:db8::1]/Users/ada/report.html) a.md')
    expect(
      redactLocalPaths(
        '[remote](https://[2001:db8::1]/view/(draft)/Users/ada/report.html)[local](/Users/ada/a.md)'
      )
    ).toBe('[remote](https://[2001:db8::1]/view/(draft)/Users/ada/report.html)local')
    expect(redactLocalPaths('https://x.dev/?p=[unclosed /Users/ada/a.md')).toBe(
      'https://x.dev/?p=[unclosed a.md'
    )
  })

  it('preserves excluded system, repository and ambiguous relative images', () => {
    expect(redactLocalPaths('![  system  ](/usr/share/icons/logo.png)')).toBe(
      '![  system  ](/usr/share/icons/logo.png)'
    )
    expect(redactLocalPaths('![  repo  ](src/main/Users/diagram.png)')).toBe(
      '![  repo  ](src/main/Users/diagram.png)'
    )
    expect(redactLocalPaths('![  relative  ](report.png)')).toBe('![  relative  ](report.png)')
    expect(redactLocalPaths('![  local  ](/Users/ada/report.png)')).toBe('local')
  })

  it('ends a nested remote Markdown destination after leading whitespace', () => {
    expect(
      redactLocalPaths('[remote]( https://example.com/(draft))[local](/Users/ada/report.html)')
    ).toBe('[remote]( https://example.com/(draft))local')
    expect(
      redactLocalPaths('[remote](\thttps://example.com/(draft))[local](/Users/ada/report.html)')
    ).toBe('[remote](\thttps://example.com/(draft))local')
    expect(
      redactLocalPaths('[remote](\nhttps://example.com/(draft))[local](/Users/ada/report.html)')
    ).toBe('[remote](\nhttps://example.com/(draft))local')
    expect(
      redactLocalPaths('[remote](https://example.com/(draft))[local](/Users/ada/report.html)')
    ).toBe('[remote](https://example.com/(draft))local')
    expect(
      redactLocalPaths(
        '[remote]( https://[2001:db8::1]/?p=[/Users/ada/r.html]&(draft))[local](/Users/ada/report.html)'
      )
    ).toBe('[remote]( https://[2001:db8::1]/?p=[/Users/ada/r.html]&(draft))local')
    expect(redactLocalPaths('[remote]( https://example.com/(draft))local')).toBe(
      '[remote]( https://example.com/(draft))local'
    )
    expect(
      redactLocalPaths(
        '[remote]( https://example.com/draft\\)/Users/ada/r.html)[local](/Users/ada/report.html)'
      )
    ).toBe('[remote]( https://example.com/draft\\)/Users/ada/r.html)local')
  })

  it.each([
    [
      "[remote](https://example.com/(draft's)/Users/ada/r.html)[local](/Users/ada/report.html)",
      "[remote](https://example.com/(draft's)/Users/ada/r.html)local"
    ],
    [
      "[remote]( https://example.com/(draft's)/Users/ada/r.html)[local](/Users/ada/report.html)",
      "[remote]( https://example.com/(draft's)/Users/ada/r.html)local"
    ],
    [
      "[remote](\thttps://example.com/(draft's)/Users/ada/r.html)[local](/Users/ada/report.html)",
      "[remote](\thttps://example.com/(draft's)/Users/ada/r.html)local"
    ],
    [
      "[remote](\nhttps://example.com/(draft's)/Users/ada/r.html)[local](/Users/ada/report.html)",
      "[remote](\nhttps://example.com/(draft's)/Users/ada/r.html)local"
    ],
    [
      "![remote](https://example.com/(draft's)/Users/ada/r.png)[local](/Users/ada/report.html)",
      "![remote](https://example.com/(draft's)/Users/ada/r.png)local"
    ],
    [
      "![remote]( https://example.com/(draft's)/Users/ada/r.png)[local](/Users/ada/report.html)",
      "![remote]( https://example.com/(draft's)/Users/ada/r.png)local"
    ],
    [
      "![remote](\thttps://example.com/(draft's)/Users/ada/r.png)[local](/Users/ada/report.html)",
      "![remote](\thttps://example.com/(draft's)/Users/ada/r.png)local"
    ],
    [
      "![remote](\nhttps://example.com/(draft's)/Users/ada/r.png)[local](/Users/ada/report.html)",
      "![remote](\nhttps://example.com/(draft's)/Users/ada/r.png)local"
    ]
  ])(
    'preserves punctuation through a balanced remote Markdown destination %#',
    (input, expected) => {
      expect(redactLocalPaths(input)).toBe(expected)
    }
  )

  it('keeps Markdown punctuation and escapes separate from bare-prose URL boundaries', () => {
    expect(
      redactLocalPaths(
        "[remote]( https://example.com/(draft's;v=1+$&@!,)/Users/ada/r.html)[local](/Users/ada/report.html)"
      )
    ).toBe("[remote]( https://example.com/(draft's;v=1+$&@!,)/Users/ada/r.html)local")
    expect(
      redactLocalPaths(
        "![remote]( https://example.com/draft\\)'s/Users/ada/r.png)[local](/Users/ada/report.html)"
      )
    ).toBe("![remote]( https://example.com/draft\\)'s/Users/ada/r.png)local")
    expect(redactLocalPaths("'https://example.com/(draft)' '/Users/ada/report.html'")).toBe(
      "'https://example.com/(draft)' 'report.html'"
    )
    expect(redactLocalPaths('"https://example.com/(draft)" /Users/ada/report.html')).toBe(
      '"https://example.com/(draft)" report.html'
    )
  })

  it.each([
    [
      '"literal](https://docs.example/(v1)"<file:///tmp/private/r.md|local>)',
      '"literal](https://docs.example/(v1)"local)'
    ],
    [
      '`literal](https://docs.example/(v1)`<file:///tmp/private/r.md|local>)',
      '`literal](https://docs.example/(v1)`local)'
    ],
    [
      '"literal](https://docs.example/(v1)"/tmp/private/r.md)',
      '"literal](https://docs.example/(v1)"r.md)'
    ],
    [
      '"[literal](https://docs.example/(v1)"<file:///tmp/private/r.md|local>)',
      '"[literal](https://docs.example/(v1)"local)'
    ],
    [
      '`[literal](https://docs.example/(v1)`<file:///tmp/private/r.md|local>)',
      '`[literal](https://docs.example/(v1)`local)'
    ],
    [
      '"\\[literal](https://docs.example/(v1)"<file:///tmp/private/r.md|local>)',
      '"\\[literal](https://docs.example/(v1)"local)'
    ],
    [
      '"[literal\\](https://docs.example/(v1)"<file:///tmp/private/r.md|local>)',
      '"[literal\\](https://docs.example/(v1)"local)'
    ]
  ])(
    'retains prose and code boundaries without a complete Markdown reference %#',
    (input, expected) => {
      expect(redactLocalPaths(input)).toBe(expected)
      expect(redactLocalPaths(expected)).toBe(expected)
    }
  )

  it('recognizes complete remote references with nested destinations and titles', () => {
    expect(
      redactLocalPaths(
        '[remote]( https://example.com/(draft\'s)/Users/ada/r.html "review (v1)")[local](/tmp/r.md)'
      )
    ).toBe('[remote]( https://example.com/(draft\'s)/Users/ada/r.html "review (v1)")local')
    expect(
      redactLocalPaths(
        "![remote]( https://example.com/(draft's)/Users/ada/r.png 'review (v1)')[local](/tmp/r.md)"
      )
    ).toBe("![remote]( https://example.com/(draft's)/Users/ada/r.png 'review (v1)')local")
    expect(
      redactLocalPaths(
        "[remote]( https://example.com/(draft's)/Users/ada/r.html (review (v1)))[local](/tmp/r.md)"
      )
    ).toBe("[remote]( https://example.com/(draft's)/Users/ada/r.html (review (v1)))local")
  })

  it.each([
    [
      '[remote](https://x.dev/(draft\\"v1)/Users/ada/r.html)[local](/tmp/private/r.md)',
      '[remote](https://x.dev/(draft\\"v1)/Users/ada/r.html)local'
    ],
    [
      '![remote](https://x.dev/(draft\\"v1)/Users/ada/r.png)[local](/tmp/private/r.md)',
      '![remote](https://x.dev/(draft\\"v1)/Users/ada/r.png)local'
    ],
    [
      '[remote](https://x.dev/(draft\\`v1)/Users/ada/r.html)[local](/tmp/private/r.md)',
      '[remote](https://x.dev/(draft\\`v1)/Users/ada/r.html)local'
    ],
    [
      '![remote](https://x.dev/(draft\\`v1)/Users/ada/r.png)[local](/tmp/private/r.md)',
      '![remote](https://x.dev/(draft\\`v1)/Users/ada/r.png)local'
    ],
    [
      '[remote](https://x.dev/(draft\\<v1)/Users/ada/r.html)[local](/tmp/private/r.md)',
      '[remote](https://x.dev/(draft\\<v1)/Users/ada/r.html)local'
    ],
    [
      '![remote](https://x.dev/(draft\\<v1)/Users/ada/r.png)[local](/tmp/private/r.md)',
      '![remote](https://x.dev/(draft\\<v1)/Users/ada/r.png)local'
    ]
  ])('preserves escaped punctuation in complete remote destinations %#', (input, expected) => {
    expect(redactLocalPaths(input)).toBe(expected)
  })

  it('finds later valid references after a rejected title without changing their destinations', () => {
    expect(
      redactLocalPaths(
        "[broken](https://x.dev/ (draft [remote](https://x.dev/(draft's)/Users/ada/r.html)[local](/tmp/private/r.md)"
      )
    ).toBe("[broken](https://x.dev/ (draft [remote](https://x.dev/(draft's)/Users/ada/r.html)local")
    expect(
      redactLocalPaths(
        '[remote](https://x.dev/(draft\'s)/Users/ada/r.html "review (draft")[local](/tmp/r.md)'
      )
    ).toBe('[remote](https://x.dev/(draft\'s)/Users/ada/r.html "review (draft")local')
  })

  it('reduces bare paths to the file name, in prose and code', () => {
    expect(
      redactLocalPaths(
        'Saved to /Users/ada/.orca/reports/x/report.html, also `~/notes/plan.md`.\n```\ncat /tmp/run/out.log\n```'
      )
    ).toBe('Saved to report.html, also `plan.md`.\n```\ncat out.log\n```')
  })

  it('never leaves a home folder or an empty name', () => {
    expect(redactLocalPaths('in /Users/ada and /home/ada/ and C:\\Users\\ada')).toBe(
      'in ~ and ~ and ~'
    )
    expect(redactLocalPaths('in /tmp.')).toBe('in tmp.')
    expect(redactLocalPaths('![](~/)')).toBe('~')
  })

  it('covers Windows profiles, /home and /private', () => {
    expect(redactLocalPaths('C:\\Users\\ada\\Desktop\\shot.png')).toBe('shot.png')
    expect(redactLocalPaths('at /home/ada/x/y.csv')).toBe('at y.csv')
    expect(redactLocalPaths('at /private/var/folders/ab/T/z.pdf')).toBe('at z.pdf')
  })

  it('leaves system paths, repo paths and URLs alone', () => {
    const text =
      'Run /usr/bin/env, edit src/main/Users/a.ts and docs/tmp/x.md, open https://x.dev/Users/ada/a.png or https://x.dev/?p=/Users/ada, and /etc/hosts.'
    expect(redactLocalPaths(text)).toBe(text)
  })

  it('is stable when applied again', () => {
    const once = redactLocalPaths(
      '![a](/Users/ada/a.png) [b](~/b.md) <file:///tmp/c.txt> /home/ada/d.log `C:\\Users\\ada\\e.csv`'
    )
    expect(once).toBe('a b c.txt d.log `e.csv`')
    expect(redactLocalPaths(once)).toBe(once)
  })

  it('knows where a root ends and covers WSL homes, separators and titles', () => {
    expect(redactLocalPaths('/mnt/c/Users/ada/Desktop/shot.png')).toBe('shot.png')
    expect(redactLocalPaths('in /mnt/c/Users/ada')).toBe('in ~')
    expect(redactLocalPaths('/tmp.d and /Usersfoo/a stay')).toBe('/tmp.d and /Usersfoo/a stay')
    expect(redactLocalPaths('see /Users/ada/r/')).toBe('see r')
    expect(redactLocalPaths('![a](/Users/ada/a.png "A")')).toBe('a')
    expect(redactLocalPaths('![](</Users/ada/My Shots/a.png>)')).toBe('a.png')
    expect(redactLocalPaths('[deck](/Users/ada/My Docs/deck.pdf)')).toBe('deck')
    expect(redactLocalPaths('in /tmp. Then /tmp.d')).toBe('in tmp. Then /tmp.d')
  })

  it.each([
    ['see file:///C:/Users/ada/report.pdf ok', 'see report.pdf ok'],
    ['[report](file:///C:/Users/ada/report.pdf)', 'report'],
    ['![](FILE:///c:/Users/ada/shots/a.png)', 'a.png'],
    ['<file:///C:/Users/ada/r.html|the report>', 'the report'],
    ['in file:///C:/Users/ada', 'in ~']
  ])('redacts Windows file URLs with a slash before the drive %#', (input, expected) => {
    expect(redactLocalPaths(input)).toBe(expected)
  })

  it('reads balanced brackets in labels without skipping a later local reference', () => {
    expect(redactLocalPaths('[Q1 [final]](https://example.com/r)[report](/tmp/report.html)')).toBe(
      '[Q1 [final]](https://example.com/r)report'
    )
    expect(redactLocalPaths('![Q1 [final]](https://x.dev/a.png) /tmp/b.md')).toBe(
      '![Q1 [final]](https://x.dev/a.png) b.md'
    )
    expect(redactLocalPaths('[Q1 [final]](/Users/ada/r.html)')).toBe('Q1 [final]')
    expect(redactLocalPaths('[[/Users/ada/a.md]](https://x.dev/r)')).toBe(
      '[[a.md]](https://x.dev/r)'
    )
    expect(redactLocalPaths('[a [b](/tmp/x.md)')).toBe('[a b')
  })

  it('reads balanced parentheses in local Markdown targets', () => {
    expect(redactLocalPaths('![](/Users/ada/chart(1).png)')).toBe('chart(1).png')
    expect(redactLocalPaths('[chart](/Users/ada/chart(1).png) and /tmp/b.md')).toBe(
      'chart and b.md'
    )
    expect(redactLocalPaths('![](/Users/ada/a (draft).png "A")')).toBe('a (draft).png')
    expect(redactLocalPaths('[x](/tmp/a.md) (see notes)')).toBe('x (see notes)')
    const kept = '[x](docs/chart(1).png) ![y](https://x.dev/c(1).png)'
    expect(redactLocalPaths(kept)).toBe(kept)
  })

  it.each([
    ['[x](docs/a.md (/Users/ada/b.md))', '[x](docs/a.md (b.md))'],
    ['![chart](chart.png (/Users/ada/chart.png))', '![chart](chart.png (chart.png))'],
    ['[x](<https://x.dev> (/Users/ada/a.md))', '[x](<https://x.dev> (a.md))'],
    ['[x](a.md (draft: /tmp/r.html))', '[x](a.md (draft: r.html))'],
    ['[x](#anchor (/Users/ada/a.md))', '[x](#anchor (a.md))'],
    ['[a]((/tmp/x))', '[a]((x))'],
    ['[x](docs/a.md "/Users/ada/b.md")', '[x](docs/a.md "b.md")'],
    ["![y](c.png '/tmp/r/c.png')", "![y](c.png 'c.png')"]
  ])('redacts local paths in the titles of kept destinations %#', (input, expected) => {
    expect(redactLocalPaths(input)).toBe(expected)
    expect(redactLocalPaths(expected)).toBe(expected)
  })

  it('cuts a bare path at a space, leaving a fragment without the user or root', () => {
    expect(redactLocalPaths('C:\\Users\\ada\\My Docs\\deck.pdf')).toBe('My Docs\\deck.pdf')
  })
})
