import React from 'react'

// Why: MantisBT has no vetted vector brand mark (unlike Jira/Linear/Warp,
// sourced from simple-icons) — this embeds the project's actual favicon
// (mantisbt.org/favicon.ico, a 16x16 pixel-art mascot) rather than inventing
// a lookalike glyph. Deliberately not a currentColor SVG like the other
// provider icons: the source has no clean vector silhouette to flatten.
const MANTISBT_FAVICON_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAADuUlEQVR4nGWQXUxbdQBHf/97b29py0eB0g7aDsquTFMYs3OCLhAcYJSpRNAZnZvLDJoscw/MmCVDjFlMEIZxjCVuBsmcbnNkBPwagqiwDmRuE2UENimlQLvCWvp1W27pbeuLWYyet/NyHg7BP/SaB9I6LV81r6xF1j+Tlt/ji46Vx2leQ8JJjh+X4mpjOnf9sz1Nb+M/kH/LiUsdL56abb9oF2N40+RFakocPp6gbyoFj62LRmK+HHNR9r4jeytrR/8XONvTeDBHevwjRirSnVYd1AZAIYkhSoBVN7BdsYwMmQ/fThmCmwvPVFVtLR2+H7j6++WS7HD1sEbFglHwmFlMwCeObCSkAm4fjRdkDpQXeMF7lKBEP1pGK8frarqKtenJYQoAJqcuvKTVxdDWvRtHT0rAbRSgj/K44VKADUSwvcCLS30U3mreAbnGADm5lv+HzZIJABQALKyqBJdXxML0pzh7UQKEgSfVK5idY1CmdIPIgZ7vWUyPdyHqsWBa2GR/UKt3AQADAMYNVSfbrpqrX981xj3/RBTwAUSIg/cThEMUsAQc3iUgxgKHhzJgeqi+MVej4j839z57f+L5wUF939TpjpDs18rQmgw3Qko4I1Ik0FFslQaQkRSBxS0Vnjbsb2iqrWudtFnz9lze+wN1pr9XDwAvl5cv7DQdrJKQNxq/C+hWnSwLIAZBQuMKSUO3PRElmpoTTbV1ravBMGn45dgpLsumozoXW4YPfflhff/oCL3j8W3iuX1HjrZvfK0iN0g88ESARR60MxJ/JN0PTuXMAoCPh88dcpCBMmMKzVMlGxyq29KO1taJtp/av7lQDAAHqneP7OSSZ/KShfhTiqLTx7fsr2JlmoBDvFPUbR4q+8LW8X5FbgQOq9pDKRh6zaSMI2f9tdLz7uahVzveae0evJKkkuv+TNNGSV15zbsHal7p00vyR6Z9dkPD6AddpmyXnI0At1yKCOUNEdgDLIJOOSoMXpZP765v+evY6PW5lVw6FoUz6OIAoFRT3POzhaZVeqfKqBTAuzmbj0n0M1Y7CygJlohUDI1rlh4unNX6lBPGkfkk48x8AkKpITUAmNYVDmiVMnFblocRBAKrPfMeT0IxiqRBYr8rQYAC8xsjZN68ZZpSinLxOc6PEmMAd4PWPADI03FztdncmJRaRsz3wB11orHfKs4/ynj8CruQLKpdyzQ80ii5vcba124WWrZsmizYrLyXlCFNXQKAdKU8Ojxurvt6QnhPFDh738pYMWGktr8Bh5uWBnMk2psAAAAASUVORK5CYII='

export function MantisBTIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <img
      src={MANTISBT_FAVICON_DATA_URI}
      alt=""
      aria-hidden
      className={className}
      style={{ imageRendering: 'pixelated' }}
    />
  )
}
